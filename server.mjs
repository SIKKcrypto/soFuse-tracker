import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { serialize, walletHistory } from './history-cache.mjs';

const explorer = 'https://explorer.fuse.io';
const shares = '0xb33c8f0b0816fd147fcf896c594a3ef408845e2c';
const wrapped = '0x0be9e53fd7edac9f859882afdda116645287c629';
const accountant = '0xb29b5f760d38587f7f4c896c458b9eeb5cad9c0c';
const tierLocker = '0x7c8e58c63a11ea74d3986d5cac1e820ef87c6584';
const queue = '0x8a6612ff8ba43c4c8a1e7dd5c0ee2d7cbedf0e66';
const boostSender = '0x521b8d0934b813737ffe19cbc7de810f02b5d9e1';
const zero = '0x' + '0'.repeat(40);
const unit = 10n ** 18n;
const addressPattern = /^0x[0-9a-f]{40}$/i;
const wordPattern = /^0x[0-9a-f]{64}$/i;
const enterTopic = '0xea00f88768a86184a6e515238a549c171769fe7460a011d6fd0bcd48ca078ea4';
const requestedTopic = '0x2eb08ebdb4d68b4a37e3b424927f3363e1d799ca7e56e7b2c59cc6c1778d33f5';
const cancelledTopic = '0x114ef421aef557f2e4086396789e7fb532b1133ff2982c9d948daa73d0691e36';
const solvedTopic = '0xd94fc49a6578873ff851671d19cacb1809887f7a9128867ee4306dc3ffc93c26';

async function json(url, options) {
  const timeout = AbortSignal.timeout(10000);
  const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await fetch(url, { ...options, signal });
  if (!response.ok) throw new Error('Upstream HTTP ' + response.status);
  return response.json();
}

async function rpc(method, params) {
  const data = await json('https://rpc.fuse.io', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!data.result || data.error) throw new Error('Fuse RPC: ' + (data.error?.message ?? 'no result'));
  return data.result;
}

async function transfers(address, token, block, signal) {
  const rows = [];
  const seen = new Set();
  let cursor;
  for (let page = 0; page < 40; page++) {
    const query = new URLSearchParams(cursor);
    query.set('token', token);
    const data = await json(explorer + '/api/v2/addresses/' + address + '/token-transfers?' + query, { signal });
    if (!Array.isArray(data.items)) throw new Error('Explorer transfer history unavailable');
    for (const item of data.items) {
      if (!Number.isSafeInteger(item.block_number) || item.block_number > block ||
          item.token.address_hash.toLowerCase() !== token) continue;
      if (!wordPattern.test(item.transaction_hash) || !Number.isSafeInteger(item.log_index) ||
          !addressPattern.test(item.from.hash) || !addressPattern.test(item.to.hash) ||
          !/^\d+$/.test(item.total.value)) throw new Error('Invalid explorer transfer');
      const key = item.transaction_hash + ':' + item.log_index;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        hash: item.transaction_hash,
        from: item.from.hash.toLowerCase(),
        to: item.to.hash.toLowerCase(),
        value: BigInt(item.total.value),
      });
    }
    cursor = data.next_page_params;
    if (!cursor) return rows.reverse();
  }
  throw new Error('Explorer transfer history exceeded lookup limit');
}

const receiptCache = new Map();

function receiptEvents(hash) {
  const cached = receiptCache.get(hash);
  if (cached && cached.expiresAt > Date.now()) return cached.events;
  const events = loadReceiptEvents(hash).catch(error => {
    if (receiptCache.get(hash)?.events === events) receiptCache.delete(hash);
    throw error;
  });
  receiptCache.delete(hash);
  receiptCache.set(hash, { events, expiresAt: Date.now() + 86400000 });
  if (receiptCache.size > 1500) receiptCache.delete(receiptCache.keys().next().value);
  return events;
}

async function loadReceiptEvents(hash) {
  const events = [];
  const signal = AbortSignal.timeout(10000);
  let next;
  for (let page = 0; page < 10; page++) {
    const data = await json(explorer + '/api/v2/transactions/' + hash + '/logs?' + new URLSearchParams(next), { signal });
    if (!Array.isArray(data.items)) throw new Error('Explorer receipt unavailable');
    for (const item of data.items) {
      const event = parseReceiptEvent(item);
      if (event) events.push(event);
    }
    next = data.next_page_params;
    if (!next) return events;
  }
  throw new Error('Explorer receipt exceeded lookup limit');
}

