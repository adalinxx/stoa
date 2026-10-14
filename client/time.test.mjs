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
