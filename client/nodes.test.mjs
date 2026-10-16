import assert from "node:assert/strict";
import { test } from "node:test";
import { descends, nodeFinder, Offline } from "./nodes.mjs";

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
  assert.deepEqual(await nodeFor(["S", "bitcoin"]), { url: "c", anchor: "c-c" }, "skips one that is down and one that doesn't serve it");
});

test("a chain no node serves is Offline, and is searched again later", async () => {
  let urls = [];
  const nodeFor = nodeFinder({ start: "a", serves: hosting({ a: [], b: ["S/rust"] }), find: async () => urls.map((url) => ({ url })) });
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

test("concurrent reads of one chain share one search; a forgotten node is searched again", async () => {
  let searches = 0;
  const nodeFor = nodeFinder({ start: "a", serves: hosting({ a: [], b: ["S"] }), find: async () => (searches++, [{ url: "b" }]) });
  await Promise.all([nodeFor(["S"]), nodeFor(["S"])]);
  assert.equal(searches, 1);
  nodeFor.forget(["S"]);
  await nodeFor(["S"]);
  assert.equal(searches, 2);
});

test("a tip counts only when it descends from the anchor", async () => {
  // a ← b ← c (heights 1..3), and a fork y ← z ← x beside it.
  const blocks = { a: { height: 1 }, b: { height: 2, parentCID: "a" }, c: { height: 3, parentCID: "b" }, y: { height: 1 }, z: { height: 2, parentCID: "y" }, x: { height: 3, parentCID: "z" } };
  const blockAt = async (cid) => blocks[cid];
  assert.equal(await descends(blockAt, "c", "a"), true);
  assert.equal(await descends(blockAt, "a", "a"), true);
  assert.equal(await descends(blockAt, "x", "a"), false, "a made-up chain");
  assert.equal(await descends(blockAt, "a", "c"), false, "behind the anchor");
});
