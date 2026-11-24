# Instagram DM capture pipeline

A tester shares a Reel or post to the connected Instagram professional account by DM, then (optionally) types why. Neophi turns that into a normal memory in the tester's own library: caption, the exact note, the video when Meta actually provides it, and a guarded Gemini reading. Search, Today, export and delete work as they do for any other memory.

```
Meta POST /webhooks/instagram ──verify HMAC (raw body)──▶ filter ──▶ Firestore: instagramEvents + instagramJobs ──▶ 200
                                                                         │ (durable, idempotent per recipient+message ID)
Cloud Scheduler / VM poller ──▶ POST /internal/instagram/worker/run ──▶ lease jobs ──▶ share: reserve memory, fetch media,
                                                                                         store in GCS, queue analysis
                                                                                     note: attach to latest share ≤ 10 min
                                                                                     analysis: Vertex (gs:// fileData) → guard → memory
```

Nothing slow runs after the webhook answers: the 200 is sent only after the event and its job are written, and all media and AI work is done by the worker under a lease with bounded retry. This is safe on Cloud Run (CPU is throttled after a response) and on a VM.

## What the code does

| Area | File |
| --- | --- |
| Webhook: GET challenge, POST `X-Hub-Signature-256` over the untouched raw body (constant time, hex format, 1 MB cap), recipient/echo/stale filtering, sender to UID mapping, durable intake | `server/instagram/webhook.ts`, `server/instagram/parse.ts` |
| Event/job records, leasing, note and analysis state rules (shared by both stores) | `server/instagram/model.ts` |
| Store methods (Firestore transactions and in-memory) | `server/store.ts` |
| Worker: one memory per share, exact notes, media, analysis with generation guard | `server/instagram/worker.ts` |
| Authorized media fetch (HTTPS, allow-listed hosts, re-checked redirects, size/time caps, MIME vs file signature) and optional Graph attachment read | `server/instagram/media.ts` |
| Private worker trigger and status counts (OIDC or shared secret) | `server/instagram/internal.ts` |
| Mounting (webhook before `express.json`), optional poller | `server/index.ts` |

Rules the tests enforce: unknown senders are dropped and nothing is stored; ownership never comes from the payload; notes are kept byte for byte and keyed by delivery ID; a deleted memory is tombstoned so retries or late notes cannot bring it back; private memories never reach Gemini, categories or embeddings; `full_media` and frame/timestamp evidence only when the model actually received the stored video; an HTML, expired or failed attachment falls back to caption plus note (`link_metadata`, or `unsupported` when nothing readable arrived). Attachment URLs, captions and note text are cleared from the restricted event once processed, and never appear in logs, health, API responses or export.

## Environment variables (names only)

Secrets come from Secret Manager. Never put a value in this repo, an image, a build log or a shell history.

| Name | Secret? | Service | Purpose |
| --- | --- | --- | --- |
| `META_APP_SECRET` | yes | public | Parent app (NeoPhi) secret. Validates POST signatures. The test app's secret will not work. |
| `META_VERIFY_TOKEN` | yes | public | Random value you also type into the Meta callback form. Answers the GET challenge only. |
| `META_IG_RECIPIENT_ID` | no | public | Numeric ID of the connected professional account. Deliveries to any other recipient are ignored. |
| `INSTAGRAM_SENDER_UID_MAP` | no | public | Pre-approved testers: `IGSID=FirebaseUID,IGSID2=FirebaseUID2`. Anyone else is denied. |
| `INSTAGRAM_LOG_DENIED_SENDERS` | no | public | `1` logs only the Instagram-scoped ID of a denied sender, for pairing. Leave `0` otherwise. |
| `INSTAGRAM_ACCESS_TOKEN` | yes | worker | Optional. Connected account token, only if the documented Graph message attachment read needs it. Sent as a header, never in a URL. |
| `META_GRAPH_HOST`, `META_GRAPH_VERSION` | no | worker | Graph host for the selected login flow (default `graph.instagram.com`) and version (default `v27.0`). |
| `INSTAGRAM_MEDIA_HOSTS` | no | worker | Optional override of the media host allow-list (default `lookaside.fbsbx.com,fbcdn.net,cdninstagram.com`; subdomains allowed). |
| `INSTAGRAM_MAX_MEDIA_BYTES`, `INSTAGRAM_MEDIA_TIMEOUT_MS` | no | worker | Download caps (defaults 15 MB, 25 s). |
| `INSTAGRAM_JOB_MAX_ATTEMPTS` | no | worker | Retry bound for share/note jobs (default 5; analysis jobs use 4). |
| `INSTAGRAM_MAX_EVENT_AGE_HOURS` | no | public | Older deliveries are ignored as stale (default 48). |
| `INSTAGRAM_WORKER_OIDC_AUDIENCE` | no | worker | Exact `aud` of the OIDC token Cloud Scheduler/Tasks sends. Use the worker's Cloud Run service URL (no path), e.g. `https://WORKER_URL`: that is the audience Cloud Run's own invoker check accepts by default. If you want a different value, add it as a Cloud Run custom audience on the worker and use the same string here and in the Scheduler job. |
| `INSTAGRAM_WORKER_SERVICE_ACCOUNT` | no | worker | Email of the scheduler/tasks identity allowed to call the worker. |
| `INSTAGRAM_WORKER_SECRET` | yes | VM only | Alternative bearer secret for a VM cron. Not needed with OIDC. |
| `INSTAGRAM_WORKER_POLL_MS` | no | VM / always-on | In-process poller interval (e.g. `5000`). `0` (default) disables it. |

