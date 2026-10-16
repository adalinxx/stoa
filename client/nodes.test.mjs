import assert from "node:assert/strict";
import { test } from "node:test";
import { nodeFinder, Offline } from "./nodes.mjs";

const hosting = (table) => async (url, chain) => {
  if (table[url] === "down") throw new TypeError("Failed to fetch");
  if (table[url] === "busy") throw Object.assign(new Error("HTTP 503"), { status: 503 });
  return (table[url] ?? []).includes(chain.join("/"));
};
const declared = (...urls) => async () => urls.map((url) => ({ url }));

test("the chosen node is used for a chain it serves, with no search", async () => {
  let searched = 0;
  const nodeFor = nodeFinder({ start: "a", serves: hosting({ a: ["S"] }), find: async () => (searched++, []) });
  assert.deepEqual(await nodeFor(["S"]), { url: "a" });
  assert.equal(searched, 0);
});

test("a chain the chosen node lacks is read from the first found node this page can read, never the chosen one", async () => {
  const nodeFor = nodeFinder({ start: "a", serves: hosting({ a: ["S"], b: ["S/bitcoin"], c: ["S/bitcoin"], d: "down", e: [] }), find: declared("a", "d", "e", "c", "b") });
  assert.deepEqual(await nodeFor(["S", "bitcoin"]), { url: "c", found: true });
  // Only the chosen node found: offline.
  await assert.rejects(nodeFinder({ start: "a", serves: hosting({ a: ["S"] }), find: declared("a") })(["S", "x"]), Offline);
});

test("a found node that failed is tried after the others until ttl", async () => {
  let clock = 0;
  const nodeFor = nodeFinder({ start: "a", serves: hosting({ a: ["S"], b: ["S/x"], c: ["S/x"] }), find: declared("b", "c"), ttl: 100, now: () => clock });
  const first = await nodeFor(["S", "x"]);
  assert.equal(first.url, "b");
  await nodeFor.forget(["S", "x"], first);
  const second = await nodeFor(["S", "x"]);
  assert.equal(second.url, "c");
  await nodeFor.forget(["S", "x"], second);
  assert.equal((await nodeFor(["S", "x"])).url, "b", "both failed: declared order");
  clock = 250;
  await nodeFor.forget(["S", "x"], await nodeFor(["S", "x"]));
  clock = 400;
  assert.equal((await nodeFor(["S", "x"])).url, "b", "failures expire");
});

test("a chain no node serves is Offline, and is searched again later", async () => {
  let urls = [];
  const nodeFor = nodeFinder({ start: "a", serves: hosting({ a: ["S"], b: ["S/rust"] }), find: async () => urls.map((url) => ({ url })) });
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
  const nodeFor = nodeFinder({ start: "a", serves: async (url, chain) => url !== "a" || chain.join("/") === "S", find: async () => (searches++, [{ url: `b${searches}` }]), ttl: 100, now: () => clock });
  const [one] = await Promise.all([nodeFor(["S", "x"]), nodeFor(["S", "x"])]);
  assert.equal(searches, 1);
  await nodeFor.forget(["S", "x"], { url: "b1", found: true });
  assert.equal(await nodeFor(["S", "x"]), one, "forgetting a node it no longer uses changes nothing");
  await nodeFor.forget(["S", "x"], one);
  assert.equal((await nodeFor(["S", "x"])).url, "b2");
  clock = 150;
  assert.equal((await nodeFor(["S", "x"])).url, "b3", "searched again after ttl");
});

test("a deeper chain is looked for from the nearest ancestor the chosen node serves", async () => {
  let from;
  const find = async (chain, start, at) => ((from = at.join("/")), [{ url: "b" }]);
  const nodeFor = nodeFinder({ start: "a", serves: hosting({ a: ["N", "N/s"], b: ["N/s/c", "N/s/c/d"] }), find });
  assert.deepEqual(await nodeFor(["N", "s", "c"]), { url: "b", found: true });
  assert.equal(from, "N/s");
  assert.deepEqual(await nodeFor(["N", "s", "c", "d"]), { url: "b", found: true });
  assert.equal(from, "N/s");
  // No ancestor served: nothing to start from.
  from = undefined;
  await assert.rejects(nodeFinder({ start: "a", serves: hosting({ a: [] }), find })(["N", "s"]), Offline);
  assert.equal(from, undefined);
});
