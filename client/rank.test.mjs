//   node --test client/
import assert from "node:assert/strict";
import { test } from "node:test";
import { hot, rank } from "./rank.mjs";

// Reddit's epoch for hot, in milliseconds.
const EPOCH = 1134028003 * 1000;
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} ≉ ${expected}`);

test("hot: a tenfold score is worth 12.5 hours", () => {
  close(hot({ ups: 1, downs: 0, time: EPOCH }), 0);
  close(hot({ ups: 10, downs: 0, time: EPOCH }), 1);
  close(hot({ ups: 1, downs: 0, time: EPOCH + 45000 * 1000 }), 1);
  close(hot({ ups: 0, downs: 10, time: EPOCH }), -1);
  close(hot({ ups: 3, downs: 3, time: EPOCH + 90000 * 1000 }), 2);
});

test("rank orders by each sort, ties to the newer", () => {
  const items = [
    { name: "old-big", ups: 100, downs: 0, time: EPOCH },
    { name: "new-small", ups: 2, downs: 0, time: EPOCH + 2 * 45000 * 1000 + 1 },
    { name: "split", ups: 50, downs: 49, time: EPOCH + 1 },
  ];
  const names = (by, options) => rank(items, by, options).map((item) => item.name);
  assert.deepEqual(names("hot"), ["new-small", "old-big", "split"]);
  assert.deepEqual(names("new"), ["new-small", "split", "old-big"]);
  assert.deepEqual(names("top"), ["old-big", "new-small", "split"]);
  assert.deepEqual(names("top", { since: EPOCH + 1 }), ["new-small", "split"]);
  assert.throws(() => rank(items, "random"), RangeError);
});