The worker endpoint is mounted only when `INSTAGRAM_WORKER_OIDC_AUDIENCE` + `INSTAGRAM_WORKER_SERVICE_ACCOUNT`, or `INSTAGRAM_WORKER_SECRET`, is set. Existing variables are unchanged: `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `CLOUD_RUN_REGION`, `MEDIA_BUCKET`, `ANALYSIS_MODEL`, `EMBEDDING_MODEL`, `PORT`, and the four `VITE_FIREBASE_*` build arguments.

## Google Cloud setup

> **STOP (Ramit): resource creation and deploy.** Nothing below has been run. Pick the billed project and region, review, then run it yourself.

```bash
PROJECT=YOUR_PROJECT_ID; REGION=YOUR_REGION; BUCKET=YOUR_PRIVATE_MEDIA_BUCKET
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')

gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  firestore.googleapis.com storage.googleapis.com secretmanager.googleapis.com identitytoolkit.googleapis.com \
  aiplatform.googleapis.com cloudscheduler.googleapis.com --project "$PROJECT"
```

**Firestore** (Native mode). Two server-only collections are added: `instagramEvents` and `instagramJobs` (rules already deny all client access). Create the two composite indexes and the TTL policies (records expire 7 days after receipt; restricted payloads are cleared as soon as they are processed):

```bash
gcloud firestore indexes composite create --project "$PROJECT" --collection-group=instagramJobs --query-scope=COLLECTION \
  --field-config=field-path=status,order=ascending --field-config=field-path=nextRunAt,order=ascending
gcloud firestore indexes composite create --project "$PROJECT" --collection-group=instagramEvents --query-scope=COLLECTION \
  --field-config=field-path=kind,order=ascending --field-config=field-path=recipientId,order=ascending \
  --field-config=field-path=senderId,order=ascending --field-config=field-path=timestampMs,order=descending
gcloud firestore fields ttls update expireAt --collection-group=instagramEvents --enable-ttl --project "$PROJECT"
gcloud firestore fields ttls update expireAt --collection-group=instagramJobs --enable-ttl --project "$PROJECT"
```

The same definitions are in `firestore.indexes.json`. The existing vector index on `memories.embedding` (768 dimensions, COSINE) is still needed for semantic search if it is not there yet.

**Bucket.** Private, uniform bucket-level access, public access prevention. DM media lives under `users/{uid}/media/{memoryId}.mp4` like uploads and is deleted with the memory or with "delete me". Do not add an age-based lifecycle rule on `users/` (it would delete saved media). Decide on soft delete: the default keeps deleted objects recoverable for 7 days; set `--soft-delete-duration=0` if deletion must be immediate.

```bash
gcloud storage buckets create "gs://$BUCKET" --project "$PROJECT" --location "$REGION" --uniform-bucket-level-access --public-access-prevention
```

**Identities and roles.** Create `neophi-web`, `neophi-worker` and `neophi-scheduler` with `gcloud iam service-accounts create NAME --project "$PROJECT"`. Whoever creates the Scheduler job needs `roles/iam.serviceAccountUser` on `neophi-scheduler`.

| Service account | Roles |
| --- | --- |
| `neophi-web` (public service: site, `/api`, webhook) | `roles/datastore.user` (project); `roles/storage.objectUser` on the bucket; `roles/aiplatform.user` (upload analysis); `roles/secretmanager.secretAccessor` on the `META_APP_SECRET` and `META_VERIFY_TOKEN` secrets only; `roles/iam.serviceAccountTokenCreator` on itself (signed media URLs) |
| `neophi-worker` (private worker service) | `roles/datastore.user`; `roles/storage.objectUser` on the bucket; `roles/aiplatform.user`; `secretAccessor` on `INSTAGRAM_ACCESS_TOKEN` only if used |
| `neophi-scheduler` (caller identity) | `roles/run.invoker` on the worker service only |

If Vertex reports permission denied for the `gs://` file, also grant `roles/storage.objectViewer` on the bucket to the Vertex AI service agent `service-$PROJECT_NUMBER@gcp-sa-aiplatform.iam.gserviceaccount.com`, and recheck with the smoke test below.

