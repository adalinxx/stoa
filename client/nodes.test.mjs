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
  const nodeFor = nodeFinder({ start: "a", serves: hosting({ a: [], b: ["S/rust"] }), find: async () => urls.map((url) => ({ url, committedBlock: "k" })) });
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
  const nodeFor = nodeFinder({ start: "a", serves: hosting({ a: [], b: ["S"] }), find: async () => (searches++, [{ url: "b", committedBlock: `k${searches}` }]), ttl: 100, now: () => clock });
  const [one] = await Promise.all([nodeFor(["S"]), nodeFor(["S"])]);
  assert.equal(searches, 1);
  await nodeFor.forget(["S"], { url: "b", block: "other" });
  assert.equal(await nodeFor(["S"]), one, "forgetting a node it no longer uses changes nothing");
  await nodeFor.forget(["S"], one);
  assert.equal((await nodeFor(["S"])).block, "k2");
  clock = 150;
  assert.equal((await nodeFor(["S"])).block, "k3", "a newer commitment after ttl");
});

test("a found node is read at a committed block; one declared without it is skipped", async () => {
  const nodeFor = nodeFinder({ start: "a", serves: hosting({ a: ["S"], b: ["S/x"], c: ["S/x"] }), find: async () => [{ url: "b" }, { url: "c", committedBlock: "k" }] });
  assert.deepEqual(await nodeFor(["S", "x"]), { url: "c", block: "k" });
});

test("the search starts from the deepest ancestor the chosen node serves", async () => {
  let from;
  const nodeFor = nodeFinder({ start: "a", serves: hosting({ a: ["N", "N/s"] }), find: async (chain, start, at) => ((from = at.join("/")), []) });
  await assert.rejects(nodeFor(["N", "s", "c", "d"]), Offline);
  assert.equal(from, "N/s");
});

