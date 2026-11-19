import assert from 'node:assert/strict';
import { mkdtemp, readFile, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const owner = '0x' + 'a'.repeat(40);
const zero = '0x' + '0'.repeat(40);
const vault = '0xb33c8f0b0816fd147fcf896c594a3ef408845e2c';
const wrapped = '0x0be9e53fd7edac9f859882afdda116645287c629';
const locker = '0x7c8e58c63a11ea74d3986d5cac1e820ef87c6584';
const queue = '0x8a6612ff8ba43c4c8a1e7dd5c0ee2d7cbedf0e66';
const distributor = '0x521b8d0934b813737ffe19cbc7de810f02b5d9e1';
const solver = '0x' + 'b'.repeat(40);
const unit = 10n ** 18n;
const word = n => BigInt(n).toString(16).padStart(64, '0');
const hash = n => '0x' + word(n);
const topic = address => '0x' + address.slice(2).padStart(64, '0');

function transfer(block, token, from, to, shares) {
  return {
    block_number: block, log_index: 0, transaction_hash: hash(block),
    token: { address_hash: token }, from: { hash: from }, to: { hash: to },
    total: { value: String(BigInt(shares) * unit) },
  };
}

function event(contract, topics, words) {
  return { address: { hash: contract }, topics, data: '0x' + words.map(word).join(''), decoded: null };
}

function dispatch(server, url, method = 'GET') {
  return new Promise(resolve => {
    const headers = {};
    let status;
    server.emit('request', { url, method }, {
      setHeader: (name, value) => { headers[name] = value; },
      writeHead: (code, extra) => { status = code; Object.assign(headers, extra); },
      end: body => resolve({ status, headers, body }),
    });
  });
}

test('reconciles raw deposit and withdrawal events, cancelled requests, and locked shares', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sofuse-server-test-'));
  const cache = join(directory, 'history.json');
  process.env.HISTORY_CACHE_FILE = cache;
  t.after(async () => {
    // Cache writes are asynchronous. Wait for the first write before cleanup.
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await readFile(cache).catch(() => null)) break;
      await delay(10);
    }
    await unlink(cache).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(directory);
  });

  const { createTrackerServer } = await import('./server.mjs');
  const server = createTrackerServer();
  const path = '/api/position?address=' + owner;
  const deposit = transfer(1, vault, zero, owner, 100);
  const shareTransfers = [
    transfer(6, vault, queue, owner, 10), transfer(5, vault, owner, queue, 10),
    transfer(3, vault, owner, queue, 30), transfer(2, vault, distributor, owner, 5), deposit, deposit,
  ];
  const paymentTransfers = [transfer(8, wrapped, solver, owner, 33), transfer(4, wrapped, solver, owner, 33)];
  const requestSignature = '0x2eb08ebdb4d68b4a37e3b424927f3363e1d799ca7e56e7b2c59cc6c1778d33f5';
  const receipts = new Map([
    [hash(1), [event(vault, [
      '0xea00f88768a86184a6e515238a549c171769fe7460a011d6fd0bcd48ca078ea4',
      topic(zero), topic(wrapped), topic(owner),
    ], [100n * unit, 100n * unit])]],
    [hash(3), [event(queue, [requestSignature, hash(10), topic(owner), topic(wrapped)], [1n, 30n * unit, 33n * unit, 1n, 1n, 1n])]],
    [hash(4), []],
    [hash(5), [event(queue, [requestSignature, hash(11), topic(owner), topic(wrapped)], [2n, 10n * unit, 11n * unit, 1n, 1n, 1n])]],
    [hash(6), [event(queue, [
      '0x114ef421aef557f2e4086396789e7fb532b1133ff2982c9d948daa73d0691e36', hash(11), topic(owner),
    ], [1n])]],
    [hash(8), [event(queue, [
      '0xd94fc49a6578873ff851671d19cacb1809887f7a9128867ee4306dc3ffc93c26', hash(10), topic(owner),
    ], [1n])]],
  ]);
  let headRequests = 0;
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    if (url.hostname === 'rpc.fuse.io') {
      const request = JSON.parse(options.body);
      if (request.method === 'eth_blockNumber') {
        headRequests++;
        return Response.json({ result: '0x20' });
      }
      const [call] = request.params;
      const result = call.to === vault ? hash(75n * unit)
        : call.to === locker ? '0x' + [32n, 1n, 20n * unit, 1790000000n, 1820000000n].map(word).join('')
        : hash(125n * unit / 100n);
      return Response.json({ result });
    }
    if (url.pathname.endsWith('/token-transfers')) {
      return Response.json({ items: url.searchParams.get('token') === vault ? shareTransfers : paymentTransfers });
    }
    const receipt = receipts.get(url.pathname.split('/').at(-2));
    assert.ok(receipt, 'unexpected receipt request: ' + url.pathname);
    return Response.json({ items: receipt });
  });
  const responses = await Promise.all([dispatch(server, path), dispatch(server, path)]);
  assert.equal(headRequests, 1, 'concurrent requests for one wallet share the snapshot');
  assert.equal(responses[0].status, 200);
  assert.equal(responses[0].headers['Cache-Control'], 'no-store');
  assert.match(responses[0].headers['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.equal(responses[0].body, responses[1].body);
  const position = JSON.parse(responses[0].body);
  assert.equal(position.deposits, String(100n * unit));
  assert.equal(position.withdrawals, String(33n * unit));
  assert.equal(position.boosts, String(5n * unit));
  assert.equal(position.netGain, String(2675n * unit / 100n));
  assert.equal(position.lockedValue, String(25n * unit));
  assert.equal(position.locks[0].unlocksAt, 1820000000);
  assert.equal(position.pending, 0);
  assert.equal(position.unclassified, 0);
  assert.equal((await dispatch(server, '/api/position?address=' + zero)).status, 400);
  assert.equal((await dispatch(server, '/api/position', 'POST')).status, 405);
  assert.equal((await dispatch(server, '/history-cache.mjs')).status, 404);
});
