const form = document.getElementById('lookup');
const input = document.getElementById('address');
const button = document.getElementById('submit');
const status = document.getElementById('status');
const position = document.getElementById('position');
const coverage = document.getElementById('coverage');
const addressPattern = /^0x[0-9a-f]{40}$/i;
const zeroAddress = '0x' + '0'.repeat(40);
const integerFormat = new Intl.NumberFormat('en');
const dateFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });
const lookupError = 'The wallet lookup is temporarily unavailable. Try again in a moment.';
let activeRequest;
let shownAddress;

function format(raw, digits = 2, signed = false) {
  const value = BigInt(raw);
  const magnitude = value < 0n ? -value : value;
  const divisor = 10n ** BigInt(18 - digits);
  const scale = 10n ** BigInt(digits);
  const rounded = (magnitude + divisor / 2n) / divisor;
  const fraction = (rounded % scale).toString().padStart(digits, '0');
  const sign = rounded && (value < 0n ? '−' : signed ? '+' : '');
  return (sign || '') + integerFormat.format(rounded / scale) + '.' + fraction;
}

function setStatus(message, kind = '') {
  status.dataset.kind = kind;
  status.textContent = message;
}

function show(data, address) {
  const fields = {
    'shown-address': address,
    value: format(data.value),
    balance: format(data.balance, 4),
    gain: data.netGain == null ? '—' : format(data.netGain, 2, true),
    'gain-detail': data.netGain == null ? 'Requires reconciled wallet history' : 'Includes recognized yield boosts',
    rate: format(data.rate, 9),
    deposits: data.historyAvailable ? format(data.deposits) + ' FUSE' : '—',
    withdrawals: data.historyAvailable ? format(data.withdrawals) + ' FUSE' : '—',
    boosts: data.historyAvailable ? format(data.boosts, 4) + ' soFUSE' : '—',
    'total-value': data.lockedValue == null ? '—' : format(BigInt(data.value) + BigInt(data.lockedValue)) + ' FUSE',
    block: 'Fuse block ' + integerFormat.format(data.block),
  };
  for (const [id, text] of Object.entries(fields)) document.getElementById(id).textContent = text;
  document.getElementById('gain-unit').hidden = data.netGain == null;
  document.getElementById('gain').dataset.tone = fields.gain.startsWith('+') ? 'positive' :
    fields.gain.startsWith('−') ? 'negative' : '';
  document.getElementById('explorer').href = 'https://explorer.fuse.io/address/' + address;

  const historyBlock = document.getElementById('history-block');
  historyBlock.hidden = data.historyBlock == null || data.historyBlock === data.block;
  historyBlock.textContent = historyBlock.hidden ? '' : 'History block ' + integerFormat.format(data.historyBlock);

  const notes = [];
  if (!data.historyAvailable) notes.push('Wallet history is temporarily unavailable.');
  if (data.historyStale) notes.push('Wallet history is out of date or could not be reconciled. Net gain is unavailable.');
  if (data.unclassified) notes.push('Some share movements could not be classified. Cash-flow totals reflect verified activity.');
  if (data.pending) notes.push('A withdrawal request is awaiting verified settlement.');
  coverage.textContent = notes.join(' ');
  coverage.hidden = !notes.length;
  showLocks(data);
  position.hidden = false;
}

function showLocks(data) {
  const summary = document.getElementById('lock-position');
  const note = document.getElementById('lock-status');
  const dates = document.getElementById('lock-dates');
  const hasLocks = Boolean(data.locks?.length);
  summary.hidden = !hasLocks;
  note.hidden = hasLocks;
  note.textContent = data.locks == null ? 'Tier lock data is temporarily unavailable.' : 'This wallet has no tier locks.';
  dates.replaceChildren();
  if (!hasLocks) return;

  document.getElementById('locked-value').textContent = format(data.lockedValue);
  document.getElementById('locked-shares').textContent = format(data.lockedShares, 4);
  for (const lock of data.locks) {
    const row = document.createElement('div');
    const date = document.createElement('dt');
    const time = document.createElement('time');
    const amount = document.createElement('dd');
    const unlock = new Date(lock.unlocksAt * 1000);
    time.dateTime = unlock.toISOString();
    time.textContent = dateFormat.format(unlock);
    date.append(unlock.getTime() <= Date.now() ? 'Available since ' : 'Unlocks ', time);
    amount.textContent = format(lock.shares, 4) + ' soFUSE';
    row.append(date, amount);
    dates.append(row);
  }
}

async function lookup(address) {
  activeRequest?.abort();
  const refreshing = !position.hidden && shownAddress === address.toLowerCase();
  if (!addressPattern.test(address) || address.toLowerCase() === zeroAddress) {
    activeRequest = undefined;
    input.setAttribute('aria-invalid', 'true');
    input.focus();
    setStatus('Enter a Fuse wallet address beginning with 0x and followed by 40 hexadecimal characters.', 'error');
    position.removeAttribute('aria-busy');
    updateButton();
    button.disabled = false;
    return;
  }
  input.removeAttribute('aria-invalid');
  const request = new AbortController();
  activeRequest = request;
  position.hidden = !refreshing;
  position.setAttribute('aria-busy', 'true');
  setStatus(refreshing ? 'Refreshing wallet position…' : 'Looking up wallet position…', 'loading');
  button.disabled = true;
  try {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(45000)]);
    const response = await fetch('/api/position?' + new URLSearchParams({ address }), { signal });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      throw new Error(typeof data?.error === 'string' ? data.error : lookupError);
    }
    const data = await response.json();
    if (request.signal.aborted) return;
    show(data, address);
    shownAddress = address.toLowerCase();
    if (BigInt(data.balance) === 0n && data.locks?.length === 0) {
      setStatus('This wallet currently holds no liquid or locked soFUSE.');
    } else {
      setStatus('Wallet position loaded.', 'success');
    }
    const url = new URL(location.href);
    url.searchParams.set('address', address);
    history.replaceState(null, '', url);
  } catch (error) {
    if (!request.signal.aborted) {
      const message = error instanceof TypeError || error instanceof SyntaxError || error.name === 'TimeoutError'
        ? lookupError : error.message || lookupError;
      setStatus(refreshing ? message + ' Showing the last result.' : message, 'error');
    }
  } finally {
    if (activeRequest === request) {
      activeRequest = undefined;
      position.removeAttribute('aria-busy');
      button.disabled = false;
      updateButton();
    }
  }
}

function updateButton() {
  button.textContent = !position.hidden && shownAddress === input.value.trim().toLowerCase()
    ? 'Refresh' : 'Look up';
}

input.addEventListener('input', () => {
  input.removeAttribute('aria-invalid');
  if (activeRequest) {
    activeRequest.abort();
    activeRequest = undefined;
    position.removeAttribute('aria-busy');
    button.disabled = false;
  }
  setStatus('');
  updateButton();
});

form.addEventListener('submit', event => {
  event.preventDefault();
  lookup(input.value.trim());
});

const initial = new URLSearchParams(location.search).get('address');
if (initial) {
  input.value = initial;
  lookup(initial.trim());
}
