# Handover: finish the Instagram DM pipeline

Read this first, then `docs/INSTAGRAM_PIPELINE.md` (the runbook), `.env.example`, `Dockerfile`, `firestore.indexes.json`, `server/instagram/`, `server/store.ts`, `tools/vertex-video-smoke.mjs`, `tools/local-e2e.ts`, `tools/staging-acceptance.mjs`.
Written 21 Nov 2026 after reviewing `main` @ `93f471d` and driving the Meta side. Everything here was checked by running it, except what is marked **NOT DONE**.

## 1. Goal and who owns what

A tester shares a Reel to the Instagram professional account `@yuck.pov` (Instagram ID `17841449458840084`), then types why in a second message. Neophi must create a memory in that tester's own library: caption/title, the exact note (byte for byte, separate from caption and AI), the video only if Meta really provides it, and a guarded Gemini reading.

| Owner | Does | Never delegate |
| --- | --- | --- |
| Ramit | Google Cloud: billed project, APIs, Firestore, bucket, service accounts, Secret Manager entries, deploy, Scheduler, Vertex model choice | creating cloud resources or deploying without his explicit approval |
| Oliver | Meta app NeoPhi, tester accounts, callback cutover, real DM test, entering secrets | secret values never go through chat, files, logs or shell history |
| The agent doing this work (you) | verify, review, fix reproducible bugs on a branch, run acceptance, report each gate separately | pushing to `main`; changing Meta or GCP without the owner's go-ahead |

## 2. State of play (what is true today)

| Gate | Status |
| --- | --- |
| `npm ci`, typecheck, lint, build on `main` | pass |
| `npm test` | 67 passed, 3 skipped (the Firestore emulator tests) |
| Firestore emulator tests | **NOT DONE**: need Java; run them per the runbook |
| `npm run e2e:local` (real HTTP, in-memory, fake model) | pass, both scenarios (video available; HTML only) |
| Code review of webhook, worker, media, internal | no logic bug found; one runbook error fixed (see 5) |
| Real Meta delivery to the old VM | proven: signed Meta test sample and two real Reel shares arrived, signatures valid |
| Cloud Run staging, Vertex smoke, scheduler, callback cutover, live DM on Cloud Run | **NOT DONE** (need Ramit) |
| Real video bytes from a Reel share | **not available from Meta** (see 4); not a bug |

## 3. Architecture in one picture

```
Meta POST /webhooks/instagram --verify HMAC over RAW body--> filter (recipient, echo, stale, paired sender)
   --> Firestore instagramEvents + instagramJobs (durable, idempotent per recipient+message ID) --> 200
Cloud Scheduler (OIDC) --> POST /internal/instagram/worker/run (PRIVATE service) --> lease jobs
   share:   reserve memory, fetch media from the Meta attachment URL (allow-listed hosts), store in GCS, queue analysis
   note:    attach to the latest share within 10 min (exact text, keyed by delivery ID)
   analyze: Vertex (gs:// fileData) -> guard -> memory
```

Two Cloud Run services from ONE image: public `neophi` (site, `/api`, webhook; no `/internal`) and private `neophi-worker`. Nothing slow runs after the 200 (Cloud Run throttles CPU after a response), so the work is leased jobs with bounded retry.

## 4. Facts about Meta (verified in the dashboard and by live deliveries)

- Parent app: **NeoPhi, ID `1481320687243886`**, In development, compliant, flow = **Unified Login** (Facebook Login for Business; Meta says Instagram-login setup is not available for newer apps). Business portfolio owns it.
- There is also a test app **`Yucks - Test1` (`1496363935712367`)** with its **own secret. Do not use that secret for NeoPhi's callback**: signatures would fail with 401.
- The POST signature secret is NeoPhi's **App secret: 32 hex characters**. A long (about 255 characters) value is an access token, not the secret. The owner reveals it in App settings > Basic > App secret > Show (Meta asks for his password). No tool can read it.
- Webhook (NeoPhi, Instagram use case > Webhooks): callback is still the **old VM** `https://20-219-13-184.sslip.io/webhooks/instagram`; enabled; fields subscribed at v27.0: `messages`, `mentions`, `message_edit`, `message_reactions`, `messaging_handover`, `messaging_postbacks`. Only `messages` is needed.
- Instagram account `yuck.pov` is connected: webhook subscription On, role Instagram Tester, no access token generated.
- Privacy policy and data-deletion URLs in Basic settings still point to the old VM (`/privacy`, `/data-deletion`). When the VM goes away they must move to Ramit's host (the app already needs to serve those pages). Contact email is unverified.
- `instagram_business_manage_messages` has no standard/advanced access (Meta: requires business verification). Tester DMs are delivered anyway in development mode; this matters only for going public.
- **What Meta sends for a shared Reel** (real, two samples): attachment type `ig_reel`, payload keys `reel_video_id`, `title`, `url`; the URL host is `www.instagram.com`; fetching it returns `text/html`. So **no video bytes**. Expected result: `media: html`, `ingest: link_metadata`, memory from title/caption plus the exact note. That is a valid outcome. Do not scrape or bypass Meta access. For video-backed Gemini use a tester-owned MP4 through the direct-upload flow.
- A note typed after the share arrives as a separate text-only delivery; the pipeline attaches it to the preceding share (10 min window, 15 s settle).
- Dashboard "Test" samples use fake IDs and a different recipient: they are verified and then counted as ignored, storing nothing. That is correct.

