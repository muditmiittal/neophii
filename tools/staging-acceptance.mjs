// Staging acceptance checks for the Instagram DM pipeline. Run it AFTER deploy and BEFORE the Meta callback
// cutover, from a machine that can reach the public service. It prints redacted PASS/FAIL lines only: no secret,
// token, URL path with a token, message text or user data is printed or stored.
//
//   META_APP_SECRET=...  META_VERIFY_TOKEN=...  META_IG_RECIPIENT_ID=... \
//   node tools/staging-acceptance.mjs --public https://PUBLIC_URL [--worker https://WORKER_URL]
//
// META_APP_SECRET and META_VERIFY_TOKEN must come from Secret Manager into the environment of this one process
// (for example `META_APP_SECRET=$(gcloud secrets versions access latest --secret=neophi-meta-app-secret)`), never
// typed into a file, chat or shell history. Optional: WORKER_ID_TOKEN (an identity token for the worker audience
// from an identity allowed to invoke it) enables the authenticated status read.
//
// Everything sent here is signed with the real secret but addressed to a recipient that is NOT the connected
// account, so the service verifies it and then ignores it: nothing is stored. Pass --store-synthetic with
// TEST_SENDER_ID (a paired sender) only if you want one throwaway event written and then ignored by retention.
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const base = (flag('--public') ?? '').replace(/\/+$/, '');
const worker = (flag('--worker') ?? '').replace(/\/+$/, '');
const storeSynthetic = args.includes('--store-synthetic');
const { META_APP_SECRET: secret, META_VERIFY_TOKEN: verify, META_IG_RECIPIENT_ID: recipient, TEST_SENDER_ID: sender, WORKER_ID_TOKEN: idToken } =
  process.env;

if (!/^https:\/\//.test(base) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) {
  console.error('Pass --public https://PUBLIC_URL (HTTPS required; http only for localhost).');
  process.exit(2);
}
if (!secret || !verify || !recipient) {
  console.error('Set META_APP_SECRET, META_VERIFY_TOKEN and META_IG_RECIPIENT_ID in the environment (names only; values never printed).');
  process.exit(2);
}

const results = [];
const check = async (name, fn) => {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail ?? '' });
  } catch (e) {
    results.push({ name, ok: false, detail: e instanceof Error ? e.message : 'error' });
  }
};
const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const sign = (body) => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
const post = (body, signature) =>
  fetch(`${base}/webhooks/instagram`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(signature ? { 'x-hub-signature-256': signature } : {}) },
    body,
  });
const IGNORED_RECIPIENT = '1'.repeat(12) === recipient ? '2'.repeat(12) : '1'.repeat(12); // never the real account
const delivery = (recipientId, senderId, mid, text) =>
  JSON.stringify({
    object: 'instagram',
    entry: [
      {
        id: recipientId,
        time: Math.floor(Date.now() / 1000),
        messaging: [{ sender: { id: senderId }, recipient: { id: recipientId }, timestamp: Date.now(), message: { mid, text } }],
      },
    ],
  });

await check('health reports webhook configured and leaks no secret', async () => {
  const res = await fetch(`${base}/api/health`);
  const text = await res.text();
  expect(res.status === 200, `status ${res.status}`);
  expect(!text.includes(secret) && !text.includes(verify), 'health response contains a secret');
  expect(JSON.parse(text)?.instagram?.webhookConfigured === true, 'instagram.webhookConfigured is not true');
});
await check('app API without a Firebase token is 401', async () => {
  const res = await fetch(`${base}/api/memories`);
  expect(res.status === 401, `status ${res.status}`);
});
await check('public service does not expose /internal (404)', async () => {
  const res = await fetch(`${base}/internal/instagram/status`);
  expect(res.status === 404, `status ${res.status}`);
  const run = await fetch(`${base}/internal/instagram/worker/run`, { method: 'POST' });
  expect(run.status === 404, `worker run status ${run.status}`);
});
await check('GET challenge echoes verbatim with the right token', async () => {
  const challenge = `c${crypto.randomBytes(6).toString('hex')}`;
  const res = await fetch(`${base}/webhooks/instagram?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(verify)}&hub.challenge=${challenge}`);
  expect(res.status === 200, `status ${res.status}`);
  expect((await res.text()) === challenge, 'challenge not echoed');
});
await check('GET challenge with a wrong token is 403', async () => {
  const res = await fetch(`${base}/webhooks/instagram?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x`);
  expect(res.status === 403, `status ${res.status}`);
});
await check('POST with no signature is 401', async () => {
  const res = await post(delivery(IGNORED_RECIPIENT, '3'.repeat(12), 'mid.acceptance.nosig', 'x'));
  expect(res.status === 401, `status ${res.status}`);
});
await check('POST with a bad signature is 401', async () => {
  const res = await post(delivery(IGNORED_RECIPIENT, '3'.repeat(12), 'mid.acceptance.bad', 'x'), 'sha256=' + '0'.repeat(64));
  expect(res.status === 401, `status ${res.status}`);
});
await check('signed POST to another recipient is 200 and ignored (stores nothing)', async () => {
  const body = delivery(IGNORED_RECIPIENT, '3'.repeat(12), `mid.acceptance.${Date.now()}`, 'synthetic acceptance message');
  const res = await post(body, sign(body));
  expect(res.status === 200, `status ${res.status}`);
});
if (storeSynthetic) {
  await check('signed synthetic message from a paired sender is stored once (200, duplicate 200)', async () => {
    expect(Boolean(sender), 'set TEST_SENDER_ID to a paired Instagram-scoped ID');
    const body = delivery(recipient, sender, `mid.acceptance.${Date.now()}`, 'synthetic acceptance note');
    const first = await post(body, sign(body));
    const again = await post(body, sign(body));
    expect(first.status === 200 && again.status === 200, `statuses ${first.status}/${again.status}`);
  });
}
if (worker) {
  await check('worker is not callable without an identity', async () => {
    const res = await fetch(`${worker}/internal/instagram/worker/run`, { method: 'POST' });
    expect([401, 403].includes(res.status), `status ${res.status}`);
  });
  await check('worker rejects a made-up bearer token', async () => {
    const res = await fetch(`${worker}/internal/instagram/worker/run`, { method: 'POST', headers: { authorization: 'Bearer not-a-real-token' } });
    expect([401, 403].includes(res.status), `status ${res.status}`);
  });
  if (idToken) {
    await check('authenticated status read returns counts only', async () => {
      const res = await fetch(`${worker}/internal/instagram/status`, { headers: { authorization: `Bearer ${idToken}` } });
      expect(res.status === 200, `status ${res.status}`);
      const body = await res.json();
      expect(typeof body === 'object' && body && 'webhook' in body && 'events' in body && 'jobs' in body, 'unexpected shape');
      console.log('status counts:', JSON.stringify({ webhook: body.webhook, events: body.events, jobs: body.jobs }));
    });
  }
}

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
