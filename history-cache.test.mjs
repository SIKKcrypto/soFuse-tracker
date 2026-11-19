import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';

const address = '0x' + 'aB'.repeat(20);
const history = { deposits: 100n, withdrawals: 10n, boosts: 2n, shareDelta: 92n, unclassified: 0, pending: 0 };
let moduleInstance = 0;

async function loadCache(file) {
  const previous = process.env.HISTORY_CACHE_FILE;
  process.env.HISTORY_CACHE_FILE = file;
  try {
    return await import('./history-cache.mjs?test=' + ++moduleInstance);
  } finally {
    if (previous === undefined) delete process.env.HISTORY_CACHE_FILE;
    else process.env.HISTORY_CACHE_FILE = previous;
  }
}

async function cacheFile(t) {
  const directory = await mkdtemp(join(tmpdir(), 'sofuse-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'history.json');
}

async function readMigrated(file) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      const data = JSON.parse(await readFile(file, 'utf8'));
      if (data.version === 2) return data;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await setTimeout(10);
  }
  assert.fail('Expected a version 2 cache on disk');
}

test('coalesces scans, persists a wallet fingerprint, and restores the verified result', async t => {
  const file = await cacheFile(t);
  const { walletHistory } = await loadCache(file);
  let scans = 0;
  const load = async () => {
    scans++;
    await setTimeout(20);
    return history;
  };
  const snapshots = await Promise.all([
    walletHistory(address, 120, 92n, load),
    walletHistory(address.toLowerCase(), 121, 92n, load),
  ]);
  assert.equal(scans, 1);
  assert.deepEqual(snapshots[0], snapshots[1]);

  const stored = await readMigrated(file);
  assert.equal(stored.entries.length, 1);
  assert.match(stored.entries[0][0], /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(stored).includes(address.toLowerCase()));

  const restored = await loadCache(file);
  const restoredHistory = await restored.walletHistory(address, 122, 92n, load);
  assert.equal(restoredHistory.historyBlock, 120);
  assert.equal(restoredHistory.deposits, '100');
  assert.equal(scans, 1);
});

test('migrates valid older entries, skips corrupt entries, and holds the reconciled snapshot on balance mismatch', async t => {
  const file = await cacheFile(t);
  const persistedHistory = Object.fromEntries(Object.entries(history).map(([key, value]) => [
    key, typeof value === 'bigint' ? String(value) : value,
  ]));
  const valid = { block: 100, checkedAt: Date.now(), history: persistedHistory };
  await writeFile(file, JSON.stringify({
    version: 1,
    entries: [
      null,
      ['0x' + '2'.repeat(40), { ...valid, checkedAt: Date.now() + 60_000 }],
      ['0x' + '3'.repeat(40), { ...valid, history: { ...persistedHistory, shareDelta: 'broken' } }],
      [address, valid],
    ],
  }));
  const { walletHistory } = await loadCache(file);
  const snapshot = await walletHistory(address, 120, 93n, async () => ({ ...history, deposits: 999n }));
  assert.equal(snapshot.historyStale, true);
  assert.equal(snapshot.historyBlock, 100);
  assert.equal(snapshot.deposits, '100');

  const stored = await readMigrated(file);
  assert.equal(stored.entries.length, 1);
  assert.equal(stored.entries[0][1].history.shareDelta, '92');
});

test('does not attach a newer concurrent history to an older live block', async t => {
  const file = await cacheFile(t);
  const { walletHistory } = await loadCache(file);
  const newer = walletHistory(address, 122, 92n, async () => {
    await setTimeout(20);
    return history;
  });
  const older = walletHistory(address, 121, 92n, async () => assert.fail('Expected an in-flight lookup'));
  assert.deepEqual(await older, { historyAvailable: false });
  assert.equal((await newer).historyBlock, 122);
  await readMigrated(file);
});
