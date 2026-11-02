//   node --test client/
import assert from "node:assert/strict";
import { test } from "node:test";
import { accountEdges, standing } from "./standing.mjs";

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

test("accountEdges: an upvote and a reply to one post add; repeats count once", () => {
  assert.deepEqual(accountEdges({ upvotes: ["p", "p", "q"], replies: ["p", "p"] }), [
    ["p", 3],
    ["q", 1],
  ]);
});
