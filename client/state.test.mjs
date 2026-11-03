//   node --test client/state.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { anyHost, diff, get, list } from "./state.mjs";

// An in-memory trie in the same shape the chain serves.
const nodes = {
  root: { count: 6n, children: [{ key: "u", value: { rawCID: "user" } }, { key: "i", value: { rawCID: "idx" } }] },
  user: { prefix: "user/", children: [{ key: "a", value: { rawCID: "a" } }, { key: "b", value: { rawCID: "b" } }] },
  a: { prefix: "alice/p", children: [{ key: "r", value: { rawCID: "ap" } }, { key: "o", value: { rawCID: "ao" } }] },
  ap: { prefix: "rofile", value: "{}", children: [] },
  ao: { prefix: "ost/", children: [{ key: "2", value: { rawCID: "a2" } }, { key: "1", value: { rawCID: "a1" } }] },
  a1: { prefix: "1", value: "first", children: [{ key: "0", value: { rawCID: "a10" } }] },
  a10: { prefix: "0", value: "tenth", children: [] },
  a2: { prefix: "2", value: "second", children: [] },
  b: { prefix: "bob/profile", value: "{b}", children: [] },
  idx: { prefix: "index/follower/bob/alice", value: "1", children: [] },
};
const load = async (cid) => ({ node: nodes[cid] });
const all = async (prefix) => {
  const found = [];
  for await (const entry of list(load, "root", prefix)) found.push(entry);
  return found;
};

test("get finds exact keys only", async () => {
  assert.equal(await get(load, "root", "user/alice/post/1"), "first");
  assert.equal(await get(load, "root", "user/alice/post/10"), "tenth");
  assert.equal(await get(load, "root", "user/bob/profile"), "{b}");
  assert.equal(await get(load, "root", "user/alice/post/"), undefined);
  assert.equal(await get(load, "root", "user/alice/post/3"), undefined);
  assert.equal(await get(load, "root", "user/bob"), undefined);
  assert.equal(await get(load, "root", "nothing"), undefined);
});

test("list returns a prefix's entries in key order", async () => {
  assert.deepEqual(await all("user/alice/post/"), [
    ["user/alice/post/1", "first"],
    ["user/alice/post/10", "tenth"],
    ["user/alice/post/2", "second"],
  ]);
  // A prefix ending inside a node's own prefix still matches its subtree.
  assert.deepEqual((await all("user/al")).map(([key]) => key), [
    "user/alice/post/1",
    "user/alice/post/10",
    "user/alice/post/2",
    "user/alice/profile",
  ]);
  assert.deepEqual(await all("index/follower/bob/"), [["index/follower/bob/alice", "1"]]);
  assert.deepEqual(await all("user/carol/"), []);
  assert.deepEqual(await all("user/alicia"), []);
  assert.equal((await all("")).length, 6);
});

test("anyHost spreads reads and moves on from a host that cannot serve", async () => {
  const asked = [];
  const host = (name, answer) => ({
    getVolume: async (cid) => {
      asked.push(name);
      return answer(cid);
    },
  });
  const transport = anyHost([
    host("a", (cid) => cid),
    host("b", () => null),
    host("c", () => {
      throw new Error("HTTP 429");
    }),
  ]);
  assert.equal(await transport.getVolume("x"), "x"); // a
  assert.equal(await transport.getVolume("y"), "y"); // b lacks it, c refuses, a serves
  assert.deepEqual(asked, ["a", "b", "c", "a"]);
  await assert.rejects(anyHost([host("c", () => Promise.reject(new Error("HTTP 429")))]).getVolume("x"));
  assert.equal(await anyHost([host("b", () => null)]).getVolume("x"), null);
});

/** A trie in the chain's shape built from `entries` (a Map), its nodes in `store` by a content name. */
function trie(entries, store) {
  const put = (node) => {
    const cid = JSON.stringify(node, (_, v) => (typeof v === "bigint" ? String(v) : v));
    store.set(cid, node);
    return cid;
  };
  const group = (pairs) => {
    const by = new Map();
    for (const pair of pairs) {
      const first = pair[0][0];
      if (!by.has(first)) by.set(first, []);
      by.get(first).push(pair);
    }
    return [...by].sort(([a], [b]) => (a < b ? -1 : 1));
  };
  const make = (pairs) => {
    let prefix = pairs[0][0];
    for (const [rest] of pairs) while (!rest.startsWith(prefix)) prefix = prefix.slice(0, -1);
    const value = pairs.find(([rest]) => rest === prefix)?.[1];
    const deeper = pairs.filter(([rest]) => rest !== prefix).map(([rest, v]) => [rest.slice(prefix.length), v]);
    return put({ prefix, ...(value !== undefined && { value }), children: group(deeper).map(([key, g]) => ({ key, value: { rawCID: make(g) } })) });
  };
  return put({ count: BigInt(entries.size), children: group([...entries]).map(([key, g]) => ({ key, value: { rawCID: make(g) } })) });
}

test("diff finds exactly the keys that changed, reading only what differs", async () => {
  let seed = 11;
  const random = (n) => Math.floor(((seed = (seed * 16807) % 2147483647) / 2147483647) * n);
  const word = () => Array.from({ length: 1 + random(3) }, () => "ab"[random(2)]).join("");
  const store = new Map();
  const loads = [];
  const load = async (cid) => (loads.push(cid), { node: store.get(cid) });
  for (let round = 0; round < 200; round++) {
    const before = new Map(Array.from({ length: random(12) }, () => [`user/${word()}/edges/${random(3)}`, String(random(5))]));
    const after = new Map(before);
    for (let n = random(4); n > 0; n--) {
      const key = random(3) === 0 && before.size ? [...before.keys()][random(before.size)] : `user/${word()}/edges/${random(3)}`;
      if (random(3) === 0) after.delete(key);
      else after.set(key, String(random(5)));
    }
    const expected = [...new Set([...before.keys(), ...after.keys()])].filter((k) => before.get(k) !== after.get(k)).map((k) => [k, before.get(k), after.get(k)]).sort();
    const found = [];
    for await (const change of diff(load, trie(before, store), trie(after, store))) found.push(change);
    assert.deepEqual(found.sort(), expected, `round ${round}`);
  }
  // One change in a large state reads a few nodes, not the whole trie.
  const big = new Map(Array.from({ length: 2000 }, (_, i) => [`user/a${i}/edges/0`, "x"]));
  const changed = new Map(big).set("user/a1234/edges/0", "y");
  const [a, b] = [trie(big, store), trie(changed, store)];
  loads.length = 0;
  const found = [];
  for await (const change of diff(load, a, b)) found.push(change);
  assert.deepEqual(found, [["user/a1234/edges/0", "x", "y"]]);
  assert.ok(loads.length < 20, `read ${loads.length} nodes`);
});
