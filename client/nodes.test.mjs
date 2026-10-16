import assert from "node:assert/strict";
import { test } from "node:test";
import { nodeFinder, Offline } from "./nodes.mjs";

const hosting = (table) => async (url, chain) => {
  if (table[url] === "down") throw new TypeError("Failed to fetch");
  return (table[url] ?? []).includes(chain.join("/"));
};

test("the chosen node is used for a chain it serves, with no search", async () => {
  let searched = 0;
  const nodeFor = nodeFinder({ start: "a", serves: hosting({ a: ["S"] }), find: async () => (searched++, ["b"]) });
  assert.equal(await nodeFor(["S"]), "a");
  assert.equal(searched, 0);
});

test("a chain the chosen node lacks is read from a found node that serves it", async () => {
  const nodeFor = nodeFinder({ start: "a", serves: hosting({ a: ["S"], b: [], c: ["S", "S/bitcoin"], d: "down" }), find: async () => ["d", "b", "c"] });
  assert.equal(await nodeFor(["S", "bitcoin"]), "c", "skips one that is down and one that doesn't serve it");
});

test("a chain no node serves is Offline, and is searched again later", async () => {
  let declared = [];
  const nodeFor = nodeFinder({ start: "a", serves: hosting({ a: [], b: ["S/rust"] }), find: async () => declared });
  await assert.rejects(nodeFor(["S", "rust"]), Offline);
  declared = ["b"];
  assert.equal(await nodeFor(["S", "rust"]), "b");
});

test("an unreachable chosen node is said as such, not as Offline", async () => {
  const nodeFor = nodeFinder({ start: "a", serves: hosting({ a: "down" }), find: async () => ["b"] });
  await assert.rejects(nodeFor(["S"]), TypeError);
});

test("concurrent reads of one chain share one search", async () => {
  let searches = 0;
  const nodeFor = nodeFinder({ start: "a", serves: hosting({ a: [], b: ["S"] }), find: async () => (searches++, ["b"]) });
  assert.deepEqual(await Promise.all([nodeFor(["S"]), nodeFor(["S"])]), ["b", "b"]);
  assert.equal(searches, 1);
});
