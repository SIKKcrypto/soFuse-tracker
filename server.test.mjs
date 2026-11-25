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

function dispatch(target, url, method = 'GET') {
  return new Promise(resolve => {
    const headers = {};
    let status;
    const request = { url, method };
    const response = {
      setHeader: (name, value) => { headers[name] = value; },
      writeHead: (code, extra) => { status = code; Object.assign(headers, extra); },
      end: body => resolve({ status, headers, body }),
    };
    if (typeof target === 'function') target(request, response);
    else target.emit('request', request, response);
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

  const { default: hostedPosition } = await import('./api/position.mjs');
  const hosted = await dispatch(hostedPosition, path);
  assert.equal(hosted.status, 200);
  assert.equal(hosted.body, responses[0].body);
  assert.equal(hosted.headers['Cache-Control'], 'no-store');
  assert.equal(hosted.headers['Vercel-CDN-Cache-Control'], undefined);
  assert.equal((await dispatch(hostedPosition, '/')).status, 404);
});

test('serves the installable app shell under the same-origin content policy', async () => {
  const { createTrackerServer } = await import('./server.mjs');
  const server = createTrackerServer();
  const page = await dispatch(server, '/');
  assert.equal(page.status, 200);
  assert.match(page.body.toString(), /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(page.headers['Content-Security-Policy'], /manifest-src 'self'; worker-src 'self'/);

  const manifest = await dispatch(server, '/manifest.webmanifest');
  assert.equal(manifest.status, 200);
  assert.match(manifest.headers['Content-Type'], /^application\/manifest\+json/);
  const app = JSON.parse(manifest.body);
  assert.equal(app.start_url, '/');
  assert.equal(app.display, 'standalone');
  for (const { src, sizes } of app.icons) {
    const icon = await dispatch(server, src);
    assert.equal(icon.status, 200);
    assert.equal(icon.headers['Content-Type'], 'image/png');
    assert.equal(icon.body.readUInt32BE(16) + 'x' + icon.body.readUInt32BE(20), sizes);
  }
  const worker = await dispatch(server, '/sw.js');
  assert.equal(worker.status, 200);
  assert.equal(worker.headers['Cache-Control'], 'no-cache');
});

test('serves chronological vault rate events and shares the cached scan between callers', async t => {
  const { createTrackerServer } = await import('./server.mjs');
  const server = createTrackerServer();
  const accountant = '0xb29b5f760d38587f7f4c896c458b9eeb5cad9c0c';
  const rateTopic = '0xa95bc6aba40bbc4d95fc35f118c4cd8b53fc5d5b89ed264002af03503a7a9439';
  const update = (block, timestamp, oldRate, newRate) => ({
    ...event(accountant, [rateTopic], [oldRate, newRate, timestamp]),
    block_number: block,
  });
  let logRequests = 0;
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(input);
    if (url.hostname === 'rpc.fuse.io') return Response.json({ result: '0x20' });
    assert.equal(url.pathname, '/api/v2/addresses/' + accountant + '/logs');
    assert.equal(url.searchParams.get('topic'), rateTopic);
    logRequests++;
    if (url.searchParams.get('block_number')) {
      return Response.json({ items: [update(1, 1000, unit, unit * 108n / 100n)] });
    }
    return Response.json({
      items: [
        update(33, 3000, unit * 105n / 100n, unit * 110n / 100n),
        update(5, 2000, unit * 108n / 100n, unit * 105n / 100n),
      ],
      next_page_params: { index: 0, block_number: 5 },
    });
  });
  const [first, concurrent] = await Promise.all([
    dispatch(server, '/api/rate-history'),
    dispatch(server, '/api/rate-history'),
  ]);
  assert.equal(first.status, 200);
  assert.deepEqual(JSON.parse(first.body), {
    block: 32,
    points: [
      { timestamp: 1000, rate: String(unit * 108n / 100n) },
      { timestamp: 2000, rate: String(unit * 105n / 100n) },
    ],
  });
  assert.equal(concurrent.body, first.body);
  assert.equal((await dispatch(server, '/api/rate-history')).body, first.body);
  assert.equal(logRequests, 2);

  const { default: hostedRates } = await import('./api/rate-history.mjs');
  const hosted = await dispatch(hostedRates, '/api/rate-history');
  assert.equal(hosted.status, 200);
  assert.equal(hosted.body, first.body);
  assert.equal(hosted.headers['Cache-Control'], 'no-store');
  assert.match(hosted.headers['Vercel-CDN-Cache-Control'], /s-maxage=300/);
  assert.equal((await dispatch(hostedRates, '/api/rate-history?refresh=true')).headers['Vercel-CDN-Cache-Control'], undefined);
});

