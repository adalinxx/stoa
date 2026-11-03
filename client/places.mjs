// Where a community's records live. A community lives on the home chain,
// beside every other there, or on a chain of its own (`<home>/<name>`); one
// that moved has lived in both, and is read from both.
//
// On its own chain a community's records are as README.md lays them out. On
// the home chain the same records are scoped to it:
//
//   index/<rest>               → index/c/<segment>/<rest>
//   user/<a>/edges/<n>         → user/<a>/c/<segment>/edges/<n>
//   user/<a>/post/<id>         → the same key, its record saying `"c": <name>`
//
// A post keeps its key, so the chain's policy holds its time as it does
// everywhere; its `c` says which community it is in, and a view of another
// community doesn't see it. `scoped` makes such a view, `scopeWrites` the
// writes, and the reads and writes in read.mjs and write.mjs work on either.

/** A community's name: up to four `/`-separated segments of a-z, 0-9 and -. */
export const NAME = /^[a-z0-9][a-z0-9-]{0,31}(\/[a-z0-9][a-z0-9-]{0,31}){0,3}$/;
/** s/all is every community at once: no community may take its name. */
export const ALL = "all";
export const isName = (name) => typeof name === "string" && NAME.test(name) && name !== ALL;
/** A name as one key segment: `bitcoin/lightning` → `bitcoin.lightning`. */
export const segmentOf = (name) => name.replaceAll("/", ".");
export const nameOf = (segment) => segment.replaceAll(".", "/");

const POST = /^user\/[^/]+\/post\/[^/]+$/;
const EDGES = /^user\/([^/]+)\/edges\//;

/** A community-local key (or prefix) as the home chain holds it. */
export function scopedKey(name, key) {
  const segment = segmentOf(name);
  if (key.startsWith("index/")) return `index/c/${segment}/${key.slice("index/".length)}`;
  return key.replace(EDGES, `user/$1/c/${segment}/edges/`);
}

/** A home-chain key back as the community sees it. */
function localKey(name, key) {
  const segment = segmentOf(name);
  const index = `index/c/${segment}/`;
  if (key.startsWith(index)) return `index/${key.slice(index.length)}`;
  const edges = /^user\/([^/]+)\/c\/([^/]+)\/edges\//.exec(key);
  if (edges && edges[2] === segment) return `user/${edges[1]}/edges/${key.slice(edges[0].length)}`;
  return key;
}

const recordOf = (value) => {
  try {
    const record = JSON.parse(value);
    return typeof record === "object" && record !== null && !Array.isArray(record) ? record : undefined;
  } catch {}
};
/** Whether a post's value is in `name` (it says so). */
const inCommunity = (name, value) => recordOf(value)?.c === name;

/**
 * The home chain's `state` as community `name` sees it: its own records at
 * their community-local keys, and posts only where they say they are in it.
 */
export function scoped(state, name) {
  return {
    ...state,
    community: name,
    async get(key) {
      const value = await state.get(scopedKey(name, key));
      if (value !== undefined && POST.test(key) && !inCommunity(name, value)) return undefined;
      return value;
    },
    async *list(prefix) {
      for await (const [key, value] of state.list(scopedKey(name, prefix))) {
        const local = localKey(name, key);
        if (POST.test(local) && !inCommunity(name, value)) continue;
        // Another community's scoped records under a broader prefix are not this one's.
        if (/^(index\/c\/|user\/[^/]+\/c\/)/.test(local)) continue;
        yield [local, value];
      }
    },
  };
}

/**
 * Writes (as write.mjs makes them) for community `name` on the home chain:
 * at their scoped keys, a post or comment saying it is in `name`.
 */
export function scopeWrites(name, writes) {
  return writes.map(([key, value]) => {
    if (value === undefined || !POST.test(key)) return [scopedKey(name, key), value];
    const record = recordOf(value);
    return [key, record ? JSON.stringify({ ...record, c: name }) : value];
  });
}