**Secrets** (the owner enters the values in the Secret Manager console, not on a command line): `neophi-meta-app-secret`, `neophi-meta-verify-token`, and optionally `neophi-instagram-access-token`.

**Deploy (Cloud Run).** One image, two services. Build with the four `VITE_FIREBASE_*` values as build arguments (see `Dockerfile`).

```bash
IMAGE=$REGION-docker.pkg.dev/$PROJECT/YOUR_REPO/neophi:GIT_SHA
# Public service: receives Meta callbacks; app APIs still require Firebase Auth. No worker route is mounted here.
gcloud run deploy neophi --project "$PROJECT" --region "$REGION" --image "$IMAGE" \
  --service-account neophi-web@$PROJECT.iam.gserviceaccount.com --allow-unauthenticated \
  --env-vars-file public-env.yaml \
  --set-secrets META_APP_SECRET=neophi-meta-app-secret:VERSION,META_VERIFY_TOKEN=neophi-meta-verify-token:VERSION
# Private worker: not publicly invocable; the app also checks the OIDC caller.
gcloud run deploy neophi-worker --project "$PROJECT" --region "$REGION" --image "$IMAGE" \
  --service-account neophi-worker@$PROJECT.iam.gserviceaccount.com --no-allow-unauthenticated --timeout 900 \
  --env-vars-file worker-env.yaml   # add --set-secrets INSTAGRAM_ACCESS_TOKEN=... only if needed
gcloud run services add-iam-policy-binding neophi-worker --project "$PROJECT" --region "$REGION" \
  --member serviceAccount:neophi-scheduler@$PROJECT.iam.gserviceaccount.com --role roles/run.invoker
WORKER_URL=$(gcloud run services describe neophi-worker --project "$PROJECT" --region "$REGION" --format='value(status.url)')
gcloud scheduler jobs create http neophi-instagram-worker --project "$PROJECT" --location "$REGION" \
  --schedule='* * * * *' --http-method=POST --uri="$WORKER_URL/internal/instagram/worker/run" \
  --oidc-service-account-email=neophi-scheduler@$PROJECT.iam.gserviceaccount.com \
  --oidc-token-audience="$WORKER_URL" --attempt-deadline=300s
```

`public-env.yaml`: `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `MEDIA_BUCKET`, `ANALYSIS_MODEL`, `EMBEDDING_MODEL`, `META_IG_RECIPIENT_ID`, `INSTAGRAM_SENDER_UID_MAP`.
`worker-env.yaml`: `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `MEDIA_BUCKET`, `ANALYSIS_MODEL`, `EMBEDDING_MODEL`, `INSTAGRAM_WORKER_OIDC_AUDIENCE=$WORKER_URL`, `INSTAGRAM_WORKER_SERVICE_ACCOUNT=neophi-scheduler@$PROJECT.iam.gserviceaccount.com`.

Check: `curl -X POST $WORKER_URL/internal/instagram/worker/run` without a token returns 403 from Cloud Run, and the public service returns 404 for `/internal/...`.

**Compute Engine VM instead.** Run one process with the VM's attached service account (same roles as `neophi-web` plus `neophi-worker`), HTTPS in front (Meta needs HTTPS; the proxy must pass the body through unchanged), all variables above, and `INSTAGRAM_WORKER_POLL_MS=5000`. Jobs are durable and leased, so restarts are safe. Optionally also trigger `POST /internal/instagram/worker/run` from cron with `Authorization: Bearer $INSTAGRAM_WORKER_SECRET`.