function parseReceiptEvent(item) {
  const contract = item.address.hash.toLowerCase();
  const [signature, first, second, third] = item.topics;
  const topicAddress = topic => {
    if (!wordPattern.test(topic)) throw new Error('Invalid receipt topic');
    return '0x' + topic.slice(-40).toLowerCase();
  };
  const word = index => {
    const field = '0x' + item.data.slice(2 + index * 64, 66 + index * 64);
    return readUint(field);
  };
  if (contract === shares && signature === enterTopic) {
    // Enter(address indexed from, address indexed asset, uint256 amount, address indexed to, uint256 shares).
    return { kind: 'deposit', asset: topicAddress(second), user: topicAddress(third), assets: word(0), shares: word(1) };
  }
  if (contract !== queue || !wordPattern.test(first)) return;
  if (signature === requestedTopic) {
    return { kind: 'request', id: first, user: topicAddress(second), asset: topicAddress(third), shares: word(1), assets: word(2) };
  }
  if (signature === cancelledTopic || signature === solvedTopic) {
    return { kind: signature === cancelledTopic ? 'cancel' : 'solve', id: first, user: topicAddress(second) };
  }
}

function readUint(value) {
  if (!wordPattern.test(value)) throw new Error('Invalid contract return value');
  return BigInt(value);
}

async function portfolio(address) {
  const block = await rpc('eth_blockNumber', []);
  const addressWord = address.slice(2).padStart(64, '0');
  const [balanceHex, rateHex, locks] = await Promise.all([
    rpc('eth_call', [{ to: shares, data: '0x70a08231' + addressWord }, block]),
    rpc('eth_call', [{ to: accountant, data: '0x679aefce' }, block]),
    readLocks(addressWord, block).catch(error => {
      console.error('Solid tier locks: ' + error.message);
      return null;
    }),
  ]);
  const balance = readUint(balanceHex);
  const rate = readUint(rateHex);
  if (rate === 0n) throw new Error('Fuse accountant returned a zero rate');
  const value = balance * rate / unit;
  const lockedShares = locks?.reduce((total, lock) => total + lock.shares, 0n);
  const lockedValue = lockedShares == null ? null : lockedShares * rate / unit;
  const current = { block: Number(block), balance, rate, value, locks, lockedShares, lockedValue };
  const history = await walletHistory(address, Number(block), balance, () => cashFlows(address, Number(block)));
  const { shareDelta, ...summary } = history;
  const netGain = history.historyAvailable && !history.historyStale && !history.unclassified && !history.pending
    ? value + BigInt(history.withdrawals) - BigInt(history.deposits) : null;
  return { ...current, ...summary, netGain };
}

async function readLocks(addressWord, block) {
  // SolidTierLock.getLocks(address) returns (shares, lockedAt, unlocksAt)[].
  const result = await rpc('eth_call', [{ to: tierLocker, data: '0x719f3089' + addressWord }, block]);
  if (!/^0x[0-9a-f]+$/i.test(result)) throw new Error('Invalid tier lock response');
  const words = result.slice(2).match(/.{64}/g) ?? [];
  if (words.length < 2 || result.length !== 2 + words.length * 64 ||
      BigInt('0x' + words[0]) !== 32n || BigInt('0x' + words[1]) * 3n !== BigInt(words.length - 2)) {
    throw new Error('Unexpected tier lock response');
  }
  const locks = [];
  for (let index = 2; index < words.length; index += 3) {
    const unlocksAt = Number(BigInt('0x' + words[index + 2]));
    if (unlocksAt > 8640000000000) throw new Error('Invalid lock expiry');
    locks.push({
      shares: BigInt('0x' + words[index]),
      unlocksAt,
    });
  }
  return locks.sort((a, b) => a.unlocksAt - b.unlocksAt);
}

