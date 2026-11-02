// Standing: how much a community's view vouches for each account and post,
// by personalized PageRank from the view's seeds (Andersen, Chung and Lang's
// local push). A walker starts at a seed, follows a weighted edge, and with
// probability `restart` starts again at a seed; an account's or post's
// standing is the share of time the walker spends there. Accounts nobody
// with standing engages with have none, however many of them there are and
// however they engage with each other: a ring of fresh accounts gains only
// what the view's own edges lead into it.
//
// The graph: an account points at the posts it upvoted and the posts it
// replied to; a post points at its author. So a post's standing is the
// engagement it drew from accounts with standing, and an author's is what
// their posts drew.

/** Edge weights: what an account's act passes on, before its share is split. */
export const WEIGHTS = { upvote: 1, reply: 2 };

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
 * The out-edges of one account's acts: its upvotes and replies, as
 * `{ upvotes: [postId], replies: [postId] }`. Repeats count once.
 */
export function accountEdges({ upvotes = [], replies = [] }, weights = WEIGHTS) {
  const out = new Map();
  for (const post of new Set(upvotes)) out.set(post, weights.upvote);
  for (const post of new Set(replies)) out.set(post, (out.get(post) ?? 0) + weights.reply);
  return [...out];
}
