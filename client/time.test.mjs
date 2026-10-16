//   node --test client/
import assert from "node:assert/strict";
import { test } from "node:test";
import { blockTimes } from "./time.mjs";

// Content in the shapes the chain serves, with decoding as the identity: a
// block, a one-level transaction trie, a signed transaction and its body.
// Only blocks and transactions are Volume roots; the trie is reachable only
// inside its block's Volume, as it is on a node.
function chain() {
  const content = new Map();
  const roots = new Set();
  const sdk = {
    decodeDagCbor: (value) => value,
    decodeCanonicalBlock: (value) => value,
    decodeCanonicalSignedTransaction: (value) => value,
  };
  const volumes = {
    reads: 0,
    async get(cid) {
      this.reads++;
      if (!roots.has(cid)) throw new Error(`no Volume ${cid}`);
      return { rootBytes: () => content.get(cid), bytes: (inner) => content.get(inner) };
    },
  };
  let count = 0;
  const block = (hash, parent, timestamp, bodies) => {
    const children = bodies.map((actions, n) => {
      const tx = `${hash}-tx${n}`;
      content.set(tx, { bodyCID: `${tx}-body` });
      roots.add(tx);
      content.set(`${tx}-body`, { actions });
      content.set(`${tx}-leaf`, { prefix: String(n), value: { rawCID: tx }, children: [] });
      return { key: String(n), value: { rawCID: `${tx}-leaf` } };
    });
    content.set(`${hash}-txs`, { count: BigInt(children.length), children });
    content.set(hash, {
      ...(parent && { parentCID: parent }),
      timestamp: BigInt(timestamp),
      transactionsCID: `${hash}-txs`,
      height: BigInt(count++),
    });
    roots.add(hash);
  };
  return { sdk, volumes, block };
}

const create = (key) => ({ key, newValue: "{}" });

test("a post's time is the block that created it; edits and other keys do not count", async () => {
  const { sdk, volumes, block } = chain();
  block("g", undefined, 1000, []);
  block("b1", "g", 2000, [[create("user/alice/post/p1"), create("index/post/p1/alice")]]);
  block("b2", "b1", 3000, [
    [{ key: "user/alice/post/p1", oldValue: "{}", newValue: "{edited}" }],
    [create("user/bob/post/c1"), create("user/bob/post/c1/media/0"), create("user/bob/profile")],
  ]);
  const index = blockTimes(sdk, volumes);
  await index.follow("b2");
  assert.deepEqual(index.times("b2"), new Map([["bob/c1", 3000], ["alice/p1", 2000]]));
});

test("following stops at blocks already read and at the window", async () => {
  const { sdk, volumes, block } = chain();
  block("g", undefined, 1000, [[create("user/old/post/x")]]);
  block("b1", "g", 2000, [[create("user/alice/post/p1")]]);
  block("b2", "b1", 3000, []);
  const index = blockTimes(sdk, volumes);
  await index.follow("b2", { since: 2000 });
  assert.equal(index.times("b2").has("old/x"), false, "older than the window");
  block("b3", "b2", 4000, [[create("user/alice/post/p2")]]);
  const before = volumes.reads;
  await index.follow("b3");
  assert.ok(volumes.reads - before <= 4, "only the new block is read");
  assert.equal(index.times("b3").get("alice/p2"), 4000);
});

test("after a reorg the times are the new chain's", async () => {
  const { sdk, volumes, block } = chain();
  block("g", undefined, 1000, []);
  block("a1", "g", 2000, [[create("user/alice/post/p1")]]);
  block("b1", "g", 2500, []);
  block("b2", "b1", 3500, [[create("user/alice/post/p1")]]);
  const index = blockTimes(sdk, volumes);
  await index.follow("a1");
  assert.equal(index.times("a1").get("alice/p1"), 2000);
  await index.follow("b2");
  assert.equal(index.times("b2").get("alice/p1"), 3500);
});

