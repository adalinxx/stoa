import { edgeSets, edgesOf, tally } from "./read.mjs";

// Standing: how much a community vouches for each account and post, by
// personalized PageRank from its seeds (Andersen, Chung and Lang's
// local push). A walker starts at a seed, follows an edge, and with
// probability `restart` starts again at a seed; an account's or post's
// standing is the share of time the walker spends there. Accounts nobody
// with standing engages with have none, however many of them there are and
// however they engage with each other: a ring of fresh accounts gains only
// what the community's own edges lead into it.
//
// The graph: an account points at the posts it upvoted and the accounts it
// follows, each edge alike; a post points at its author. So a post's standing
// is the upvotes it drew from accounts with standing, and an author's is what
// their posts drew and who follows them. Replying vouches for nothing (an
// argument would feed whoever started it), and downvotes are not edges: they
// rank items, and never cost anyone standing. Accounts are ids without a
// slash; posts are `<author>/<id>`.

/**
 * Standing from `seeds` (node ids, sharing the start equally) over the graph
 * `edges(ids)` reads: for each id asked, its out-edges as `[target, weight]`
 * pairs. Each round asks for every node whose undistributed share is still
 * over `epsilon` at once, so a reader can fetch them in one batch; a node's
 * edges are asked for once. Ends once no share over `epsilon` remains: at
 * most about 1 / (restart × epsilon) nodes are read, however large the
 * graph. A walker at a node with no edges starts again at a seed.
 *
 * Returns `{ standing, read, push }`: standing by node id (summing to at
 * most 1), how many nodes' edges were read, and the push's state, which
 * `standing` continues from (as `from`) once `reweigh` has told it which
 * nodes' edges changed.
 */
export async function standing(seeds, edges, { restart = 0.15, epsilon = 1e-4, from } = {}) {
  if (seeds.length === 0) return { standing: new Map(), read: 0, push: undefined };
  const push = from ?? { seeds, settled: new Map(), residual: new Map(seeds.map((seed) => [seed, 1 / seeds.length])), known: new Map() };
  const { settled, residual, known } = push;
  const add = (map, id, amount) => map.set(id, (map.get(id) ?? 0) + amount);
  for (;;) {
    // A change of edges can leave a share below nothing: it is pushed the same way.
    const due = [...residual].filter(([, share]) => Math.abs(share) > epsilon).map(([id]) => id);
    if (due.length === 0) break;
    const unread = due.filter((id) => !known.has(id));
    if (unread.length > 0) {
      const read = await edges(unread);
      for (const id of unread) known.set(id, read.get(id) ?? []);
    }
    for (const id of due) {
      const share = residual.get(id);
      residual.delete(id);
      add(settled, id, restart * share);
      for (const [target, part] of onward(push, id)) add(residual, target, (1 - restart) * share * part);
    }
  }
  return { standing: settled, read: known.size, push };
}

/** Where a walker at `id` goes next, as `[target, share]` pairs summing to 1. */
function onward({ seeds, known }, id) {
  const out = known.get(id) ?? [];
  const total = out.reduce((sum, [, weight]) => sum + weight, 0);
  return total > 0 ? out.map(([target, weight]) => [target, weight / total]) : seeds.map((seed) => [seed, 1 / seeds.length]);
}

/**
 * Tell a push (`standing`'s `push`) that `id`'s out-edges are now `out`,
 * keeping what it has computed: the standing `id` already passed on along
 * its old edges is moved to its new ones through the remaining shares, which
 * the next `standing(..., { from: push })` pushes on (dynamic forward push:
 * Zhang, Lofgren and Goel, KDD 2016). A node it has not read is left alone:
 * its edges are read when the push reaches it.
 */
export function reweigh(push, id, out, { restart = 0.15 } = {}) {
  if (!push.known.has(id)) return;
  const passed = ((1 - restart) / restart) * (push.settled.get(id) ?? 0);
  const before = onward(push, id);
  push.known.set(id, out);
  const add = (target, amount) => push.residual.set(target, (push.residual.get(target) ?? 0) + amount);
  for (const [target, part] of before) add(target, -passed * part);
  for (const [target, part] of onward(push, id)) add(target, passed * part);
}

/**
 * The out-edges of one account's acts, `{ upvotes: [post], follows:
 * [account] }`, each of weight 1. Repeats count once. An account vouching for
 * itself (following itself, upvoting its own items) counts for nothing: that
 * would only feed its standing back to it.
 */
