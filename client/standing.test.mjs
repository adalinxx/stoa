//   node --test client/
import assert from "node:assert/strict";
import { test } from "node:test";
import { accountEdges, graphOf, members, memberVotes, pack, reweigh, standing, unpack } from "./standing.mjs";
import * as write from "./write.mjs";

const close = (actual, expected, within = 1e-3) =>
  assert.ok(Math.abs(actual - expected) < within, `${actual} ≉ ${expected}`);

/** A graph as `{ id: [[target, weight]] }`, read the way standing asks, counting reads. */
function graph(nodes) {
  const asked = [];
  const edges = async (ids) => {
    asked.push(ids);
    return new Map(ids.map((id) => [id, nodes[id] ?? []]));
  };
  return { edges, asked };
}

/** PageRank from `seeds` by power iteration, to check the push against. */
function exact(nodes, seeds, restart = 0.15) {
  const ids = new Set([...Object.keys(nodes), ...Object.values(nodes).flat().map(([t]) => t), ...seeds]);
  let rank = new Map([...ids].map((id) => [id, seeds.includes(id) ? 1 / seeds.length : 0]));
  for (let round = 0; round < 500; round++) {
    const next = new Map([...ids].map((id) => [id, seeds.includes(id) ? restart / seeds.length : 0]));
    for (const [id, share] of rank) {
      const out = nodes[id] ?? [];
      const total = out.reduce((sum, [, w]) => sum + w, 0);
      const onward = (1 - restart) * share;
      if (total > 0) for (const [t, w] of out) next.set(t, next.get(t) + (onward * w) / total);
      else for (const s of seeds) next.set(s, next.get(s) + onward / seeds.length);
    }
    rank = next;
  }
  return rank;
}

test("standing matches PageRank from the seeds", async () => {
  const nodes = {
    seed: [["p1", 1], ["p2", 1]],
    p1: [["alice", 1]],
    p2: [["bob", 1]],
    alice: [["p3", 2], ["p2", 1]],
    bob: [["p1", 1]],
    p3: [["carol", 1]],
  };
  const { standing: got } = await standing(["seed"], graph(nodes).edges, { epsilon: 1e-7 });
  for (const [id, expected] of exact(nodes, ["seed"])) close(got.get(id) ?? 0, expected);
});

test("a ring of fresh accounts gains nothing without an edge in, and little through one", async () => {
  const honest = { seed: [["post", 1]], post: [["author", 1]], author: [["post", 1]] };
  // 200 sybils, each upvoting every other's post.
  const ring = {};
  for (let i = 0; i < 200; i++) {
    ring[`sy${i}`] = Array.from({ length: 200 }, (_, j) => [`syp${j}`, 1]);
    ring[`syp${i}`] = [[`sy${i}`, 1]];
  }
  const sealed = await standing(["seed"], graph({ ...honest, ...ring }).edges);
  assert.equal([...sealed.standing.keys()].filter((id) => id.startsWith("sy")).length, 0);

  // One careless upvote from the author into the ring.
  const leaky = { ...honest, ...ring, author: [["post", 1], ["syp0", 1]] };
  const { standing: got } = await standing(["seed"], graph(leaky).edges, { epsilon: 1e-7 });
  const sybil = [...got].filter(([id]) => id.startsWith("sy")).reduce((sum, [, s]) => sum + s, 0);
  const truth = exact(leaky, ["seed"]);
  const expected = [...truth].filter(([id]) => id.startsWith("sy")).reduce((sum, [, s]) => sum + s, 0);
  close(sybil, expected);
  assert.ok(sybil < 0.5, `the ring holds ${sybil}, bounded by the one edge in`);
});

test("reads are batched by round, each node read once, and bounded by epsilon", async () => {
  const nodes = { a: [["b", 1], ["c", 1]], b: [["a", 1]], c: [["a", 1], ["b", 1]] };
  const { edges, asked } = graph(nodes);
  const { read } = await standing(["a"], edges, { epsilon: 1e-6 });
  const all = asked.flat();
  assert.equal(new Set(all).size, all.length, "no node read twice");
  assert.equal(read, 3);
  assert.deepEqual(asked[1].sort(), ["b", "c"], "a round's nodes asked together");

  // A long chain: a coarse epsilon stops early.
  const chain = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`n${i}`, [[`n${i + 1}`, 1]]]));
  const coarse = await standing(["n0"], graph(chain).edges, { epsilon: 1e-2 });
  assert.ok(coarse.read < 30, `read ${coarse.read}`);
});

test("without seeds, nothing has standing", async () => {
  assert.equal((await standing([], graph({}).edges)).standing.size, 0);
});

test("accountEdges: upvotes and follows alike; repeats count once; vouching for oneself is nothing", () => {
  assert.deepEqual(accountEdges({ upvotes: ["bob/p", "bob/p", "me/own"], follows: ["bob", "bob", "me"] }, "me"), [
    ["bob/p", 1],
    ["bob", 1],
  ]);
});