test("a key deleted and created again takes its latest creation", async () => {
  const { sdk, volumes, block } = chain();
  block("g", undefined, 1000, [[create("user/alice/post/p1")]]);
  block("b1", "g", 2000, [[{ key: "user/alice/post/p1", oldValue: "{}" }]]);
  block("b2", "b1", 3000, [[create("user/alice/post/p1")]]);
  const index = blockTimes(sdk, volumes);
  await index.follow("b2");
  assert.equal(index.times("b2").get("alice/p1"), 3000);
});

// The node's block list over `hashes` (newest first), as /api/blocks pages
// it. Built before the test counts reads: the list is the node's answer, not
// a content read.
async function lister(volumes, hashes) {
  const all = [];
  for (const hash of hashes) {
    const block = (await volumes.get(hash)).rootBytes();
    all.push({ height: block.height, hash, previousBlock: block.parentCID, timestamp: block.timestamp, transactionCount: hash.endsWith("tx") ? 1 : 0 });
  }
  return async (before) => {
    const below = before === undefined ? all : all.filter((row) => row.height < before);
    const page = below.slice(0, 25);
    return { blocks: page, ...(page.at(-1)?.height > 0n ? { nextBefore: page.at(-1).height } : {}) };
  };
}

test("with the node's block list, only blocks with transactions are read", async () => {
  const { sdk, volumes, block } = chain();
  block("g", undefined, 1000, []);
  let parent = "g";
  const hashes = ["g"];
  for (let n = 1; n <= 60; n++) {
    const hash = n === 30 ? "b30tx" : `b${n}`;
    block(hash, parent, 1000 + n * 1000, n === 30 ? [[create("user/alice/post/p1")]] : []);
    hashes.unshift(hash);
    parent = hash;
  }
  const pages = await lister(volumes, hashes);
  volumes.reads = 0;
  const index = blockTimes(sdk, volumes);
  await index.follow("b60", { pages });
  assert.deepEqual(index.times("b60"), new Map([["alice/p1", 31000]]));
  // The one block with a transaction, and that transaction's Volume.
  assert.equal(volumes.reads, 2);
});

test("a block list that does not link up is set aside for the block-by-block walk", async () => {
  const { sdk, volumes, block } = chain();
  block("g", undefined, 1000, []);
  block("b1tx", "g", 2000, [[create("user/alice/post/p1")]]);
  block("b2", "b1tx", 3000, []);
  const lying = async () => ({
    blocks: [
      { height: 2n, hash: "b2", previousBlock: "elsewhere", timestamp: 3000n, transactionCount: 0 },
      { height: 1n, hash: "b1tx", previousBlock: "g", timestamp: 2000n, transactionCount: 0 },
    ],
  });
  const index = blockTimes(sdk, volumes);
  await index.follow("b2", { pages: lying });
  assert.deepEqual(index.times("b2"), new Map([["alice/p1", 2000]]));
});

test("a block list that stops descending, or lacks the tip, is set aside", async () => {
  const { sdk, volumes, block } = chain();
  block("g", undefined, 1000, []);
  block("b1tx", "g", 2000, [[create("user/alice/post/p1")]]);
  block("b2", "b1tx", 3000, []);
  const stuck = async (before) =>
    before === undefined
      ? { blocks: [{ height: 2n, hash: "b2", previousBlock: "b1tx", timestamp: 3000n, transactionCount: 0 }], nextBefore: 2n }
      : { blocks: [], nextBefore: before };
  const index = blockTimes(sdk, volumes);
  await index.follow("b2", { pages: stuck });
  assert.deepEqual(index.times("b2"), new Map([["alice/p1", 2000]]));
  const elsewhere = async () => ({ blocks: [{ height: 9n, hash: "other", timestamp: 9000n, transactionCount: 0 }] });
  const fresh = blockTimes(sdk, volumes);
  await fresh.follow("b2", { pages: elsewhere });
  assert.deepEqual(fresh.times("b2"), new Map([["alice/p1", 2000]]));
});