**Pairing a tester.** Get the tester's Firebase UID from Firebase Console → Authentication → Users (with anonymous sign-in it is tied to that browser). Get the tester's Instagram-scoped ID by setting `INSTAGRAM_LOG_DENIED_SENDERS=1` on the public service, sending one DM, and reading the `instagram_sender_not_paired` log line (ID only). Set `INSTAGRAM_SENDER_UID_MAP=IGSID=UID`, then set the flag back to `0`.

## Meta callback

- Callback URL: `https://<public Cloud Run URL or custom domain>/webhooks/instagram`
- Verify token: the same random value as the `META_VERIFY_TOKEN` secret.
- Field: `messages` on the NeoPhi parent app (1481320687243886), Instagram use case.

> **STOP (Meta owner): callback cutover.** Only after staging steps 1 to 3 below pass. Record the old callback and its verify token privately for rollback; confirm `messages` is still subscribed after saving. Roll back by restoring the old callback and confirming a delivery.

## Staging acceptance (record redacted results)

1. **Synthetic Vertex video with the deployed identity.** Upload `tests/fixtures/neophi-sample.mp4` to `gs://$BUCKET/smoke/neophi-sample.mp4`, then run a short-lived Cloud Run Job from the same image and the `neophi-worker` service account:
   `gcloud run jobs create neophi-vertex-smoke --image "$IMAGE" --service-account neophi-worker@$PROJECT.iam.gserviceaccount.com --env-vars-file worker-env.yaml --command node --args tools/vertex-video-smoke.mjs,gs://$BUCKET/smoke/neophi-sample.mp4` and `gcloud run jobs execute neophi-vertex-smoke --wait`.
   Expect two lines, `mode: inline` and `mode: gcs_file_uri`, each with `replied: true`, `mime: video/mp4` and `bytes: 251535`. On 403 check the principal, API enablement, billing, model region and bucket permissions separately; on 404 check model and location. Delete the job and the smoke object afterwards.
2. **Health and auth boundaries.** `GET /api/health` shows `instagram.webhookConfigured: true` and no secrets; `/api/memories` without a Firebase token is 401; the worker is not callable without its identity.
3. **Synthetic signed delivery.** Using a signed synthetic body (as in `tests/helpers/instagram.ts`), confirm the GET challenge echoes, a bad signature is 401, and a good one is 200 with one new `instagramEvents` document. Read counts from `GET $WORKER_URL/internal/instagram/status` (with an identity token for `neophi-scheduler`).
4. **Meta dashboard sample** (after the cutover gate): one more webhook count, zero `instagram_webhook_rejected` signature lines. The sample's recipient is not the configured account, so it is counted as ignored and stores nothing.
5. **One owner-approved Reel, then a separate note.** The tester shares a tester-owned Reel and then types a reason in a second message. Record, without the note text or any URL:
   - webhook status codes and the `instagram_webhook` counts (stored, duplicates, ignored, denied);
   - from `instagram_share_processed`: `media` outcome, `mime`, `bytes`, `via` (attachment, graph or graph_no_media);
   - event and job counts from the status endpoint (shares, notes, queued, leased, done, dead);
   - whether the model got video: the memory's `dm.analysisBasis` is `media` (and `ingest` is `full_media`), otherwise `caption`;
   - note equality: compare the note in the Instagram app with `note` returned by `GET /api/memories/:id` byte for byte (the tester does this on their own device).
   If the attachment is HTML (`media: html`), the expected result is the caption plus exact note, which is still a valid outcome. A successful synthetic test and a real caption-only fallback are recorded separately.

## Tests

`npm run e2e:local` runs the whole tester journey over real HTTP with no credentials: signed share + exact note, durable intake, worker, stored video, fake model, memory in the tester's own library (and a second run where Meta returns only an HTML page, which must fall back to caption plus exact note). It prints redacted results only.

`npm test` runs the pipeline on fixtures and mocks only (no network to Meta or Google). `tests/firestore-store.emulator.test.ts` runs the same flow against the real `FirestoreStore` on a local emulator and is skipped unless `FIRESTORE_EMULATOR_HOST` is set:

```bash
gcloud emulators firestore start --host-port=127.0.0.1:8085 &
FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 npx vitest run tests/firestore-store.emulator.test.ts
```

Not proven locally: real Meta attachment behaviour for the tester's Reel, the exact Graph field shape for the selected login flow, Vertex access from the deployed identity to the private bucket, and Firestore index/TTL creation in the real project. Those are the staging steps above.
