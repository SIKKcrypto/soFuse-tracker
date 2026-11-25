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

const rateHistoryStatus = document.getElementById('rate-history-status');
const rateHistoryContent = document.getElementById('rate-history-content');
const rateHistoryPlot = document.getElementById('rate-history-plot');
const rateHistoryCursor = document.getElementById('rate-history-cursor');
const rateHistoryPeriod = document.getElementById('rate-history-period');
const rateHistoryDate = new Intl.DateTimeFormat('en', {
  year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric',
  minute: '2-digit', second: '2-digit', timeZone: 'UTC', timeZoneName: 'short',
});
const axisDate = new Intl.DateTimeFormat('en', {
  year: '2-digit', month: 'short', day: 'numeric', timeZone: 'UTC',
});
const axisTime = new Intl.DateTimeFormat('en', {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC',
});
const periodPercent = new Intl.NumberFormat('en', {
  style: 'percent', maximumFractionDigits: 3, minimumFractionDigits: 2, signDisplay: 'exceptZero',
});
let rateHistory;
let fullRateHistory;

function selectRateUpdate(index) {
  const point = rateHistory.points[index];
  rateHistoryCursor.value = index;
  const label = format(point.rate, rateHistory.digits) + ' FUSE per soFUSE on ' +
    rateHistoryDate.format(point.timestamp * 1000);
  document.getElementById('rate-history-reading').textContent = label;
  rateHistoryCursor.setAttribute('aria-valuetext', label);
  drawRateHistory();
}

function drawRateHistory() {
  if (!rateHistory) return;
  const context = rateHistoryPlot.getContext('2d');
  const width = rateHistoryPlot.clientWidth;
  const height = rateHistoryPlot.clientHeight;
  if (!context || !width || !height) return;
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  const pixelWidth = Math.round(width * scale);
  const pixelHeight = Math.round(height * scale);
  if (rateHistoryPlot.width !== pixelWidth || rateHistoryPlot.height !== pixelHeight) {
    rateHistoryPlot.width = pixelWidth;
    rateHistoryPlot.height = pixelHeight;
  }
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, width, height);
  context.font = '12px system-ui, sans-serif';

  const { points, low, high, digits } = rateHistory;
  const pad = Math.max((high - low) * 0.08, high * 0.000001, 1e-9);
  const minimum = Math.max(low - pad, 0);
  const range = high + pad - minimum;
  const ticks = Array.from({ length: 5 }, (_, index) => {
    const value = minimum + index * range / 4;
    return { value, label: value.toFixed(digits) };
  });
  const firstTime = points[0].timestamp;
  const lastTime = points.at(-1).timestamp;
  const duration = lastTime - firstTime;
  const left = Math.ceil(Math.max(...ticks.map(tick => context.measureText(tick.label).width))) + 10;
  const right = width - 8;
  const top = 12;
  const bottom = height - 28;
  const pointX = time => duration ? left + (time - firstTime) / duration * (right - left) : (left + right) / 2;
  const pointY = value => bottom - (value - minimum) / range * (bottom - top);
  const theme = getComputedStyle(rateHistoryPlot);
  const muted = theme.getPropertyValue('--muted').trim();
  const border = theme.getPropertyValue('--border').trim();
  const accent = theme.getPropertyValue('--accent').trim();
  rateHistory.plot = { left, right, firstTime, duration };

  context.strokeStyle = border;
  context.fillStyle = muted;
  context.textAlign = 'right';
  context.textBaseline = 'middle';
  for (const tick of ticks) {
    const y = pointY(tick.value);
    context.beginPath();
    context.moveTo(left, y);
    context.lineTo(right, y);
    context.stroke();
    context.fillText(tick.label, left - 7, y);
  }
  context.textBaseline = 'top';
  const dateAxis = duration < 2 * 86400 ? axisTime : axisDate;
  const labelSegments = width >= 520 ? 3 : 1;
  for (let index = 0; index <= labelSegments; index++) {
    if (!duration && index > 0) break;
    const time = firstTime + duration * index / labelSegments;
    context.textAlign = !duration ? 'center' : index === 0 ? 'left' : index === labelSegments ? 'right' : 'center';
    context.fillText(dateAxis.format(time * 1000), pointX(time), bottom + 10);
  }

  context.strokeStyle = accent;
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(pointX(firstTime), pointY(points[0].value));
  for (let index = 1; index < points.length; index++) {
    const x = pointX(points[index].timestamp);
    context.lineTo(x, pointY(points[index - 1].value));
    context.lineTo(x, pointY(points[index].value));
  }
  context.stroke();

  const selected = points[Number(rateHistoryCursor.value)];
  const x = pointX(selected.timestamp);
  const y = pointY(selected.value);
  context.lineWidth = 1;
  context.setLineDash([3, 4]);
  context.beginPath();
  context.moveTo(x, y);
  context.lineTo(x, bottom);
  context.stroke();
  context.setLineDash([]);
  context.fillStyle = accent;
  context.beginPath();
  context.arc(x, y, 4, 0, 2 * Math.PI);
  context.fill();
}

