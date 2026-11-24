# Staging results (filled in after staging, then handed back to the Meta owner)

Copy this file to `docs/STAGING_RESULTS.md` on a branch, fill every line, and open a PR to `main` (or send the filled text to Oliver). Oliver reads it, re-verifies the facts below itself, then does the Meta side.
**Never write a secret value, token, Firebase UID, Instagram user ID of a person, message text or media URL in this file.** Names, counts, statuses and public service URLs only. `17841449458840084` is the account's public ID and may be written.

## A. What the Meta owner needs to act (required)

| Item | Value |
| --- | --- |
| Image/commit deployed (git SHA) | |
| Public service URL (`neophi`) | https:// |
| Worker service URL (`neophi-worker`, private) | https:// |
| Region | |
| `ANALYSIS_MODEL` / `EMBEDDING_MODEL` chosen | |
| `META_VERIFY_TOKEN` entered in Secret Manager, version | `yes / version N` (the value goes to Oliver privately, NOT here) |
| `META_APP_SECRET` entered in Secret Manager, version | `yes / version N` (must be NeoPhi's 32-hex secret, not the test app's) |
| `META_IG_RECIPIENT_ID` set to `17841449458840084` | yes / no |
| Tester paired (`INSTAGRAM_SENDER_UID_MAP` set for the tester) | yes / no |
| `INSTAGRAM_LOG_DENIED_SENDERS` is back to `0` | yes / no |
| Public `/privacy` and `/data-deletion` pages served at the new host | yes / no |
| Auto-replies off | yes |

## B. Gate results (one line each: PASS / FAIL / NOT RUN, with counts)

| Gate | Result | Counts / notes (redacted) |
| --- | --- | --- |
| Local: typecheck, lint, test, build, `npm run e2e:local` | | tests passed/skipped: |
| Firestore emulator tests | | passed/total: |
| Cloud Run public reachable; `/internal` is 404 on public | | |
| Worker denied without identity (401/403) | | |
| Vertex smoke, inline | | `replied`, `mime`, `bytes` |
| Vertex smoke, `gs://` object with the worker identity | | `replied`, `mime`, `bytes` |
| `node tools/staging-acceptance.mjs ...` | | `N/N checks passed` |
| Scheduler runs the worker (OIDC audience = service URL) | | last run status, jobs drained |
| Indexes and TTL created | | |

## C. What is still blocked or unverified

List anything that failed, was skipped, or you could not check, and why.

## D. What happens next on the Meta side, once this is received

1. **Verify, do not trust**: fetch the PR, read the diff, run `npm ci`, typecheck, lint, test, build and `npm run e2e:local` locally; run `tools/staging-acceptance.mjs` against the public and worker URLs above (needs the secrets in the environment of that one process, entered by Oliver; no values printed).
2. **Meta side, with Oliver's approval at each change**: record the old callback privately for rollback; switch NeoPhi's webhook callback to `https://<public URL>/webhooks/instagram` using the verify token (value entered by Oliver); confirm the GET challenge passes and `messages` is still subscribed at v27.0; update the app's privacy-policy and data-deletion URLs to the new host; send one dashboard Test sample and check the counts (one more webhook, zero rejected signatures, nothing stored).
3. **Live test**: Oliver sends one tester-owned Reel and a separate reason; read the counts-only status and log lines and record the `media` outcome, `mime`, `bytes`, `via`, `dm.analysisBasis`, `ingest`, and note equality.
4. **Media gap**: test the Meta attachment first; only with Oliver's approval try the Graph lookup with `INSTAGRAM_ACCESS_TOKEN` (Oliver generates and enters it); keep the caption-plus-note fallback if Meta gives only HTML; test video-backed analysis separately via direct upload with a tester-owned MP4.
5. **Rollback** if anything is off: restore the old callback (`https://20-219-13-184.sslip.io/webhooks/instagram`, still running) and confirm a delivery.
6. Report each gate separately back to Oliver.
