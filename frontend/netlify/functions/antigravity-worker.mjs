import { getStore } from '@netlify/blobs';
import { createWorker } from '../lib/chat-worker.mjs';
import { STORE_NAME } from '../lib/antigravity.mjs';

export default async function worker(request) {
  return createWorker({ store: getStore({ name: STORE_NAME, consistency: 'strong' }) })(request);
}

export const config = { background: true };
