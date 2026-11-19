import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const file = resolve(process.env.HISTORY_CACHE_FILE ?? '.cache/sofuse-history.json');
const maxEntries = 500;
const ttl = 5 * 60 * 1000;
const retention = 7 * 24 * 60 * 60 * 1000;
const entries = new Map();
const inFlight = new Map();
const retryAfter = new Map();
let writes = Promise.resolve();

export const serialize = value => JSON.stringify(value, (_, item) =>
  typeof item === 'bigint' ? item.toString() : item);

try {
  const data = JSON.parse(await readFile(file, 'utf8'));
  if (data.version === 1) {
    for (const [address, entry] of data.entries.slice(-maxEntries)) {
      if (Date.now() - entry.checkedAt < retention) entries.set(address, entry);
    }
  }
} catch (error) {
  if (error.code !== 'ENOENT') console.error('History cache could not be loaded:', error.message);
}

function save() {
  writes = writes.then(async () => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file + '.tmp', serialize({ version: 1, entries: [...entries] }), { mode: 0o600 });
    await rename(file + '.tmp', file);
  }).catch(error => console.error('History cache could not be saved:', error.message));
}

export async function walletHistory(address, block, balance, load) {
  const cached = entries.get(address);
  const now = Date.now();
  if (cached && now - cached.checkedAt < ttl && cached.block <= block &&
      BigInt(cached.history.shareDelta) === balance) {
    return { ...cached.history, historyBlock: cached.block, historyAvailable: true };
  }
  const fallback = cached && now - cached.checkedAt < retention && cached.block <= block
    ? { ...cached.history, historyBlock: cached.block, historyAvailable: true, historyStale: true }
    : { historyAvailable: false };

  let request = inFlight.get(address);
  if (!request) {
    if (inFlight.size >= 4 || (retryAfter.get(address) ?? 0) > now) return fallback;
    request = (async () => {
      const history = await load();
      if (history.shareDelta === balance) {
        entries.delete(address);
        entries.set(address, { block, checkedAt: Date.now(), history });
        while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
        save();
      }
      return { ...history, historyBlock: block, historyAvailable: true };
    })().finally(() => inFlight.delete(address));
    inFlight.set(address, request);
  }
  try {
    const result = await request;
    if (result.historyBlock > block) return fallback;
    if (BigInt(result.shareDelta) === balance) return result;
    return fallback.historyAvailable ? fallback : { ...result, historyStale: true };
  } catch (error) {
    console.error('Wallet history:', error.message);
    for (const [key, expiry] of retryAfter) if (expiry <= now) retryAfter.delete(key);
    if (retryAfter.size < maxEntries) retryAfter.set(address, Date.now() + 30000);
    return fallback;
  }
}
