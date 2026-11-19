import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
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

async function json(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
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

async function transfers(address, token, block) {
  const rows = [];
  let cursor;
  for (let page = 0; page < 40; page++) {
    const query = new URLSearchParams(cursor);
    query.set('token', token);
    const data = await json(explorer + '/api/v2/addresses/' + address + '/token-transfers?' + query);
    if (!Array.isArray(data.items)) throw new Error('Explorer transfer history unavailable');
    for (const item of data.items) {
      if (item.block_number > block || item.token.address_hash.toLowerCase() !== token) continue;
      rows.push({
        hash: item.transaction_hash,
        from: item.from.hash,
        to: item.to.hash,
        value: item.total.value,
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
  const items = [];
  let next;
  do {
    const data = await json(explorer + '/api/v2/transactions/' + hash + '/logs?' + new URLSearchParams(next));
    items.push(...data.items);
    next = data.next_page_params;
  } while (next);
  return items.filter(item => item.decoded).map(item => ({
    contract: item.address.hash.toLowerCase(),
    name: item.decoded.abi.name,
    fields: Object.fromEntries(item.decoded.parameters.map(({ name, value }) => [name, String(value).toLowerCase()])),
  }));
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
  const balance = BigInt(balanceHex);
  const rate = BigInt(rateHex);
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
  const words = result.slice(2).match(/.{64}/g) ?? [];
  if (words.length < 2 || result.length !== 2 + words.length * 64 ||
      BigInt('0x' + words[0]) !== 32n || BigInt('0x' + words[1]) * 3n !== BigInt(words.length - 2)) {
    throw new Error('Unexpected tier lock response');
  }
  const locks = [];
  for (let index = 2; index < words.length; index += 3) {
    locks.push({
      shares: BigInt('0x' + words[index]),
      unlocksAt: Number(BigInt('0x' + words[index + 2])),
    });
  }
  return locks.sort((a, b) => a.unlocksAt - b.unlocksAt);
}

async function cashFlows(address, block) {
  const rows = await transfers(address, shares, block);
  const receipts = new Map();
  const events = hash => {
    if (!receipts.has(hash)) receipts.set(hash, receiptEvents(hash));
    return receipts.get(hash);
  };
  let deposits = 0n;
  let withdrawals = 0n;
  let boosts = 0n;
  let shareDelta = 0n;
  let unclassified = 0;
  let pending = 0;
  const requests = new Map();
  const consumed = new Set();

  for (const row of rows) {
    const amount = BigInt(row.value);
    const incoming = row.to.toLowerCase() === address;
    const outgoing = row.from.toLowerCase() === address;
    if (amount === 0n || incoming === outgoing) continue;
    shareDelta += incoming ? amount : -amount;
    if (incoming && row.from.toLowerCase() === boostSender) {
      boosts += amount;
    } else if (incoming && row.from.toLowerCase() === zero) {
      const log = (await events(row.hash)).find(event =>
        !consumed.has(event) && event.contract === shares && event.name === 'Enter' &&
        event.fields.asset === wrapped && event.fields.to === address && BigInt(event.fields.shares) === amount);
      if (log) {
        deposits += BigInt(log.fields.amount);
        consumed.add(log);
      } else unclassified++;
    } else if (outgoing && row.to.toLowerCase() === queue) {
      const log = (await events(row.hash)).find(event =>
        !consumed.has(event) && event.contract === queue && event.fields.user === address &&
        event.fields.assetOut === wrapped && event.fields.amountOfShares === row.value && event.fields.requestId);
      if (log) {
        requests.set(log.fields.requestId, BigInt(log.fields.amountOfAssets));
        consumed.add(log);
      } else unclassified++;
    } else {
      unclassified++;
    }
  }

  if (requests.size) {
    const payments = await transfers(address, wrapped, block);
    for (const row of payments) {
      if (row.to.toLowerCase() !== address || ![...requests.values()].includes(BigInt(row.value))) continue;
      const log = (await events(row.hash)).find(event =>
        event.contract === queue && event.name === 'OnChainWithdrawSolved' && event.fields.user === address &&
        requests.get(event.fields.requestId) === BigInt(row.value));
      if (log) {
        withdrawals += BigInt(row.value);
        requests.delete(log.fields.requestId);
      }
    }
    pending = requests.size;
  }
  return { deposits, withdrawals, boosts, shareDelta, unclassified, pending };
}

const staticFiles = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/dashboard.js': ['dashboard.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

function send(response, status, type, body) {
  response.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' });
  response.end(body);
}

function sendJson(response, status, body) {
  response.setHeader('Cache-Control', 'no-store');
  send(response, status, 'application/json', serialize(body));
}

createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const file = Object.hasOwn(staticFiles, url.pathname) && staticFiles[url.pathname];
  try {
    if (request.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed.' });
    if (url.pathname === '/api/position') {
      const address = url.searchParams.get('address')?.trim() ?? '';
      if (!addressPattern.test(address) || address.toLowerCase() === zero) {
        return sendJson(response, 400, { error: 'Enter a valid Fuse wallet address.' });
      }
      return sendJson(response, 200, await portfolio(address.toLowerCase()));
    }
    if (file) return send(response, 200, file[1], await readFile(new URL(file[0], import.meta.url)));
    sendJson(response, 404, { error: 'Page not found.' });
  } catch (error) {
    console.error(error.message);
    sendJson(response, 502, { error: 'Fuse data is temporarily unavailable. Try again shortly.' });
  }
}).listen(Number(process.env.PORT ?? 4173), process.env.HOST ?? '127.0.0.1', function () {
  console.log('Listening on ' + this.address().address + ':' + this.address().port);
});
