const form = document.getElementById('lookup');
const input = document.getElementById('address');
const button = form.querySelector('button');
const status = document.getElementById('status');
const position = document.getElementById('position');
const coverage = document.getElementById('coverage');
const addressPattern = /^0x[0-9a-f]{40}$/i;
let activeRequest;

function format(raw, digits = 2) {
  const value = BigInt(raw);
  const magnitude = value < 0n ? -value : value;
  const divisor = 10n ** BigInt(18 - digits);
  const scale = 10n ** BigInt(digits);
  const rounded = (magnitude + divisor / 2n) / divisor;
  const fraction = (rounded % scale).toString().padStart(digits, '0');
  return (value < 0n ? '−' : '') + (rounded / scale).toLocaleString() + '.' + fraction;
}

function show(data, address) {
  const fields = {
    value: format(data.value),
    balance: format(data.balance, 4),
    gain: data.netGain == null ? '—' : (BigInt(data.netGain) > 0n ? '+' : '') + format(data.netGain),
    rate: format(data.rate, 9),
    deposits: data.historyAvailable ? format(data.deposits) + ' FUSE' : '—',
    withdrawals: data.historyAvailable ? format(data.withdrawals) + ' FUSE' : '—',
    boosts: data.historyAvailable ? format(data.boosts, 4) + ' soFUSE' : '—',
    'total-value': data.lockedValue == null ? '—' : format(BigInt(data.value) + BigInt(data.lockedValue)) + ' FUSE',
    block: 'Fuse block ' + data.block.toLocaleString(),
  };
  for (const [id, text] of Object.entries(fields)) document.getElementById(id).textContent = text;
  document.getElementById('gain-unit').hidden = data.netGain == null;
  document.getElementById('explorer').href = 'https://explorer.fuse.io/address/' + address;

  const notes = [];
  if (!data.historyAvailable) notes.push('Wallet history is temporarily unavailable.');
  if (data.historyStale) notes.push('Showing history through Fuse block ' + data.historyBlock.toLocaleString() + '. Net gain is unavailable until history reconciles.');
  if (data.unclassified) notes.push('Some share movements could not be classified. Cash-flow totals reflect verified activity.');
  if (data.pending) notes.push('At least one withdrawal request has no verified settlement.');
  coverage.textContent = notes.join(' ');
  coverage.hidden = !notes.length;
  showLocks(data);
  position.hidden = false;
}

function showLocks(data) {
  const section = document.getElementById('tier-locks');
  const summary = document.getElementById('lock-position');
  const note = document.getElementById('lock-status');
  const dates = document.getElementById('lock-dates');
  section.hidden = data.locks?.length === 0;
  summary.hidden = data.locks == null;
  note.hidden = data.locks != null;
  note.textContent = data.locks == null ? 'Tier lock data is temporarily unavailable.' : '';
  dates.replaceChildren();
  if (!data.locks?.length) return;

  document.getElementById('locked-value').textContent = format(data.lockedValue);
  document.getElementById('locked-shares').textContent = format(data.lockedShares, 4);
  const dateFormat = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium', timeStyle: 'short',
  });
  for (const lock of data.locks) {
    const row = document.createElement('div');
    const date = document.createElement('dt');
    const amount = document.createElement('dd');
    const unlock = new Date(lock.unlocksAt * 1000);
    date.textContent = (unlock <= new Date() ? 'Unlocked ' : 'Unlocks ') + dateFormat.format(unlock);
    amount.textContent = format(lock.shares, 4) + ' soFUSE';
    row.append(date, amount);
    dates.append(row);
  }
}

async function lookup(address) {
  activeRequest?.abort();
  const request = new AbortController();
  activeRequest = request;
  position.hidden = true;
  if (!addressPattern.test(address)) {
    status.textContent = 'Enter a valid 0x wallet address.';
    button.disabled = false;
    return;
  }
  status.textContent = 'Looking up soFUSE position…';
  button.disabled = true;
  try {
    const response = await fetch('/api/position?' + new URLSearchParams({ address }), { signal: request.signal });
    const data = await response.json();
    if (request.signal.aborted) return;
    if (!response.ok) throw new Error(data.error);
    show(data, address);
    status.textContent = BigInt(data.balance) === 0n && data.locks?.length === 0
      ? 'This wallet holds no soFUSE.' : '';
    const url = new URL(location.href);
    url.searchParams.set('address', address);
    history.replaceState(null, '', url);
  } catch (error) {
    if (!request.signal.aborted) status.textContent = error.message || 'Lookup failed. Please try again.';
  } finally {
    if (!request.signal.aborted) button.disabled = false;
  }
}

form.addEventListener('submit', event => {
  event.preventDefault();
  lookup(input.value.trim());
});

const initial = new URLSearchParams(location.search).get('address');
if (initial) {
  input.value = initial;
  lookup(initial.trim());
}
