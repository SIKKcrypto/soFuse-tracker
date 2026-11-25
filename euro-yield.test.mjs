import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateEuroYield } from './euro-yield.mjs';

test('attributes vault movements only to shares held at each rate update', () => {
  const transfers = Object.freeze([
    { block: 12, index: 2, delta: -40_000_000n },
    { block: 10, index: 3, delta: 100_000_000n },
  ]);
  const updates = Object.freeze([
    { block: 12, index: 5, previousRate: 1_010_000n, rate: 1_020_000n },
    { block: 11, index: 7, previousRate: 1_000_000n, rate: 1_010_000n },
    { block: 10, index: 2, previousRate: 990_000n, rate: 1_000_000n },
  ]);
  assert.equal(calculateEuroYield({ transfers, updates, balance: 60_000_000n, rate: 1_020_000n }), 1_600_000n);
});

test('retains yield after a complete exit and rounds only after summing', () => {
  const transfers = [
    { block: 1, index: 0, delta: 1_500_001n },
    { block: 4, index: 0, delta: -1_500_001n },
  ];
  const updates = [
    { block: 2, index: 0, previousRate: 1_000_000n, rate: 1_000_001n },
    { block: 3, index: 0, previousRate: 1_000_001n, rate: 1_000_002n },
    { block: 5, index: 0, previousRate: 1_000_002n, rate: 990_000n },
  ];
  assert.equal(calculateEuroYield({ transfers, updates, balance: 0n, rate: 990_000n }), 3n);
});

test('returns a signed amount when the vault rate decreases', () => {
  const transfers = [{ block: 1, index: 0, delta: 100_000_000n }];
  const updates = [{ block: 2, index: 0, previousRate: 1_000_000n, rate: 990_000n }];
  assert.equal(calculateEuroYield({ transfers, updates, balance: 100_000_000n, rate: 990_000n }), -1_000_000n);
});

test('rejects incomplete transfer or vault rate histories', () => {
  const transfers = [{ block: 1, index: 1, delta: 1_000_000n }];
  const updates = [{ block: 2, index: 0, previousRate: 1_000_000n, rate: 1_010_000n }];
  const snapshot = { transfers, updates, balance: 1_000_000n, rate: 1_010_000n };

  assert.equal(calculateEuroYield({ ...snapshot, balance: 2_000_000n }), null);
  assert.equal(calculateEuroYield({ ...snapshot, rate: 1_020_000n }), null);
  assert.equal(calculateEuroYield({ ...snapshot, updates: [] }), null);
  assert.equal(calculateEuroYield({
    ...snapshot,
    transfers: [{ block: 1, index: 0, delta: -1_000_000n }, { block: 1, index: 1, delta: 2_000_000n }],
  }), null);
  assert.equal(calculateEuroYield({
    ...snapshot,
    updates: [...updates, { block: 3, index: 0, previousRate: 1_020_000n, rate: 1_010_000n }],
  }), null);
});
