import assert from "node:assert/strict";
import { test } from "node:test";
import { nodeFinder, Offline } from "./nodes.mjs";

const hosting = (table) => async (url, chain) => {
  if (table[url] === "down") throw new TypeError("Failed to fetch");
  if (table[url] === "busy") throw Object.assign(new Error("HTTP 503"), { status: 503 });
  return (table[url] ?? []).includes(chain.join("/"));
};
const declared = (...urls) => async () => urls.map((url) => ({ url, committedBlock: `c-${url}` }));

test("the chosen node is used for a chain it serves, with no search", async () => {
  let searched = 0;
  const nodeFor = nodeFinder({ start: "a", serves: hosting({ a: ["S"] }), find: async () => (searched++, []) });
  assert.deepEqual(await nodeFor(["S"]), { url: "a" });
  assert.equal(searched, 0);
});

test("a chain the chosen node lacks is read from a found node that serves it, anchored at the committed block", async () => {
  const nodeFor = nodeFinder({ start: "a", serves: hosting({ a: ["S"], b: [], c: ["S", "S/bitcoin"], d: "down" }), find: declared("d", "b", "c") });
  assert.deepEqual(await nodeFor(["S", "bitcoin"]), { url: "c", block: "c-c" }, "skips one that is down and one that doesn't serve it");
});

test("a chain no node serves is Offline, and is searched again later", async () => {
  let urls = [];
  const nodeFor = nodeFinder({ start: "a", serves: hosting({ a: ["S"], b: ["S/rust"] }), find: async () => urls.map((url) => ({ url, committedBlock: "k" })) });
  await assert.rejects(nodeFor(["S", "rust"]), Offline);
  urls = ["b"];
  assert.equal((await nodeFor(["S", "rust"])).url, "b");
});

test("a chosen node that is down or failing is said as such: no search, not Offline", async () => {
  let searched = 0;
  const find = async () => (searched++, [{ url: "b" }]);
  await assert.rejects(nodeFinder({ start: "a", serves: hosting({ a: "down", b: ["S"] }), find })(["S"]), TypeError);
  await assert.rejects(nodeFinder({ start: "a", serves: hosting({ a: "busy", b: ["S"] }), find })(["S"]), { status: 503 });
  assert.equal(searched, 0);
});

test("concurrent reads share one search; a found node is searched again when forgotten or after ttl", async () => {
  let searches = 0, clock = 0;
  const nodeFor = nodeFinder({ start: "a", serves: hosting({ a: ["S"], b: ["S/x"] }), find: async () => (searches++, [{ url: "b", committedBlock: `k${searches}` }]), ttl: 100, now: () => clock });
  const [one] = await Promise.all([nodeFor(["S", "x"]), nodeFor(["S", "x"])]);
  assert.equal(searches, 1);
  await nodeFor.forget(["S", "x"], { url: "b", block: "other" });
  assert.equal(await nodeFor(["S", "x"]), one, "forgetting a node it no longer uses changes nothing");
  await nodeFor.forget(["S", "x"], one);
  assert.equal((await nodeFor(["S", "x"])).block, "k2");
  clock = 150;
  assert.equal((await nodeFor(["S", "x"])).block, "k3", "a newer commitment after ttl");
});

test("a found node is read at a committed block; one declared without it is skipped", async () => {
  const nodeFor = nodeFinder({ start: "a", serves: hosting({ a: ["S"], b: ["S/x"], c: ["S/x"] }), find: async () => [{ url: "b" }, { url: "c", committedBlock: "k" }] });
  assert.deepEqual(await nodeFor(["S", "x"]), { url: "c", block: "k" });
});

test("a deeper chain is looked for from the nearest ancestor the chosen node serves", async () => {
  let from;
  const find = async (chain, start, at) => ((from = at.join("/")), [{ url: "b", committedBlock: "k" }]);
  const nodeFor = nodeFinder({ start: "a", serves: hosting({ a: ["N", "N/s"], b: ["N/s/c", "N/s/c/d"] }), find });
  assert.deepEqual(await nodeFor(["N", "s", "c"]), { url: "b", block: "k" });
  assert.equal(from, "N/s");
  assert.deepEqual(await nodeFor(["N", "s", "c", "d"]), { url: "b", block: "k" });
  assert.equal(from, "N/s");
  // No ancestor served: nothing to start from.
  from = undefined;
  await assert.rejects(nodeFinder({ start: "a", serves: hosting({ a: [] }), find })(["N", "s"]), Offline);
  assert.equal(from, undefined);
});
