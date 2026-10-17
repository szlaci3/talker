import { randomUUID } from 'node:crypto';
import { createAntigravity } from '../lib/antigravity.mjs';
import { createWorker } from '../lib/chat-worker.mjs';
import { tokenFor } from '../lib/security.mjs';

export class MemoryStore {
  entries = new Map();
  version = 0;
  async get(key) { return structuredClone(this.entries.get(key)?.data ?? null); }
  async getWithMetadata(key) { return structuredClone(this.entries.get(key) ?? null); }
  async setJSON(key, data, options = {}) {
    const current = this.entries.get(key);
    if ((options.onlyIfNew && current) || (options.onlyIfMatch && current?.etag !== options.onlyIfMatch)) return { modified: false };
    this.entries.set(key, structuredClone({ data, metadata: options.metadata || {}, etag: String(++this.version) }));
    return { modified: true };
  }
  async delete(key) { this.entries.delete(key); }
  async *list() { yield { blobs: [...this.entries.keys()].sort().map(key => ({ key })) }; }
}

export const sse = (...events) => new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), {
  headers: { 'Content-Type': 'text/event-stream' },
});

export const answerEvents = (text = 'A streamed answer.', id = randomUUID()) => [
  { event_type: 'interaction.start', interaction: { id, environment_id: 'test-environment' } },
  { event_type: 'step.delta', event_id: 'delta-one', delta: { type: 'text', text } },
  { event_type: 'interaction.completed', interaction: { id, status: 'completed' } },
];

export function harness(options = {}) {
  const store = options.store || new MemoryStore();
  const requests = [];
  const runs = [];
  const fetcher = options.fetcher || (async (url, init) => {
    requests.push([String(url), init]);
    return String(url).includes('/interactions/') ? Response.json({ environment_id: 'test-environment' }) : sse(...answerEvents());
  });
  const worker = createWorker({ store, fetcher, pollMs: 5, ...options });
  const chat = createAntigravity({ store, fetcher, pollMs: 2, streamWindowMs: 40,
    dispatch: async ticket => { runs.push(worker(new Request('https://talker.test/.netlify/functions/antigravity-worker', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }),
    }))); }, ...options });
  const token = tokenFor(Math.floor(Date.now() / 1000) + 3600);
  const conversationId = randomUUID();
  const request = (path, body, headers = {}) => new Request('https://talker.test' + path, {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'X-Conversation-ID': conversationId,
      Origin: 'https://talker.test', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  return { store, requests, runs, worker, chat, request, conversationId, token };
}

export const frames = raw => raw.split('\n').filter(line => line.startsWith('data:') && !line.includes('[DONE]')).map(line => JSON.parse(line.slice(5)));
