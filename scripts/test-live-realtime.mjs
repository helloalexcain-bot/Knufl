// Opt-in BILLABLE control-plane test. Requires a real browser, but never opens
// its microphone. Real preview Worker, Auth, OpenAI WebRTC and independent Cron.
// Existing account data/access/runtime limits are untouched. Disposable budget
// history leaves one minute on account A; that history is a test fixture.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const origin = 'https://knufl-voice-companion.alcain.chatgpt.site';
const input = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
const secrets = JSON.parse(await input.question('Ready for test credentials on hidden stdin:\n'));
input.close();
const sbUrl = 'https://ntymjigywntaczxiqpdh.supabase.co';
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(sbUrl, secrets.serviceRoleKey, options);
const accounts = [];
let voiceId, deadline, claimed = false, complete = false, cleanupStarted = false;
let poll, watchdog;
const requireData = ({ data, error }) => { if (error) throw new Error('Database rejected test: ' + error.code); return data; };
async function account() {
  const credentials = { email: `knufl-realtime-${randomUUID()}@example.com`, password: randomUUID() + randomUUID() };
  const created = requireData(await admin.auth.admin.createUser({ ...credentials, email_confirm: true, app_metadata: { knufl_disposable_test: true } }));
  const client = createClient(sbUrl, secrets.anonKey, options);
  const entry = { id: created.user.id, client };
  accounts.push(entry);
  const signed = requireData(await client.auth.signInWithPassword(credentials));
  entry.token = signed.session.access_token;
  return entry;
}
async function remote(who, path, body, sdp = false) {
  return fetch(origin + path, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { Authorization: 'Bearer ' + who.token, 'OAI-Sites-Authorization': 'Bearer ' + secrets.siteToken,
      'Content-Type': sdp ? 'application/sdp' : 'application/json' },
    body: sdp ? body : JSON.stringify(body) });
}
async function cleanup() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  clearInterval(poll); clearTimeout(watchdog);
  if (voiceId && !complete) await remote(accounts[0], '/api/realtime/close', { sessionId: voiceId }).catch(() => {});
  let removed = 0;
  for (const a of accounts) {
    await a.client.auth.signOut().catch(() => {});
    const { error } = await admin.auth.admin.deleteUser(a.id);
    if (!error) removed++;
    else { console.error('Disposable cleanup failed:', a.id, error.code); process.exitCode = 1; }
  }
  console.log(`Removed ${removed}/${accounts.length} disposable accounts and fixture records.`);
  server.close();
}

const html = `<!doctype html><meta name="viewport" content="width=device-width"><title>Knufl live WebRTC control test</title>
<h1>Live WebRTC control test</h1><p>Disposable account. No microphone, no generated reply. Brief billable provider access.</p>
<button id="connect">Connect once</button><button id="cleanup">Clean up test</button><pre id="status">Ready</pre>
<script>
const status = document.querySelector('#status'); let peer;
function show(value) { status.textContent += '\\n' + value; }
document.querySelector('#connect').onclick = async event => {
 event.target.disabled = true;
 try {
  peer = new RTCPeerConnection(); peer.addTransceiver('audio', {direction:'recvonly'});
  const channel = peer.createDataChannel('oai-events');
  channel.onopen = () => { show('REAL data channel OPEN'); fetch('/event', {method:'POST',body:'data-channel-open'}); };
  channel.onclose = () => { show('REAL data channel CLOSED without a client expiry timer'); fetch('/event', {method:'POST',body:'data-channel-closed'}); };
  channel.onmessage = event => { const data = JSON.parse(event.data); if(data.type === 'session.created') show('Provider session.created received'); if(data.type === 'error') show('Provider error: ' + data.error?.code); };
  peer.onconnectionstatechange = () => show('Peer: ' + peer.connectionState);
  const offer = await peer.createOffer(); await peer.setLocalDescription(offer);
  const response = await fetch('/offer', {method:'POST',body:offer.sdp});
  if(!response.ok) throw new Error(await response.text());
  show('Server deadline: ' + response.headers.get('x-knufl-expires-at'));
  await peer.setRemoteDescription({type:'answer',sdp:await response.text()});
 } catch(error) { show('FAILED: ' + error.message); }
};
document.querySelector('#cleanup').onclick = async () => { await fetch('/cleanup', {method:'POST'}); peer?.close(); show('Cleanup requested'); };
</script>`;