const EDGE_RECORD = /^(user\/[^/]+\/edges\/)(0|[1-9]\d*)$/;
/** Edges records of the n-th view are numbered from n × this, so two views' records never share a number. */
export const EDGES_APART = 1_000_000;

/**
 * One view over `views` (a community's states, each as the community sees
 * it): a key is read from the first that has it, a listing is every view's,
 * a key listed by more than one given once. An account's edges records are
 * numbered apart, so each view's votes are all read. `where(key)` is the
 * index of the view holding `key`, or -1.
 */
export function union(views) {
  return {
    views,
    async get(key) {
      for (const view of views) {
        const value = await view.get(key);
        if (value !== undefined) return value;
      }
    },
    async *list(prefix) {
      const seen = new Set();
      for (const [n, view] of views.entries()) {
        for await (const [key, value] of view.list(prefix)) {
          const record = EDGE_RECORD.exec(key);
          const listed = record && n > 0 ? `${record[1]}${n * EDGES_APART + Number(record[2])}` : key;
          if (seen.has(listed)) continue;
          seen.add(listed);
          yield [listed, value];
        }
      }
    },
    async where(key) {
      for (const [n, view] of views.entries()) if ((await view.get(key)) !== undefined) return n;
      return -1;
    },
  };
}

/**
 * Where a community was founded among the places `state` (a union) reads,
 * and its seeds: the place of its earliest post, by the time the chain held
 * it to, and the authors of the first `count` posts there. A place it moved
 * to later adds posters, never seeds, so whoever gets a chain made for a
 * community, or posts in it there first, gains no say in it. A name is
 * first come: posts on the home chain made before a chain of its own was
 * founding posts. `posts` as read.posts gives them; `at` is -1 for none.
 */
export async function founding(state, posts, count = 5) {
  const seeds = [];
  let at = -1;
  for (const post of [...posts].sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity))) {
    const n = await state.where(`user/${post.author}/post/${post.id}`);
    if (at < 0) at = n;
    if (n !== at || seeds.includes(post.author)) continue;
    seeds.push(post.author);
    if (seeds.length === count) break;
  }
  return { at, seeds };
}

/**
 * Where a community's new posts go, from what its members declared
 * (`index/community/<segment>/<a>` on the home chain, `{ "at": "home" }` or
 * `{ "at": "own" }`): the place the most member standing chose. "own" counts
 * only when the community has a chain of its own (`hasOwn`); with none
 * chosen, or a tie, where it was founded (`founded`, by default its own
 * chain if it has one).
 * `declared` is a Map from account to its choice, `standing` and `members`
 * as memberVotes gives them. Returns `{ at, weights }`.
 */
export function chosenPlace({ declared, standing, members, hasOwn, founded = hasOwn ? "own" : "home" }) {
  const weights = { home: 0, own: 0 };
  for (const [a, at] of declared) {
    if (!members.has(a) || !(at in weights) || (at === "own" && !hasOwn)) continue;
    weights[at] += standing.get(a) ?? 0;
  }
  const fallback = founded === "own" && hasOwn ? "own" : "home";
  const other = fallback === "own" ? "home" : "own";
  return { at: weights[other] > weights[fallback] ? other : fallback, weights };
}

/** The declarations listed under `index/community/` on the home chain: a Map from name to a Map from account to its choice. A record that names no place names no community. */
export async function declarations(home) {
  const byName = new Map();
  for await (const [key, value] of home.list("index/community/")) {
    const [, , segment, a, extra] = key.split("/");
    if (!segment || !a || extra !== undefined) continue;
    const name = nameOf(segment);
    if (!isName(name)) continue;
    const at = recordOf(value)?.at;
    if (at !== "home" && at !== "own") continue;
    if (!byName.has(name)) byName.set(name, new Map());
    byName.get(name).set(a, at);
  }
  return byName;
}

/** The record by which `a` declares where `name`'s new posts should go. */
export const declare = (a, name, at) => [[`index/community/${segmentOf(name)}/${a}`, JSON.stringify({ at })]];
