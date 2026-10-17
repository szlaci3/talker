import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import session from '../functions/session.mjs';
import { createAntigravity } from '../lib/antigravity.mjs';
import { createWorker } from '../lib/chat-worker.mjs';
import { MemoryStore } from './helpers.mjs';

// Opt-in test adapter only. This process, not the frontend test, reads the key.
if (process.env.TALKER_ENABLE_ANTIGRAVITY_LIVE !== '1') {
  throw new Error('Live calls are disabled. Set TALKER_ENABLE_ANTIGRAVITY_LIVE=1 explicitly.');
}
process.loadEnvFile(new URL('../../../backend/.env', import.meta.url));
if (!process.env.GOOGLE_API_KEY || !process.env.SESSION_SECRET || !process.env.INVITATION_CODE) {
  throw new Error('The locally configured backend is missing required credentials.');
}
const { waitForAntigravityRequestSlot } = await import('../../src/test/antigravity-budget.ts');
const store = new MemoryStore();
const runs = [];
const worker = createWorker({ store, beforeModelRequest: waitForAntigravityRequestSlot });
const chat = createAntigravity({ store, dispatch: async ticket => {
  const request = new Request('http://127.0.0.1/worker', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }) });
  runs.push(worker(request));
} });
const server = createServer(async (incoming, outgoing) => {
  const abort = new AbortController();
  outgoing.on('close', () => { if (!outgoing.writableEnded) abort.abort(); });
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const request = new Request(origin + incoming.url, { method: incoming.method, headers: incoming.headers,
      ...(incoming.method === 'GET' || incoming.method === 'HEAD' ? {} : { body: Readable.toWeb(incoming), duplex: 'half' }), signal: abort.signal });
    const path = new URL(request.url).pathname;
    const response = path === '/healthz' ? Response.json({ provider: 'antigravity', providerConfigured: true })
      : path === '/api/session' ? await session(request, { ip: 'local-live-test' })
      : path === '/api/session/check' ? Response.json({ ok: true }) : await chat(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) Readable.fromWeb(response.body).on('error', () => outgoing.destroy()).pipe(outgoing);
    else outgoing.end();
  } catch { outgoing.writeHead(500); outgoing.end('{"error":"Local test adapter failed."}'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
// Permanent credentials are excluded from the frontend test process.
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['GOOGLE_API_KEY', 'SESSION_SECRET', 'INVITATION_CODE'].includes(key)));
Object.assign(childEnv, { VITE_API_URL: url, VITE_ACCESS_API_URL: url, VITE_CHAT_API_URL: url,
  TALKER_LIVE_INVITATION_CODE: process.env.INVITATION_CODE, TALKER_ANTIGRAVITY_BUDGET_AT_SERVER: '1' });
try {
  const command = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'npm';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm run test:live'] : ['run', 'test:live'];
  const child = spawn(command, args, { windowsHide: true, stdio: 'inherit', env: childEnv });
  process.exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve(code ?? 1)); });
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await Promise.allSettled(runs);
}