### Meta developer-tools MCP server (optional, makes Meta work scriptable)

Server `meta_social_technologies` at `https://mcp.facebook.com/devtools` (add it as an HTTP MCP server in your client and sign in with the Meta account). Useful tools: `devtools_app_list`, `devtools_webhook_list` (callback is shown truncated to its origin), `devtools_webhook_manage` (subscribe/unsubscribe/update_fields; asks for a `confirm_token` and the owner's approval; needs `callback_url` and `verify_token`), `devtools_webhook_test` (sends a test payload), `devtools_app` (settings), `devtools_app_review`. It cannot reveal the app secret or turn on standard access.

## 5. The one fix already made (the PR)

The runbook set the Scheduler OIDC audience, and `INSTAGRAM_WORKER_OIDC_AUDIENCE`, to the full `.../internal/instagram/worker/run` path. Cloud Run checks the token before the app runs and by default accepts the **service URL** as audience, so the path form is rejected with 403. Use `$WORKER_URL` (no path) for both the Scheduler `--oidc-token-audience` and `INSTAGRAM_WORKER_OIDC_AUDIENCE`; the request target still includes the path. `--attempt-deadline=300s` is set so Scheduler does not cut a drain short. `deploy/public-env.example.yaml` and `deploy/worker-env.example.yaml` encode this.

## 6. Hard rules

1. No secret, token, key or Firebase UID value in chat, source, `.env`, image, logs or shell history. Names only. Secrets live in Secret Manager; the owner enters them in the console.
2. No GCP resource creation, deploy, Meta callback change, app publication or App Review change without the owner's explicit approval after you show: exact project, service names, proposed action, rollback.
3. Work on a branch and open a PR to Ramit's repo. Never push to `main`. Do not restart the port or replace his UI.
4. Keep every exact note separate from captions and AI. A private or deleted memory must never reach inference, categories or embeddings.
5. Leave auto-replies off. No unrelated Meta permissions.
6. Local development uses `NEOPHI_LOCAL_STORE=memory` or the emulator, never production credentials or data.
7. Report each gate separately with actual counts. Share counts and status only, never message text, URLs or IDs of people.

## 7. Plan: gates, commands, expected results

**Gate 0. Verify the checkout.** `git fetch`, confirm the branch you build on; `npm ci && npm run typecheck && npm run lint && npm test && npm run build` (expect 67 passed, 3 skipped) and `npm run e2e:local` (expect both scenarios: A `full_media`, `analysisBasis=media`; B `link_metadata`, `analysisBasis=caption`; note exact in both).

**Gate 1. Emulator tests.** Install Java, then per the runbook: `gcloud emulators firestore start --host-port=127.0.0.1:8085` and `FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 npx vitest run tests/firestore-store.emulator.test.ts` (3 tests). Review worker retry, multi-UID isolation, deletion, duplicates and late notes; fix reproducible regressions only.

**Gate 2. Cloud staging (Ramit approves each step).** Follow the runbook's Google Cloud section with `deploy/*.example.yaml` copied to `public-env.yaml` / `worker-env.yaml`. Choose `ANALYSIS_MODEL` (video-capable, available in the project and location) and a compatible `EMBEDDING_MODEL`. Use service-account ADC; no API key. Enter `META_APP_SECRET` (NeoPhi's, 32 hex) and a freshly generated `META_VERIFY_TOKEN` in Secret Manager yourselves or have Oliver do it; bind them to `neophi` only. Set `META_IG_RECIPIENT_ID=17841449458840084`.

**Gate 3. Vertex smoke before touching Meta.** Upload `tests/fixtures/neophi-sample.mp4`, run the temporary Cloud Run Job (runbook step 1). Expect two lines: `mode: inline` and `mode: gcs_file_uri`, each `replied: true`, `mime: video/mp4`, `bytes: 251535`. 403: check the runtime principal, billing/API enablement, `aiplatform.endpoints.predict`, bucket access (and the Vertex service agent `objectViewer`) one by one. 404: exact model ID and location. Delete the job and the smoke object afterwards.

**Gate 4. Acceptance script against staging (no Meta involved).**
```
META_APP_SECRET=$(gcloud secrets versions access latest --secret=neophi-meta-app-secret) \
META_VERIFY_TOKEN=$(gcloud secrets versions access latest --secret=neophi-meta-verify-token) \
META_IG_RECIPIENT_ID=17841449458840084 \
node tools/staging-acceptance.mjs --public https://PUBLIC_URL --worker https://WORKER_URL
```
Expect all PASS: health shows `instagram.webhookConfigured: true` with no secret, `/api/memories` 401, `/internal` 404 on the public service, GET challenge echoed and wrong token 403, no-signature and bad-signature POST 401, signed POST to another recipient 200 (ignored), worker 401/403 without identity. Optional `--store-synthetic` with `TEST_SENDER_ID` writes one throwaway event. Set `WORKER_ID_TOKEN` (identity token for the worker audience) to also read the counts-only status endpoint.

