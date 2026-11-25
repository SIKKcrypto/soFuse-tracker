import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { serialize } from './history-cache.mjs';
import { calculateEuroYield } from './euro-yield.mjs';

export const euroShares = '0x4f4b212af8b5020399dde325e1bc5b33b53db70b';
export const euroAccountant = '0xdcf7a01e32bff2a15b5b42197f75fba7e1f8be35';
const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const rateTopic = '0xa95bc6aba40bbc4d95fc35f118c4cd8b53fc5d5b89ed264002af03503a7a9439';
const firstBlock = 52636355;
const rangeSize = 50000;
const parallelRanges = 3;
const maxCacheEvents = 50000;
const word = /^0x[0-9a-f]{64}$/i;
const addressTopic = /^0x0{24}[0-9a-f]{40}$/i;
const hash = /^[0-9a-f]{64}$/;
const decimal = /^\d{1,78}$/;

const fingerprint = address => createHash('sha256').update(address.toLowerCase()).digest('hex');
const blockHex = block => '0x' + block.toString(16);

function quantity(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) throw new Error('Invalid Base log location');
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error('Invalid Base log location');
  return result;
}

function decodeLog(log, from, to) {
  const block = quantity(log.blockNumber);
  const index = quantity(log.logIndex);
  if (log.removed || block < from || block > to) throw new Error('Unexpected Base log block');
  const address = log.address?.toLowerCase();
  const [signature, sender, receiver] = log.topics ?? [];
  if (address === euroShares && signature === transferTopic) {
    if (!addressTopic.test(sender) || !addressTopic.test(receiver) || !word.test(log.data)) {
      throw new Error('Invalid soEUR transfer log');
    }
    if (sender === receiver || BigInt(log.data) === 0n) return null;
    return {
      block, index,
      sender: fingerprint('0x' + sender.slice(-40)),
      receiver: fingerprint('0x' + receiver.slice(-40)),
      amount: BigInt(log.data),
    };
  }
  if (address === euroAccountant && signature === rateTopic) {
    if (!/^0x[0-9a-f]{192}$/i.test(log.data)) throw new Error('Invalid Base vault rate log');
    const previousRate = BigInt('0x' + log.data.slice(2, 66));
    const rate = BigInt('0x' + log.data.slice(66, 130));
    if (previousRate <= 0n || rate <= 0n) throw new Error('Invalid Base vault rate');
    return { block, index, previousRate, rate };
  }
  // The RPC's OR topic filter can return either topic for either contract.
  return null;
}

function restoreEvent(event, through) {
  if (!Number.isSafeInteger(event?.block) || event.block < firstBlock || event.block > through ||
      !Number.isSafeInteger(event.index) || event.index < 0) throw new Error('Invalid Base history location');
  const { block, index, sender, receiver, amount, previousRate, rate } = event;
  if (typeof amount === 'string' && decimal.test(amount) && hash.test(sender) && hash.test(receiver)) {
    return { block, index, sender, receiver, amount: BigInt(amount) };
  }
  if (typeof previousRate === 'string' && typeof rate === 'string' && decimal.test(previousRate) && decimal.test(rate)) {
    return { block, index, previousRate: BigInt(previousRate), rate: BigInt(rate) };
  }
  throw new Error('Invalid Base history entry');
}

export function createEuroHistory({ rpc, persist }) {
  const file = resolve(process.env.BASE_YIELD_CACHE_FILE || '.cache/soeurc-yield-history.json');
  let events = [];
  let through = firstBlock - 1;
  let restored;
  let scan;
  let retryAt = 0;
  let finalizedBlock;
  let finalizedUntil = 0;
  let finalizedRequest;

  async function restore() {
    try {
      const data = JSON.parse(await readFile(file, 'utf8'));
      if (data.version !== 1 || !Number.isSafeInteger(data.through) || data.through < firstBlock ||
          !Array.isArray(data.events) || data.events.length > maxCacheEvents) return;
      events = data.events.map(event => restoreEvent(event, data.through));
      through = data.through;
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('Base yield cache could not be read:', error.message);
    }
  }

  async function save() {
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(temporary, serialize({ version: 1, through, events }), { flag: 'wx', mode: 0o600 });
      await rename(temporary, file);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      console.error('Base yield cache could not be saved:', error.message);
    }
  }

  async function finalized() {
    if (Date.now() < finalizedUntil) return finalizedBlock;
    finalizedRequest ??= rpc('eth_getBlockByNumber', ['finalized', false]).then(result => {
      const block = quantity(result.number);
      if (block < firstBlock) throw new Error('Invalid finalized Base block');
      finalizedBlock = block;
      finalizedUntil = Date.now() + 15000;
      return block;
    }).finally(() => { finalizedRequest = undefined; });
    return finalizedRequest;
  }

  async function scanRange(from, to, endpoint) {
    const logs = await rpc('eth_getLogs', [{
      address: [euroShares, euroAccountant],
      topics: [[transferTopic, rateTopic]],
      fromBlock: blockHex(from),
      toBlock: blockHex(to),
    }], endpoint);
    if (!Array.isArray(logs)) throw new Error('Base history returned no logs array');
    const seen = new Set();
    return logs.map(log => decodeLog(log, from, to)).filter(event => {
      if (!event) return false;
      const id = `${event.block}:${event.index}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  async function advance(target, endpoint) {
    const before = through;
    try {
      const batchesPerLookup = persist ? 3 : 2;
      for (let batch = 0; batch < batchesPerLookup && through < target; batch++) {
        const ranges = [];
        let next = through + 1;
        while (ranges.length < parallelRanges && next <= target) {
          const end = Math.min(next + rangeSize - 1, target);
          ranges.push([next, end]);
          next = end + 1;
        }
        const results = await Promise.allSettled(ranges.map(([from, to]) => scanRange(from, to, endpoint)));
        for (const [index, result] of results.entries()) {
          if (result.status === 'rejected') {
            const error = result.reason;
            if (error.name !== 'TimeoutError' && !(error instanceof TypeError) &&
                !/limit reached|Upstream HTTP (?:429|5\d\d)/i.test(error.message)) throw error;
            retryAt = Date.now() + 6000;
            console.warn('Base yield RPC paused at block ' + ranges[index][0] + ': ' + error.message);
            return;
          }
          if (events.length + result.value.length > maxCacheEvents) throw new Error('Base yield history exceeds cache limit');
          events.push(...result.value);
          through = ranges[index][1];
        }
      }
    } finally {
      if (persist && through > before) await save();
    }
  }

  return async (address, readPosition, endpoint) => {
    if (persist) await (restored ??= restore());
    const target = await finalized();
    if (through < target && Date.now() >= retryAt) {
      scan ??= advance(target, endpoint).finally(() => { scan = undefined; });
      await scan;
    }
    if (through < target) return { through, target, retryAfter: Math.max(2, Math.ceil((retryAt - Date.now()) / 1000)) };

    const key = fingerprint(address);
    const transfers = [];
    const updates = [];
    for (const event of events) {
      if (event.block > target) continue;
      if ('rate' in event) updates.push(event);
      else if (event.sender === key || event.receiver === key) {
        transfers.push({ block: event.block, index: event.index, delta: event.receiver === key ? event.amount : -event.amount });
      }
    }
    const { balance, rate } = await readPosition(address, blockHex(target));
    const earned = calculateEuroYield({ balance, rate, transfers, updates });
    if (earned == null) throw new Error('Base yield history could not be reconciled');
    return { earned, block: target };
  };
}