const server = createServer(async (req, res) => {
  try {
    if (req.headers.host !== localHost) { res.writeHead(403).end(); return; }
    if (req.method === 'POST' && req.headers.origin !== 'http://' + localHost) { res.writeHead(403).end(); return; }
    if (req.method === 'GET' && req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }).end(html); return; }
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 150000) throw new Error('Request too large'); }
    if (req.url === '/event') {
      if (['data-channel-open', 'data-channel-closed'].includes(body)) console.log('BROWSER:', body, new Date().toISOString());
      res.writeHead(204).end(); return;
    }
    if (req.url === '/cleanup') { res.writeHead(204).end(); await cleanup(); return; }
    if (req.url !== '/offer' || claimed) { res.writeHead(409).end('Only one test call permitted'); return; }
    claimed = true;
    const [a, b] = accounts;
    const response = await remote(a, '/api/realtime', body, true);
    const answer = await response.text();
    if (response.status !== 201) { process.exitCode = 1; console.error('Live create failed:', response.status); res.writeHead(response.status).end('Provider create failed; status ' + response.status); return; }
    voiceId = response.headers.get('x-knufl-voice-session');
    deadline = response.headers.get('x-knufl-voice-expires-at');
    assert(voiceId && deadline, 'Missing durable identity/deadline');
    console.log('LIVE call created:', { voiceId, deadline });
    res.writeHead(200, { 'Content-Type': 'application/sdp', 'x-knufl-expires-at': deadline }).end(answer);
    const denied = await remote(a, '/api/realtime', body, true);
    assert.equal(denied.status, 429); console.log('PASS: concurrent live-account call rejected before provider issuance');
    const foreignClose = await remote(b, '/api/realtime/close', { sessionId: voiceId });
    assert.equal(foreignClose.status, 404); console.log('PASS: account B cannot terminate account A through the privileged Worker');
    let busy = false;
    poll = setInterval(async () => {
      if (busy) return; busy = true;
      try {
        const row = requireData(await admin.from('voice_usage_sessions').select('status,started_at,expires_at,ended_at').eq('id', voiceId).single());
        if (row.status === 'closed') {
          complete = true; clearInterval(poll);
          console.log('LIVE independent ledger closure:', row);
          assert(Date.parse(row.ended_at) >= Date.parse(deadline), 'Call ended before the enforced deadline');
          const exhausted = await remote(a, '/api/realtime', body, true);
          assert.equal(exhausted.status, 429);
          assert.equal((await exhausted.json()).error.details.reason, 'daily_budget_exhausted');
          console.log('PASS: consumed daily budget rejects the next call; no client expiry or close request was used');
          console.log('Inspect the browser CLOSED event and private outbox acknowledgement before cleanup.');
        }
      } catch (error) { process.exitCode = 1; console.error('Verification failed:', error.message); clearInterval(poll); }
      finally { busy = false; }
    }, 4000);
  } catch (error) {
    process.exitCode = 1;
    console.error('Test failed:', error.message);
    if (!res.headersSent) res.writeHead(500).end('Test failed; inspect redacted terminal output');
  }
});
let localHost;
try {
  const a = await account(); await account();
  requireData(await admin.from('profiles').insert({ user_id: a.id, companion_name: 'Test Knufl' }));
  const now = Date.now();
  // 59 minutes already consumed (fixture), leaving one real minute. No global
  // deployment-limit changes and no records in the owner's Google account.
  assert(new Date(now).getUTCHours() >= 1, 'Run after 01:00 UTC so the fixture stays within today');
  requireData(await admin.from('voice_usage_sessions').insert({ id: randomUUID(), user_id: a.id, status: 'closed',
    started_at: new Date(now - 3600000).toISOString(), expires_at: new Date(now - 60000).toISOString(), ended_at: new Date(now - 60000).toISOString() }));
  server.listen(0, '127.0.0.1', () => { localHost = '127.0.0.1:' + server.address().port; console.log('Open http://' + localHost + '/'); });
  watchdog = setTimeout(() => { if (!complete) process.exitCode = 1; console.log('Test watchdog: closing/cleaning disposable data'); void cleanup(); }, 10 * 60000);
  process.on('SIGINT', () => { void cleanup(); });
  process.on('SIGTERM', () => { void cleanup(); });
} catch (error) { console.error('Setup failed:', error.message); await cleanup(); process.exitCode = 1; }
