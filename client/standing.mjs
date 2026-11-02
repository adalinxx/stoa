import { edgeSets, edgesOf, tally } from "./read.mjs";

// Standing: how much a community's view vouches for each account and post,
// by personalized PageRank from the view's seeds (Andersen, Chung and Lang's
// local push). A walker starts at a seed, follows a weighted edge, and with
// probability `restart` starts again at a seed; an account's or post's
// standing is the share of time the walker spends there. Accounts nobody
// with standing engages with have none, however many of them there are and
// however they engage with each other: a ring of fresh accounts gains only
// what the view's own edges lead into it.
//
// The graph: an account points at the posts it upvoted, the posts it replied
// to and the accounts it follows; a post points at its author. So a post's
// standing is the engagement it drew from accounts with standing, and an
// author's is what their posts drew and who follows them. Downvotes are not
// edges: they rank items, and never cost anyone standing. Accounts are ids
// without a slash; posts are `<author>/<id>`.

/** Edge weights: what an account's act passes on, before its share is split. */
export const WEIGHTS = { upvote: 1, reply: 2, follow: 4 };

/**
 * Standing from `seeds` (node ids, sharing the start equally) over the graph
 * `edges(ids)` reads: for each id asked, its out-edges as `[target, weight]`
 * pairs. Each round asks for every node whose undistributed share is still
 * over `epsilon` at once, so a reader can fetch them in one batch; a node's
 * edges are asked for once. Ends once no share over `epsilon` remains: at
 * most about 1 / (restart × epsilon) nodes are read, however large the
 * graph. A walker at a node with no edges starts again at a seed.
 *
 * Returns `{ standing, read }`: standing by node id (summing to at most 1),
 * and how many nodes' edges were read.
 */
export async function standing(seeds, edges, { restart = 0.15, epsilon = 1e-4 } = {}) {
  if (seeds.length === 0) return { standing: new Map(), read: 0 };
  const settled = new Map();
  const residual = new Map();
  const add = (map, id, amount) => map.set(id, (map.get(id) ?? 0) + amount);
  for (const seed of seeds) add(residual, seed, 1 / seeds.length);
  const known = new Map(); // id → its out-edges, once read
  for (;;) {
    const due = [...residual].filter(([, share]) => share > epsilon).map(([id]) => id);
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
      const out = known.get(id);
      const total = out.reduce((sum, [, weight]) => sum + weight, 0);
      const onward = (1 - restart) * share;
      if (total > 0) for (const [target, weight] of out) add(residual, target, (onward * weight) / total);
      else for (const seed of seeds) add(residual, seed, onward / seeds.length);
    }
  }
  return { standing: settled, read: known.size };
}

/**
 * The out-edges of one account's acts: its upvotes, replies and follows, as
 * `{ upvotes: [post], replies: [post], follows: [account] }`. Repeats count
 * once. An account vouching for itself (following itself, upvoting or
 * answering its own items) counts for nothing: that would only feed its
 * standing back to it.
 */
export function accountEdges({ upvotes = [], replies = [], follows = [] }, weights = WEIGHTS, self) {
  const out = new Map();
  const others = (posts) => [...new Set(posts)].filter((post) => self === undefined || !post.startsWith(`${self}/`));
  for (const post of others(upvotes)) out.set(post, weights.upvote);
  for (const post of others(replies)) out.set(post, (out.get(post) ?? 0) + weights.reply);
  for (const account of new Set(follows)) if (account !== self) out.set(account, weights.follow);
  return [...out];
}

/**
 * The graph `standing` reads, from a community's records: `edgesOf(a)`
 * resolves to `a`'s edges as sets (`read.edgeSets`), `followsOf(a)` to the
 * accounts `a` follows. A post's one edge is to its author, named in its id,
 * so posts cost no reads. `read` keeps each account's edges as read, for
 * tallying votes without reading them again.
 */
export function graphOf({ edgesOf, followsOf, weights = WEIGHTS }) {
  const read = new Map();
  const edges = async (ids) =>
    new Map(
      await Promise.all(
        ids.map(async (id) => {
          const slash = id.indexOf("/");
          if (slash >= 0) return [id, [[id.slice(0, slash), 1]]];
          const [own, follows] = await Promise.all([edgesOf(id), followsOf(id)]);
          read.set(id, own);
          return [id, accountEdges({ upvotes: [...own.up], replies: [...own.reply], follows }, weights, id)];
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
 * A community's default seeds, until it publishes a view: the authors of its
 * first `count` posts, by the time they say they were written. Nobody can
 * claim to have come earlier later on, since the chain holds a post's time
 * to the block that writes it.
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
 * votes, standing, read }`, `votes` as `read.tally` makes it and `read` each
 * account's edges as read (`read.edgeSets`), for its labels.
 */
export async function memberVotes(state, seeds, { followsOf = async () => [], epsilon = 1e-4 } = {}) {
  const graph = graphOf({ edgesOf: async (a) => edgeSets(await edgesOf(state, a)), followsOf });
  const { standing: shares } = await standing(seeds, graph.edges, { epsilon });
  const counted = members(shares);
  return { members: counted, votes: tally(graph.read, (a) => counted.has(a)), standing: shares, read: graph.read };
}
