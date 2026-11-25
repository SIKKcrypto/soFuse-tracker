const euroUnit = 1_000_000n;

export function calculateEuroYield({ transfers, updates, balance, rate }) {
  const events = [...transfers, ...updates].sort((a, b) => a.block - b.block || a.index - b.index);
  let shares = 0n;
  let earned = 0n;
  let currentRate;

  for (const event of events) {
    if ('delta' in event) {
      shares += event.delta;
      if (shares < 0n) return null;
    } else {
      if (currentRate !== undefined && currentRate !== event.previousRate) return null;
      // Keep the full product of the two six-decimal values until the final conversion.
      earned += shares * (event.rate - event.previousRate);
      currentRate = event.rate;
    }
  }

  if (shares !== balance || currentRate !== rate) return null;
  return earned / euroUnit;
}