function inspectRateAtPointer(event) {
  if (!rateHistory?.plot) return;
  const { left, right, firstTime, duration } = rateHistory.plot;
  const x = event.clientX - rateHistoryPlot.getBoundingClientRect().left;
  const time = firstTime + Math.max(0, Math.min(1, (x - left) / (right - left))) * duration;
  const points = rateHistory.points;
  let first = 0;
  let last = points.length;
  while (first < last) {
    const middle = Math.floor((first + last) / 2);
    if (points[middle].timestamp <= time) first = middle + 1;
    else last = middle;
  }
  const index = Math.max(0, first - 1);
  if (index !== Number(rateHistoryCursor.value)) selectRateUpdate(index);
}

function ratePeriodStart(period, latestTimestamp) {
  if (period === 'all') return -Infinity;
  if (period === '7' || period === '30') return latestTimestamp - Number(period) * 86400;

  const date = new Date(latestTimestamp * 1000);
  if (period === 'ytd') return Date.UTC(date.getUTCFullYear(), 0, 1) / 1000;

  // Move to the target month before restoring the day so shorter months don't roll over.
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - (period === '6m' ? 6 : 12));
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.getTime() / 1000;
}

function showRateHistory() {
  const { updates, stale } = fullRateHistory;
  const latest = updates.at(-1);
  const start = ratePeriodStart(rateHistoryPeriod.value, latest.timestamp);
  const points = updates.filter(point => point.timestamp >= start);
  let lowest = points[0];
  let highest = lowest;
  for (const point of points) {
    if (point.value < lowest.value) lowest = point;
    if (point.value > highest.value) highest = point;
  }
  const spread = highest.value - lowest.value;
  const digits = Math.max(6, Math.min(9, spread ? Math.ceil(-Math.log10(spread / 4)) : 6));
  rateHistory = { points, digits, low: lowest.value, high: highest.value };
  document.getElementById('rate-history-latest').textContent = format(latest.rate, digits);
  document.getElementById('rate-history-low').textContent = format(lowest.rate, digits);
  document.getElementById('rate-history-high').textContent = format(highest.rate, digits);
  const change = (latest.value - points[0].value) / points[0].value;
  const changeLabel = document.getElementById('rate-history-change');
  changeLabel.textContent = points.length > 1 ? periodPercent.format(change) : '—';
  changeLabel.dataset.tone = change > 0 ? 'positive' : change < 0 ? 'negative' : '';
  rateHistoryCursor.max = points.length - 1;
  rateHistoryCursor.hidden = points.length === 1;
  document.getElementById('rate-history-label').hidden = points.length === 1;
  rateHistoryStatus.textContent = stale
    ? 'Showing saved rate history. The latest updates are temporarily unavailable.'
    : points.length === 1 ? 'Only one vault rate update is available in this period.' : '';
  document.getElementById('rate-history-period-control').hidden = updates.length === 1;
  rateHistoryContent.hidden = false;
  selectRateUpdate(points.length - 1);
}

async function loadRateHistory() {
  try {
    const response = await fetch('/api/rate-history', { signal: AbortSignal.timeout(25000) });
    if (!response.ok) throw new Error('Rate history request failed');
    const data = await response.json();
    const updates = data.points.map(({ timestamp, rate }) => {
      if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 8640000000000 ||
          typeof rate !== 'string' || !/^[0-9]{1,78}$/.test(rate) || BigInt(rate) <= 0n) {
        throw new Error('Invalid rate update');
      }
      return { timestamp, rate, value: Number(rate) / 1e18 };
    }).sort((a, b) => a.timestamp - b.timestamp);
    if (!updates.length) {
      rateHistoryStatus.textContent = 'No vault rate updates are available yet.';
      return;
    }
    fullRateHistory = { updates, stale: data.stale };
    showRateHistory();
  } catch {
    rateHistoryStatus.textContent = 'Vault rate history is temporarily unavailable.';
  }
}

rateHistoryCursor.addEventListener('input', () => selectRateUpdate(Number(rateHistoryCursor.value)));
rateHistoryPeriod.addEventListener('change', showRateHistory);
rateHistoryPlot.addEventListener('pointerdown', inspectRateAtPointer);
rateHistoryPlot.addEventListener('pointermove', event => {
  if (event.pointerType === 'mouse') inspectRateAtPointer(event);
});
new ResizeObserver(drawRateHistory).observe(rateHistoryPlot);
loadRateHistory();
