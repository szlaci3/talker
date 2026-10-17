import { getStore } from '@netlify/blobs';
import { STORE_NAME } from '../lib/antigravity.mjs';
import { cleanupExpired } from '../lib/chat-state.mjs';

// No keepalive: discard expired transient buffers and counters once per hour.
export default async function cleanup() {
  const store = getStore({ name: STORE_NAME, consistency: 'strong' });
  await cleanupExpired(store);
}

export const config = { schedule: '17 * * * *' };