test("graphOf: posts point at their authors unread; accounts are read once, edges kept", async () => {
  const asked = [];
  const sets = (up = []) => ({ up: new Set(up), down: new Set(["x/y"]) });
  const { edges, read } = graphOf({
    edgesOf: async (a) => (asked.push(a), a === "seed" ? sets(["alice/p1"]) : sets()),
    followsOf: async (a) => (a === "seed" ? ["lurker"] : []),
  });
  const { standing: got } = await standing(["seed"], edges);
  assert.deepEqual(asked.sort(), ["alice", "lurker", "seed"]);
  assert.ok(got.get("lurker") > 0, "a followed lurker has standing");
  assert.ok(got.get("alice") > 0, "an upvoted author has standing");
  assert.equal(got.has("x"), false, "a downvote passes nothing");
  assert.deepEqual([...read.get("seed").up], ["alice/p1"]);
});

test("members: the accounts holding 98% of account standing, posts aside, ties kept together", () => {
  const s = new Map([["a", 0.5], ["b", 0.3], ["c", 0.19], ["d", 0.005], ["e", 0.005], ["a/p", 0.9]]);
  assert.deepEqual([...members(s)], ["a", "b", "c"]);
  // The cut (80%) falls after b; c ties with b, so it is kept too.
  const tied = new Map([["a", 0.75], ["b", 0.125], ["c", 0.125], ["d", 0.0625]]);
  assert.deepEqual([...members(tied, { delta: 0.2 })], ["a", "b", "c"]);
  assert.equal(members(new Map()).size, 0);
});

test("reweigh: a push continued after edges change matches one started afresh", async () => {
  // A random graph of accounts and posts; then some read accounts change their edges.
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const ids = Array.from({ length: 60 }, (_, i) => `n${i}`);
  const pick = (n) => [...new Set(Array.from({ length: n }, () => ids[Math.floor(random() * ids.length)]))].map((t) => [t, 1]);
  const nodes = Object.fromEntries(ids.map((id) => [id, pick(1 + Math.floor(random() * 4))]));
  nodes.n5 = [];
  const first = await standing(["n0", "n1"], graph(nodes).edges, { epsilon: 1e-9 });
  const changed = { ...nodes, n0: pick(3), n3: [], n5: pick(2), n9: [["n0", 1]] };
  for (const id of ["n0", "n3", "n5", "n9"]) reweigh(first.push, id, changed[id]);
  const readBefore = new Set(first.push.known.keys());
  const { edges, asked } = graph(changed);
  const continued = await standing(["n0", "n1"], edges, { epsilon: 1e-9, from: first.push });
  const fresh = await standing(["n0", "n1"], graph(changed).edges, { epsilon: 1e-9 });
  for (const id of new Set([...fresh.standing.keys(), ...continued.standing.keys()])) close(continued.standing.get(id) ?? 0, fresh.standing.get(id) ?? 0, 1e-6);
  assert.ok(asked.flat().every((id) => !readBefore.has(id)), "nothing read before is read again");
});

test("memberVotes: from what it kept, reads again only the accounts that changed", async () => {
  const map = new Map();
  const state = {
    get: async (key) => map.get(key),
    async *list(prefix) {
      for (const key of [...map.keys()].sort()) if (key.startsWith(prefix)) yield [key, map.get(key)];
    },
    async apply(writes) {
      for (const { key, newValue } of await write.changes(this, writes)) newValue === undefined ? map.delete(key) : map.set(key, newValue);
    },
  };
  const vote = async (a, author, id, direction) => {
    const { edgesOf } = await import("./read.mjs");
    await state.apply(write.vote(a, await edgesOf(state, a), author, id, direction));
  };
  await vote("seed", "alice", "p1", 1);
  await vote("alice", "bob", "p2", 1);
  await vote("carol", "bob", "p2", 1);
  const listed = [];
  const counting = { ...state, list: (prefix) => (listed.push(prefix), state.list(prefix)) };
  const first = await memberVotes(counting, ["seed"]);
  assert.equal(first.members.has("carol"), false);
  assert.equal(first.votes.get("bob/p2").ups, 1);

  // Alice now upvotes Carol's post: Carol is reached, and her vote counts.
  await vote("alice", "carol", "p3", 1);
  listed.length = 0;
  const kept = unpack(JSON.parse(JSON.stringify(pack(first.kept))));
  const next = await memberVotes(counting, ["seed"], { before: kept, changed: ["alice"] });
  assert.ok(!listed.includes("user/seed/edges/"), "an unchanged account is not read again");
  assert.ok(listed.includes("user/alice/edges/") && listed.includes("user/carol/edges/"));
  const fresh = await memberVotes(state, ["seed"], { epsilon: 1e-4 });
  assert.deepEqual([...next.members].sort(), [...fresh.members].sort());
  assert.equal(next.votes.get("bob/p2").ups, 2);
  assert.equal(first.votes.get("bob/p2").ups, 1, "what was kept is left as it was");
});
