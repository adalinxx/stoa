// The simulated community the standing simulations share: honest accounts
// joining over time, the first few the view's seeds, posts with a quality in
// [0, 1] that honest accounts upvote with odds rising with it,
// newcomers with one good post and a few upvotes, lurkers who only upvote, and a farm of fresh
// accounts upvoting its spam and each other, with a few careless honest
// upvotes into it (the farm's only edges in).
import { accountEdges } from "../client/standing.mjs";

export const SEEDS = 5;
const UPVOTES_EACH = 40;
const SPAM_POSTS = 5;
export const TOP = 25;

/** A seeded generator, so runs compare. */
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One of `items`, with odds by `weight`. */
function pick(next, items, weight) {
  const total = items.reduce((sum, item) => sum + weight(item), 0);
  let at = next() * total;
  for (const item of items) if ((at -= weight(item)) <= 0) return item;
  return items.at(-1);
}

export function community({ honest = 500, sybils = 0, careless = 0, seed = 1, newcomerUpvotes = 3, lurkers = 0 } = {}) {
  const HONEST = honest;
  const NEWCOMERS = Math.round(honest * 0.08);
  const POSTS = honest * 4;
  const next = random(seed);
  const posts = new Map(); // id → { author, quality, spam, newcomer }
  const acts = new Map(); // account → { upvotes }
  const actsOf = (account) => acts.get(account) ?? acts.set(account, { upvotes: [] }).get(account);
  const established = Array.from({ length: HONEST - NEWCOMERS }, (_, i) => `h${i}`);

  for (let i = 0; i < POSTS; i++) {
    posts.set(`p${i}`, { author: established[Math.floor(next() * established.length)], quality: next() });
  }
  const honestPosts = [...posts.keys()];
  for (const account of established) {
    for (let v = 0; v < UPVOTES_EACH; v++) actsOf(account).upvotes.push(pick(next, honestPosts, (p) => posts.get(p).quality ** 3));
  }
  // Newcomers: one good post each, upvoted by three established accounts.
  for (let i = 0; i < NEWCOMERS; i++) {
    const account = `h${HONEST - NEWCOMERS + i}`;
    posts.set(`n${i}`, { author: account, quality: 0.9, newcomer: true });
    actsOf(account);
    for (let v = 0; v < newcomerUpvotes; v++) actsOf(established[Math.floor(next() * established.length)]).upvotes.push(`n${i}`);
  }
  // Lurkers: they upvote as established accounts do, and never post.
  for (let i = 0; i < lurkers; i++) {
    for (let v = 0; v < UPVOTES_EACH; v++) actsOf(`l${i}`).upvotes.push(pick(next, honestPosts, (p) => posts.get(p).quality ** 3));
  }
  // The farm: spam posts, and one post per sybil, all upvoting each other.
  for (let i = 0; i < SPAM_POSTS; i++) posts.set(`spam${i}`, { author: `sy${i % Math.max(sybils, 1)}`, quality: 0, spam: true });
  for (let i = 0; i < sybils; i++) posts.set(`syp${i}`, { author: `sy${i}`, quality: 0, spam: true });
  for (let i = 0; i < sybils; i++) {
    const own = actsOf(`sy${i}`);
    for (let s = 0; s < SPAM_POSTS; s++) own.upvotes.push(`spam${s}`);
    for (let v = 0; v < 20; v++) own.upvotes.push(`syp${Math.floor(next() * sybils)}`);
  }
  for (let i = 0; i < careless && sybils > 0; i++) {
    actsOf(established[SEEDS + Math.floor(next() * (established.length - SEEDS))]).upvotes.push(`spam${i % SPAM_POSTS}`);
  }

  const graph = new Map();
  for (const [account, own] of acts) graph.set(account, accountEdges(own));
  for (const [id, post] of posts) graph.set(id, [[post.author, 1]]);
  const upvotes = new Map([...posts.keys()].map((id) => [id, 0]));
  for (const own of acts.values()) for (const id of new Set(own.upvotes)) upvotes.set(id, upvotes.get(id) + 1);
  const voters = new Map([...posts.keys()].map((id) => [id, []]));
  for (const [account, own] of acts) for (const id of new Set(own.upvotes)) voters.get(id).push(account);
  return { posts, graph, upvotes, voters, seeds: established.slice(0, SEEDS), newcomers: NEWCOMERS };
}

/** Post ids, best first, by `score`. */
export const ranked = (posts, score) => [...posts.keys()].sort((a, b) => (score(b) ?? 0) - (score(a) ?? 0));

export function measure(posts, order) {
  const top = order.slice(0, TOP);
  const firstSpam = order.findIndex((id) => posts.get(id).spam);
  // Among honest posts only: spam sinking below them is not a newcomer's gain.
  const honest = order.filter((id) => !posts.get(id).spam);
  const newcomer = honest.flatMap((id, at) => (posts.get(id).newcomer ? [at / honest.length] : [])).sort((a, b) => a - b);
  return {
    spamInTop: top.filter((id) => posts.get(id).spam).length,
    firstSpam: firstSpam + 1,
    topQuality: top.reduce((sum, id) => sum + posts.get(id).quality, 0) / TOP,
    newcomerPercentile: Math.round(100 * (1 - newcomer[Math.floor(newcomer.length / 2)])),
  };
}

export const edgesOf = (graph) => async (ids) => new Map(ids.map((id) => [id, graph.get(id) ?? []]));