export function accountEdges({ upvotes = [], follows = [] }, self) {
  const out = new Set();
  for (const post of upvotes) if (self === undefined || !post.startsWith(`${self}/`)) out.add(post);
  for (const account of follows) if (account !== self) out.add(account);
  return [...out].map((target) => [target, 1]);
}

/**
 * The graph `standing` reads, from a community's records: `edgesOf(a)`
 * resolves to `a`'s edges as sets (`read.edgeSets`), `followsOf(a)` to the
 * accounts `a` follows. A post's one edge is to its author, named in its id,
 * so posts cost no reads. `read` keeps each account's edges as read, for
 * tallying votes without reading them again.
 */
export function graphOf({ edgesOf, followsOf }) {
  const read = new Map();
  const edges = async (ids) =>
    new Map(
      await Promise.all(
        ids.map(async (id) => {
          const slash = id.indexOf("/");
          if (slash >= 0) return [id, [[id.slice(0, slash), 1]]];
          const [own, follows] = await Promise.all([edgesOf(id), followsOf(id)]);
          read.set(id, own);
          return [id, accountEdges({ upvotes: [...own.up], follows }, id)];
        }),
      ),
    );
  return { edges, read };
}

/**
 * The members: the accounts that together hold 1 − `delta` of all accounts'
 * standing, most first. A farm's accounts each hold almost nothing, so they
 * sit in the tail this cuts, however many there are; the cut scales with the
 * community (docs/standing.md, The gate rule).
 */
export function members(standing, { delta = 0.02 } = {}) {
  const accounts = [...standing].filter(([id]) => !id.includes("/")).sort((a, b) => b[1] - a[1]);
  const total = accounts.reduce((sum, [, share]) => sum + share, 0);
  const kept = new Set();
  let held = 0;
  let gate = Infinity;
  for (const [id, share] of accounts) {
    if (held >= (1 - delta) * total && share < gate) break;
    kept.add(id);
    held += share;
    gate = share;
  }
  return kept;
}

/**
 * A community's seeds: the authors of its first `count` posts, by the time
 * they say they were written. Nobody can claim to have come earlier later
 * on, since the chain holds a post's time to the block that writes it.
 */
export function seedsOf(posts, count = 5) {
  const seeds = [];
  for (const post of [...posts].sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity))) {
    if (!seeds.includes(post.author)) seeds.push(post.author);
    if (seeds.length === count) break;
  }
  return seeds;
}

/**
 * A community's members and their votes, from `seeds`, reading accounts'
 * edges from `state` and whom they follow with `followsOf`: `{ members,
 * votes, standing, kept }`, `votes` as `read.tally` makes it.
 *
 * `kept` is what a later computation starts from, as `before`, with the
 * accounts whose votes or follows `changed` since: only those are read
 * again (if the push had read them), and the push goes on from where it
 * stood. With other seeds it starts afresh. `before` is left as it was.
 */
export async function memberVotes(state, seeds, { followsOf = async () => [], epsilon = 1e-4, before, changed = [] } = {}) {
  const graph = graphOf({ edgesOf: async (a) => edgeSets(await edgesOf(state, a)), followsOf });
  let from;
  if (before?.push && before.push.seeds.length === seeds.length && before.push.seeds.every((seed, n) => seed === seeds[n])) {
    const { push } = before;
    from = { seeds, settled: new Map(push.settled), residual: new Map(push.residual), known: new Map(push.known) };
    for (const [a, sets] of before.read) graph.read.set(a, sets);
    const again = [...new Set(changed)].filter((a) => !a.includes("/") && from.known.has(a));
    const fresh = await graph.edges(again);
    for (const a of again) reweigh(from, a, fresh.get(a));
  }
  const { standing: shares, push } = await standing(seeds, graph.edges, { epsilon, from });
  const counted = members(shares);
  return { members: counted, votes: tally(graph.read, (a) => counted.has(a)), standing: shares, kept: { push, read: graph.read } };
}

/** `kept`, as `memberVotes` returns it, as plain JSON-able data, and back. */
export const pack = ({ push, read }) => push && {
  seeds: push.seeds, settled: [...push.settled], residual: [...push.residual], known: [...push.known],
  read: [...read].map(([a, { up, down }]) => [a, [...up], [...down]]),
};
export const unpack = (packed) => packed && {
  push: { seeds: packed.seeds, settled: new Map(packed.settled), residual: new Map(packed.residual), known: new Map(packed.known) },
  read: new Map(packed.read.map(([a, up, down]) => [a, { up: new Set(up), down: new Set(down) }])),
};
