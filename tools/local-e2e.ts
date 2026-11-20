// Local, credential-free end-to-end run of the Instagram DM pipeline over real HTTP:
//   tester shares a Reel to the connected account -> signed Meta delivery -> durable event/job -> worker ->
//   media -> (fake) Gemini -> guard -> memory in the tester's own library, with the exact note attached.
// Uses the in-memory store and storage, a fake model, a scripted Meta media route and synthetic secrets.
// Nothing here talks to Meta or Google, and no production credential or data is read or written.
//
//   npx tsx tools/local-e2e.ts
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/index.js';
import type { GeminiService } from '../server/gemini.js';
import { loadInstagramConfig } from '../server/instagram/config.js';
import type { FetchLike } from '../server/instagram/media.js';
import type { InstagramWorker } from '../server/instagram/worker.js';
import { InMemoryMediaStorage } from '../server/storage.js';
import { InMemoryStore } from '../server/store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_MP4 = fs.readFileSync(path.join(here, '..', 'tests', 'fixtures', 'neophi-sample.mp4'));

const SECRET = 'local-synthetic-app-secret';
const VERIFY = 'local-synthetic-verify-token';
const RECIPIENT = '17841449458840084'; // the connected professional account (not a secret)
const SENDER = '1100000000000001'; // synthetic tester IGSID
const UID = 'local-tester-uid';
const NOTE = 'Maa ke liye  🥞\n  kasuri methi wala step  '; // spacing and emoji must survive byte for byte

const sign = (body: string) => 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex');
const mediaUrl = (id: string) => `https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=${id}&signature=SYNTHETIC`;

const fakeGemini: GeminiService = {
  analyzeMemory: async (m) => ({
    source_summary: `Local fake model read (${m.ingest})`,
    evidence: [{ id: 'c_00', kind: 'caption', ref: 'caption' }],
    observed_objects: [],
    visible_text: [],
    transcript_summary: '',
    inferred_possible_intents: [],
    actionable_entities: [],
    suggested_actions: [],
    purpose: 'food',
    note_grounding: { status: 'no_note', evidence: [], explanation: '' },
  }) as never,
  embedText: async () => [0.1, 0.2, 0.3],
  rewriteSearchQuery: async (q) => ({ english: q, hindi: q, hinglish: q, keywords: q.split(/\s+/), timeHint: null }),
  suggestCategory: async () => null,
  buildOutcome: async () => [],
};

async function scenario(name: string, mediaRoute: FetchLike) {
  let now = Date.now();
  const store = new InMemoryStore();
  const app = createApp({
    store,
    storage: new InMemoryMediaStorage(),
    gemini: fakeGemini,
    authVerifier: async (t) => t,
    instagram: {
      config: loadInstagramConfig({
        META_APP_SECRET: SECRET,
        META_VERIFY_TOKEN: VERIFY,
        META_IG_RECIPIENT_ID: RECIPIENT,
        INSTAGRAM_SENDER_UID_MAP: `${SENDER}=${UID}`,
      }),
      fetchImpl: mediaRoute,
      now: () => now,
    },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const worker = app.locals.instagramWorker as InstagramWorker;
  const post = async (messaging: unknown) => {
    const body = JSON.stringify({ object: 'instagram', entry: [{ id: RECIPIENT, time: Math.floor(now / 1000), messaging: [messaging] }] });
    const r = await fetch(`${base}/webhooks/instagram`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) }, body });
    return r.status;
  };

  console.log(`\n=== ${name} ===`);
  const challenge = await fetch(`${base}/webhooks/instagram?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=abc123`);
  console.log('GET challenge echoed:', (await challenge.text()) === 'abc123');
  const bad = await fetch(`${base}/webhooks/instagram`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=00' }, body: '{}' });
  console.log('bad signature status:', bad.status);

  const share = {
    sender: { id: SENDER },
    recipient: { id: RECIPIENT },
    timestamp: now,
    message: { mid: 'mid.reel.1', attachments: [{ type: 'ig_reel', payload: { url: mediaUrl('1'), title: 'Dosa batter trick from a Chennai cafe', reel_video_id: 'r1' } }] },
  };
  console.log('share webhook status:', await post(share));
  now += 5_000;
  console.log('note webhook status:', await post({ sender: { id: SENDER }, recipient: { id: RECIPIENT }, timestamp: now, message: { mid: 'mid.note.1', text: NOTE } }));
  console.log('duplicate share status (Meta retry):', await post(share));

  for (let i = 0; i < 3; i++) {
    await worker.drain();
    now += 20_000;
  }
  await worker.drain();

  const headers = { authorization: `Bearer ${UID}` };
  const list = (await (await fetch(`${base}/api/memories`, { headers })).json()) as { memories?: any[] } | any[];
  const memories = Array.isArray(list) ? list : (list.memories ?? []);
  const other = await fetch(`${base}/api/memories`, { headers: { authorization: 'Bearer someone-else' } });
  const otherList = (await other.json()) as { memories?: any[] } | any[];
  const otherCount = (Array.isArray(otherList) ? otherList : (otherList.memories ?? [])).length;

  console.log('memories for the tester:', memories.length, '| for another user:', otherCount);
  for (const m of memories) {
    console.log({
      title: m.title,
      platform: m.platform,
      ingest: m.ingest,
      mediaStored: Boolean(m.media?.mime),
      mediaMime: m.media?.mime ?? null,
      mediaOutcome: m.dm?.mediaOutcome,
      analysisBasis: m.dm?.analysisBasis,
      analysisStatus: m.analysisStatus,
      noteExact: m.note === NOTE,
      notesAttached: m.dmNotes?.length,
    });
  }
  console.log('status counts:', JSON.stringify(await store.instagramCounts()));
  server.close();
}

const mp4: FetchLike = async () =>
  new Response(new Uint8Array(SAMPLE_MP4), { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(SAMPLE_MP4.length) } });
const html: FetchLike = async () => new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } });

await scenario('A. Meta provides the video (full_media, media-backed analysis)', mp4);
await scenario('B. Meta provides only an HTML page (caption + exact note fallback)', html);