**Gate 5. Pair the tester.** `INSTAGRAM_SENDER_UID_MAP=IGSID=FirebaseUID` on the public service. Get the tester's Firebase UID from Console > Authentication (anonymous auth is per browser, so it must be the actual tester browser). Get the IGSID with `INSTAGRAM_LOG_DENIED_SENDERS=1` for exactly one DM (`instagram_sender_not_paired` log line), then set it back to `0`.

**Gate 6. Meta callback cutover (Oliver approves).** Save the old callback privately for rollback. Switch NeoPhi's webhook to `https://<public URL>/webhooks/instagram` with the same verify token as the secret (Meta dashboard: Instagram use case > Webhooks > Verify and save; or `devtools_webhook_manage subscribe` with the owner's confirmation). The new service must answer the GET challenge verbatim. Confirm `messages` is still subscribed at v27.0. Update the Basic-settings privacy and data-deletion URLs to the new host. Then send one dashboard **Test** sample: expect one more webhook count, zero `instagram_webhook_rejected` lines, stored nothing. Rollback: restore the old callback and confirm a delivery.

**Gate 7. Live paired DM.** The tester sends one tester-owned Reel, then a separate reason. Record without note text or URLs: webhook status codes and `instagram_webhook` counts (stored, duplicates, ignored, denied); `instagram_share_processed` (`media` outcome, `mime`, `bytes`, `via`); counts from `/internal/instagram/status` (shares, notes, queued, leased, done, dead); the memory's `dm.analysisBasis` (`media` or `caption`) and `ingest`; and note equality byte for byte between the Instagram app and `GET /api/memories/:id` `note` (the tester checks on their device). Expected today: `media: html`, caption plus exact note.

**Gate 8. Diagnose the live media gap.** Test the Meta attachment first. Only if Oliver approves, try the documented Graph lookup with `INSTAGRAM_ACCESS_TOKEN` for the connected account (generated in the dashboard, entered by Oliver as a secret). Unified Login probably needs `META_GRAPH_HOST=graph.facebook.com`; confirm. Record response MIME, bytes, route. If an authorized MP4 appears, confirm it is stored under the right UID and Vertex consumed that memory's `gs://` video (`dm.analysisBasis=media`). If Meta only gives HTML/metadata, keep the caption-plus-note fallback and leave the live-video gate open. Separately test video-backed analysis with a tester-owned MP4 through the direct-upload flow.

**Gate 9.** After functional acceptance, ask Ramit the four optional UX questions in `ui-review/REVIEW_AFTER_PORT.md` from Oliver's handoff ZIP (if provided).

## 8. Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Meta POST gets 401 | wrong secret: the test app's, a token instead of the 32-hex secret, or an old Secret Manager version |
| Callback "Verify and save" fails | verify token differs from `META_VERIFY_TOKEN`, or the service is not publicly reachable |
| No POST at all | recipient/subscription: `messages` not subscribed, account not subscribed, sender account has no tester role, or the app is not what holds that callback |
| 200 but nothing stored | recipient is not `META_IG_RECIPIENT_ID`, sender not in `INSTAGRAM_SENDER_UID_MAP` (`denied` count), or event older than 48 h |
| Scheduler 403 from Cloud Run | audience has a path, or the scheduler account lacks `roles/run.invoker` on the worker |
| Worker 403 from the app | `INSTAGRAM_WORKER_OIDC_AUDIENCE` or `..._SERVICE_ACCOUNT` does not match the token |
| Vertex 403 | runtime principal, billing/API, `aiplatform.endpoints.predict`, bucket read for the Vertex service agent |
| Vertex 404 | wrong model ID or location |
| Memory has no video | expected for Reel shares (HTML); see section 4 |

## 10. When you finish: hand back to the Meta owner

The Meta owner (Oliver) and his tooling own the Meta side and the real DM test, and will not act until you hand back. When your gates are done (or blocked), copy `docs/STAGING_RESULTS_TEMPLATE.md` to `docs/STAGING_RESULTS.md` on a branch, fill it in, and open a PR to `main` (or send the filled text to Oliver). It needs the public and worker URLs, the git SHA, the models chosen, which secrets are in Secret Manager (names and versions only), pairing status, and each gate's result with counts. Oliver re-verifies it himself and then runs the Meta steps listed in section D of the template, asking Oliver before every Meta change. Secret values (the app secret, the verify token) go from Ramit to Oliver privately, never into the PR, chat or logs.

## 9. Evidence from the legacy path (for context only)

Old stack: Azure VM with Docker + Caddy and a token-protected `/relay`, plus a laptop poller; it proved Meta delivery and the shapes in section 4. It is only the rollback target for the callback. No change to it is needed for Cloud Run.
