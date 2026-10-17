import { createHash } from 'node:crypto';
import { json } from './security.mjs';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// CAS is required: warm function instances do not share memory or locks.
export async function update(store, key, change, expiresAt) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const entry = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' });
    if (entry && typeof entry.etag !== 'string') throw json({ error: 'Chat storage cannot enforce atomic updates.' }, 503);
    const data = change(entry?.data ? structuredClone(entry.data) : null);
    const result = await store.setJSON(key, data, {
      ...(entry ? { onlyIfMatch: entry.etag } : { onlyIfNew: true }),
      metadata: { expiresAt },
    });
    if (result.modified) return data;
  }
  throw json({ error: 'The chat service is busy. Please try again.' }, 409);
}

export async function read(store, key) {
  return store.get(key, { type: 'json', consistency: 'strong' });
}

export async function countModelRequest(store, sessionKey, expiresAt, now = Date.now()) {
  const configured = process.env.MAX_DAILY_REQUESTS || '250';
  if (!/^\d+$/.test(configured) || Number(configured) < 1 || Number(configured) > 10_000) {
    throw json({ error: 'The server chat limit configuration is invalid.' }, 503);
  }
  await update(store, `usage/${sessionKey}`, old => {
    const times = (old?.times || []).filter(time => time > now - 3_600_000);
    if (times.length >= 30) throw json({ error: 'Too many requests. Please wait and try again.' }, 429);
    return { times: [...times, now] };
  }, expiresAt);
  const day = new Date(now).toISOString().slice(0, 10);
  await update(store, `daily/${day}`, old => {
    const count = old?.count || 0;
    if (count >= Number(configured)) throw json({ error: 'The daily chat limit has been reached. Please try again tomorrow.' }, 429);
    return { count: count + 1 };
  }, Date.parse(`${day}T00:00:00Z`) + 8 * 86_400_000);
  // Reservations are conservative: failed starts are counted, never refunded.
}

export async function cleanupExpired(store, now = Date.now(), limit = 500) {
  let checked = 0;
  for await (const page of store.list({ paginate: true })) {
    for (const blob of page.blobs) {
      const entry = await store.getWithMetadata(blob.key, { type: 'json', consistency: 'strong' });
      if (entry?.metadata?.expiresAt < now) await store.delete(blob.key);
      if (++checked >= limit) return;
    }
  }
}