test('values soEUR shares in six-decimal EURC at the same Base block', async t => {
  const originalEndpoint = process.env.BASE_RPC_URL;
  const endpoint = 'https://base-rpc.example';
  process.env.BASE_RPC_URL = endpoint;
  t.after(() => {
    if (originalEndpoint === undefined) delete process.env.BASE_RPC_URL;
    else process.env.BASE_RPC_URL = originalEndpoint;
  });
  const { createTrackerServer } = await import('./server.mjs');
  const server = createTrackerServer();
  const path = '/api/soeurc-position?address=' + owner;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, endpoint);
    calls++;
    const { method, params } = JSON.parse(options.body);
    if (method === 'eth_blockNumber') return Response.json({ result: '0x357b665' });
    assert.equal(method, 'eth_call');
    const [call, block] = params;
    assert.equal(block, '0x357b665');
    if (call.to === '0x4f4b212af8b5020399dde325e1bc5b33b53db70b') {
      assert.equal(call.data, '0x70a08231' + topic(owner).slice(2));
      return Response.json({ result: hash(6522674) });
    }
    assert.deepEqual(call, { to: '0xdcf7a01e32bff2a15b5b42197f75fba7e1f8be35', data: '0x679aefce' });
    return Response.json({ result: hash(1005000) });
  });

  const [first, concurrent] = await Promise.all([dispatch(server, path), dispatch(server, path)]);
  assert.equal(first.status, 200);
  assert.equal(first.headers['Cache-Control'], 'no-store');
  assert.deepEqual(JSON.parse(first.body), {
    block: 0x357b665,
    balance: '6522674',
    rate: '1005000',
    value: '6555287',
  });
  assert.equal(concurrent.body, first.body);
  assert.equal(calls, 3);
  assert.equal((await dispatch(server, '/api/soeurc-position?address=invalid')).status, 400);

  const { default: hostedEuroPosition } = await import('./api/soeurc-position.mjs');
  const hosted = await dispatch(hostedEuroPosition, path);
  assert.equal(hosted.status, 200);
  assert.equal(hosted.body, first.body);
  assert.equal(hosted.headers['Cache-Control'], 'no-store');
  assert.equal(hosted.headers['Vercel-CDN-Cache-Control'], undefined);
});

test('resumes a shared Base scan and reports earned yield after all shares leave the wallet', async t => {
  const prior = process.env.BASE_HISTORY_RPC_URL;
  const archive = 'https://base-archive.example';
  process.env.BASE_HISTORY_RPC_URL = archive;
  t.after(() => {
    if (prior === undefined) delete process.env.BASE_HISTORY_RPC_URL;
    else process.env.BASE_HISTORY_RPC_URL = prior;
  });
  const firstBlock = 52636355;
  const finalized = firstBlock + 500000;
  const euroShares = '0x4f4b212af8b5020399dde325e1bc5b33b53db70b';
  const euroAccountant = '0xdcf7a01e32bff2a15b5b42197f75fba7e1f8be35';
  const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const rateTopic = '0xa95bc6aba40bbc4d95fc35f118c4cd8b53fc5d5b89ed264002af03503a7a9439';
  const blockHex = block => '0x' + block.toString(16);
  const log = (offset, address, topics, data) => ({
    address, topics, data, blockNumber: blockHex(firstBlock + offset), logIndex: '0x0',
  });
  const records = [
    log(1, euroShares, [transferTopic, topic(zero), topic(owner)], hash(100000000)),
    log(2, euroAccountant, [rateTopic], '0x' + [1000000, 1010000, 0].map(word).join('')),
    log(3, euroShares, [transferTopic, topic(owner), topic(solver)], hash(100000000)),
    log(4, euroAccountant, [rateTopic], '0x' + [1010000, 1020000, 0].map(word).join('')),
  ];
  const scanned = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const { method, params } = JSON.parse(options.body);
    if (method === 'eth_getBlockByNumber') {
      assert.deepEqual(params, ['finalized', false]);
      return Response.json({ result: { number: blockHex(finalized) } });
    }
    if (method === 'eth_getLogs') {
      assert.equal(url, archive);
      const { address, fromBlock, toBlock, topics } = params[0];
      assert.deepEqual(address, [euroShares, euroAccountant]);
      assert.deepEqual(topics, [[transferTopic, rateTopic]]);
      const from = Number(fromBlock);
      const to = Number(toBlock);
      scanned.push([from, to]);
      return Response.json({ result: records.filter(item => from <= Number(item.blockNumber) && Number(item.blockNumber) <= to) });
    }
    assert.equal(method, 'eth_call');
    assert.equal(params[1], blockHex(finalized));
    return Response.json({ result: hash(params[0].to === euroShares ? 0 : 1020000) });
  });
  const { default: hostedEarnings } = await import('./api/soeurc-earnings.mjs');
  const path = '/api/soeurc-earnings?address=' + owner;
  const progress = await Promise.all([dispatch(hostedEarnings, path), dispatch(hostedEarnings, path)]);
  assert.equal(progress[0].status, 202);
  assert.equal(progress[0].headers['Retry-After'], '2');
  assert.equal(progress[1].body, progress[0].body);
  assert.deepEqual(JSON.parse(progress[0].body), { through: firstBlock + 299999, target: finalized });
  assert.equal(scanned.length, 6);

  const result = await dispatch(hostedEarnings, path);
  assert.equal(result.status, 200);
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.deepEqual(JSON.parse(result.body), { earned: '1000000', block: finalized });
  assert.equal(scanned.length, 11);
  assert.deepEqual(scanned.at(-1), [finalized, finalized]);
  await dispatch(hostedEarnings, path);
  assert.equal(scanned.length, 11, 'verified history is shared across lookups');
});

test('preserves contiguous Base history when a concurrent archive query times out', async () => {
  const { createEuroHistory } = await import('./base-yield-history.mjs');
  const firstBlock = 52636355;
  const target = firstBlock + 149999;
  const calls = [];
  const history = createEuroHistory({ persist: false, rpc: async (method, params) => {
    if (method === 'eth_getBlockByNumber') return { number: '0x' + target.toString(16) };
    const from = Number(params[0].fromBlock);
    calls.push(from);
    if (from === firstBlock + 50000) throw new DOMException('Archive request timed out', 'TimeoutError');
    return [];
  } });
  const readPosition = () => assert.fail('cannot reconcile an incomplete history');
  const progress = await history(owner, readPosition, 'https://base-archive.example');
  assert.deepEqual(progress, { through: firstBlock + 49999, target, retryAfter: 6 });
  assert.equal(calls.length, 3);
  assert.deepEqual(await history(owner, readPosition, 'https://base-archive.example'), progress);
  assert.equal(calls.length, 3, 'the retry delay applies across lookups');
});