async function cashFlows(address, block) {
  const signal = AbortSignal.timeout(25000);
  const rows = await transfers(address, shares, block, signal);
  const events = async hash => {
    signal.throwIfAborted();
    let onAbort;
    const deadline = new Promise((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      // Another lookup can still use the shared receipt if this scan times out.
      return await Promise.race([receiptEvents(hash), deadline]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  };
  let deposits = 0n;
  let withdrawals = 0n;
  let boosts = 0n;
  let shareDelta = 0n;
  let unclassified = 0;
  const requests = new Map();
  const consumed = new Set();

  for (const row of rows) {
    const amount = row.value;
    const incoming = row.to === address;
    const outgoing = row.from === address;
    if (amount === 0n || incoming === outgoing) continue;
    shareDelta += incoming ? amount : -amount;
    if (incoming && row.from === boostSender) {
      boosts += amount;
    } else if (incoming && row.from === zero) {
      const log = (await events(row.hash)).find(event =>
        !consumed.has(event) && event.kind === 'deposit' && event.asset === wrapped &&
        event.user === address && event.shares === amount && event.assets > 0n);
      if (log) {
        deposits += log.assets;
        consumed.add(log);
      } else unclassified++;
    } else if (outgoing && row.to === queue) {
      const log = (await events(row.hash)).find(event =>
        !consumed.has(event) && event.kind === 'request' && event.user === address &&
        event.asset === wrapped && event.shares === amount);
      if (log) {
        requests.set(log.id, log);
        consumed.add(log);
      } else unclassified++;
    } else if (incoming && row.from === queue) {
      const log = (await events(row.hash)).find(event =>
        !consumed.has(event) && event.kind === 'cancel' && event.user === address &&
        requests.get(event.id)?.shares === amount);
      if (log) {
        requests.delete(log.id);
        consumed.add(log);
      } else unclassified++;
    } else {
      unclassified++;
    }
  }

  if (requests.size) {
    const payments = await transfers(address, wrapped, block, signal);
    const amounts = new Set([...requests.values()].map(request => request.assets));
    for (const row of payments) {
      if (row.to !== address || row.from === address || !amounts.has(row.value)) continue;
      const log = (await events(row.hash)).find(event =>
        event.kind === 'solve' && event.user === address && requests.get(event.id)?.assets === row.value);
      if (log) {
        withdrawals += row.value;
        requests.delete(log.id);
      }
      if (requests.size === 0) break;
    }
  }
  return { deposits, withdrawals, boosts, shareDelta, unclassified, pending: requests.size };
}

const staticFiles = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/dashboard.js': ['dashboard.js', 'text/javascript; charset=utf-8'],
  '/pwa.js': ['pwa.js', 'text/javascript; charset=utf-8'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
};

function send(response, status, type, body) {
  response.writeHead(status, {
    'Content-Type': type,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  });
  response.end(body);
}

function sendJson(response, status, body) {
  response.setHeader('Cache-Control', 'no-store');
  send(response, status, 'application/json', serialize(body));
}

export function createTrackerServer() {
  const activeLookups = new Map();
  return createServer({ headersTimeout: 10000, requestTimeout: 15000 }, async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const file = Object.hasOwn(staticFiles, url.pathname) && staticFiles[url.pathname];
      if (request.method !== 'GET' && !(request.method === 'HEAD' && file)) {
        response.setHeader('Allow', file ? 'GET, HEAD' : 'GET');
        return sendJson(response, 405, { error: 'Method not allowed.' });
      }
      if (url.pathname === '/api/position') {
        const address = (url.searchParams.get('address')?.trim() ?? '').toLowerCase();
        if (!addressPattern.test(address) || address === zero) {
          return sendJson(response, 400, { error: 'Enter a valid Fuse wallet address.' });
        }
        let lookup = activeLookups.get(address);
        if (!lookup) {
          if (activeLookups.size >= 8) {
            response.setHeader('Retry-After', '5');
            return sendJson(response, 503, { error: 'The tracker is busy. Try again in a few seconds.' });
          }
          lookup = portfolio(address).finally(() => activeLookups.delete(address));
          activeLookups.set(address, lookup);
        }
        return sendJson(response, 200, await lookup);
      }
      if (file) {
        if (url.pathname === '/sw.js') response.setHeader('Cache-Control', 'no-cache');
        return send(response, 200, file[1], await readFile(new URL(file[0], import.meta.url)));
      }
      sendJson(response, 404, { error: 'Page not found.' });
    } catch (error) {
      console.error(error.message);
      sendJson(response, 502, { error: 'Fuse data is temporarily unavailable. Try again shortly.' });
    }
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  createTrackerServer().listen(Number(process.env.PORT ?? 4173), process.env.HOST ?? '127.0.0.1', function () {
    console.log('Listening on ' + this.address().address + ':' + this.address().port);
  });
}
