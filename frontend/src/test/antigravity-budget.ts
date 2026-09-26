import { open, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WINDOW_MS = 60_000;
export const MAX_ANTIGRAVITY_REQUESTS_PER_MINUTE = 7;
const budgetFile = join(tmpdir(), 'talker-antigravity-test-rpm.json');
const lockFile = budgetFile + '.lock';

export async function waitForAntigravityRequestSlot() {
  while (true) {
    const now = Date.now();
    let delay = 0;
    let lock;
    const lockDeadline = now + 10_000;

    while (!lock) {
      try {
        lock = await open(lockFile, 'wx');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          if (Date.now() - (await stat(lockFile)).mtimeMs > 30_000) await unlink(lockFile);
        } catch { /* Another test process may have removed a stale lock. */ }
        if (Date.now() >= lockDeadline) throw new Error('Timed out coordinating the Antigravity request budget.');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }

    try {
      let timestamps: number[] = [];
      try {
        timestamps = JSON.parse(await readFile(budgetFile, 'utf8')) as number[];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const recent = timestamps.filter(timestamp => timestamp > now - WINDOW_MS);
      if (recent.length >= MAX_ANTIGRAVITY_REQUESTS_PER_MINUTE) {
        delay = recent[0] + WINDOW_MS - now + 25;
      } else {
        recent.push(now);
        await writeFile(budgetFile, JSON.stringify(recent), 'utf8');
      }
    } finally {
      await lock.close();
      await unlink(lockFile).catch(() => undefined);
    }

    if (delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
      continue;
    }
    return;
  }
}
