import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const file = resolve(process.env.HISTORY_CACHE_FILE ?? '.cache/sofuse-history.json');
const maxEntries = 500;
const maxFileBytes = 2 * 1024 * 1024;
const ttl = 5 * 60 * 1000;
const retention = 7 * 24 * 60 * 60 * 1000;
const entries = new Map();
const inFlight = new Map();
const retryAfter = new Map();
let writes = Promise.resolve();

export const serialize = value => JSON.stringify(value, (_, item) =>
  typeof item === 'bigint' ? item.toString() : item);

const fingerprint = address => createHash('sha256').update(address.toLowerCase()).digest('hex');
const validCount = value => Number.isSafeInteger(value) && value >= 0;
const validAmount = value => typeof value === 'string' && /^\d{1,100}$/.test(value);

function validEntry(entry, now) {
  const history = entry?.history;
  return history && validCount(entry.block) &&
    validCount(entry.checkedAt) && entry.checkedAt <= now && now - entry.checkedAt < retention &&
    ['deposits', 'withdrawals', 'boosts', 'shareDelta'].every(key => validAmount(history[key])) &&
    ['unclassified', 'pending'].every(key => validCount(history[key]));
}

async function readCache() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    bytes += chunk.length;
    if (bytes > maxFileBytes) throw new Error('Cache file exceeds size limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

try {
  const data = await readCache();
  if ([1, 2].includes(data?.version) && Array.isArray(data.entries)) {
    const now = Date.now();
    const keyPattern = data.version === 1 ? /^0x[0-9a-f]{40}$/i : /^[0-9a-f]{64}$/;
    for (const pair of data.entries.slice(-maxEntries)) {
      if (!Array.isArray(pair)) continue;
      const [key, entry] = pair;
      if (typeof key === 'string' && keyPattern.test(key) && validEntry(entry, now)) {
        const { deposits, withdrawals, boosts, shareDelta, unclassified, pending } = entry.history;
        entries.set(data.version === 1 ? fingerprint(key) : key, {
          block: entry.block,
          checkedAt: entry.checkedAt,
          history: { deposits, withdrawals, boosts, shareDelta, unclassified, pending },
        });
      }
    }
    if (data.version === 1 || entries.size !== data.entries.length) save();
  }
} catch (error) {
  if (error.code !== 'ENOENT') console.error('History cache could not be loaded:', error.message);
}

function save() {
  writes = writes.then(async () => {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const tempFile = file + '.' + randomUUID() + '.tmp';
    const handle = await open(tempFile, 'wx', 0o600);
    try {
      const now = Date.now();
      const active = [...entries].filter(([, entry]) => now - entry.checkedAt < retention);
      try {
        await handle.writeFile(serialize({ version: 2, entries: active }));
      } finally {
        await handle.close();
      }
      await rename(tempFile, file);
    } catch (error) {
      await unlink(tempFile).catch(() => {});
      throw error;
    }
  }).catch(error => console.error('History cache could not be saved:', error.message));
}

export async function walletHistory(address, block, balance, load) {
  const key = fingerprint(address);
  const cached = entries.get(key);
  const now = Date.now();
  if (cached && now - cached.checkedAt < ttl && cached.block <= block &&
      BigInt(cached.history.shareDelta) === balance) {
    return { ...cached.history, historyBlock: cached.block, historyAvailable: true };
  }
  const fallback = cached && now - cached.checkedAt < retention && cached.block <= block
    ? { ...cached.history, historyBlock: cached.block, historyAvailable: true, historyStale: true }
    : { historyAvailable: false };

  let request = inFlight.get(key);
  if (!request) {
    if (inFlight.size >= 4 || (retryAfter.get(key) ?? 0) > now) return fallback;
    request = (async () => {
      const history = await load();
      if (history.shareDelta === balance && (entries.get(key)?.block ?? 0) <= block) {
        entries.delete(key);
        entries.set(key, { block, checkedAt: Date.now(), history });
        while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
        save();
      }
      return { ...history, historyBlock: block, historyAvailable: true };
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, request);
  }
  try {
    const result = await request;
    if (result.historyBlock > block) return fallback;
    if (BigInt(result.shareDelta) === balance) return result;
    return fallback.historyAvailable ? fallback : { ...result, historyStale: true };
  } catch (error) {
    console.error('Wallet history:', error.message);
    for (const [fingerprint, expiry] of retryAfter) if (expiry <= now) retryAfter.delete(fingerprint);
    if (retryAfter.size < maxEntries) retryAfter.set(key, Date.now() + 30000);
    return fallback;
  }
}
