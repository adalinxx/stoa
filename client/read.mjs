// Reads Stoa's records from a state view `{ get(key), list(prefix) }` (see
// state.mjs). Records are written by anyone, so every value is parsed as
// untrusted: a record that does not parse is skipped, never fatal.

const parse = (value) => {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const labelList = (labels) =>
  Array.isArray(labels) ? labels.filter((label) => typeof label === "string") : [];
const ref = (text) => {
  const [author, id, ...rest] = typeof text === "string" ? text.split("/") : [];
  return author && id && rest.length === 0 ? { author, id } : undefined;
};
async function collect(entries) {
  const found = [];
  for await (const entry of entries) found.push(entry);
  return found;
}

// Community chains.

/**
 * `author`'s post or comment `id`, or undefined: `{ author, id, time, title?,
 * body?, link?, tags, on?, parent?, media }`. `on` and `parent` are
 * `{ author, id }`; `time` is when it says it was written (milliseconds; the
 * chain's policy holds it to its block), or 0 when it says none.
 */
export async function item(state, author, id) {
  if (!author || !id) return undefined;
  const [value, media] = await Promise.all([
    state.get(`user/${author}/post/${id}`),
    collect(state.list(`user/${author}/post/${id}/media/`)),
  ]);
  const record = parse(value);
  if (!isObject(record)) return undefined;
  const text = (field) => (typeof record[field] === "string" ? record[field] : undefined);
  const on = ref(record.on);
  const parent = ref(record.parent);
  return {
    author,
    id,
    time: Number.isSafeInteger(record.time) && record.time > 0 ? record.time : 0,
    ...(text("title") !== undefined && { title: text("title") }),
    ...(text("body") !== undefined && { body: text("body") }),
    ...(text("link") !== undefined && { link: text("link") }),
    tags: Array.isArray(record.tags) ? record.tags.filter((tag) => typeof tag === "string") : [],
    labels: labelList(record.labels),
    ...(on && { on }),
    ...(parent && { parent }),
    media: media
      .map(([key, cid]) => [Number(key.slice(key.lastIndexOf("/") + 1)), cid])
      .filter(([n]) => Number.isInteger(n))
      .sort(([a], [b]) => a - b)
      .map(([, cid]) => cid),
  };
}

/** Every post listed in the community, as `item` reads them. */
export async function posts(state) {
  const listed = await collect(state.list("index/post/"));
  const found = await Promise.all(
    listed.map(([key]) => {
      const [, , id, author] = key.split("/");
      return item(state, author, id);
    }),
  );
  // A listing is its writer's claim; the post itself must agree.
  return found.filter((post) => post?.title !== undefined && post.on === undefined);
}

const EDGE = /^[^/]+\/[^/]+$/;
const RECORD = /^(0|[1-9]\d*)$/;
/** Most edges records, and entries in each, read for one account: past what an honest writer keeps, the rest is not read. */
export const EDGES_READ = { records: 64, entries: 64 };

/**
 * `a`'s edges records (see write.mjs): a Map from n to `{ up, down, reply }`,
 * each a list of `<author>/<id>`. A record that doesn't parse, and any entry
 * that isn't `<author>/<id>`, is skipped; an item voted both ways counts as
 * neither.
 */
export async function edgesOf(state, a) {
  const records = new Map();
  const prefix = `user/${a}/edges/`;
  for await (const [key, value] of state.list(prefix)) {
    if (records.size >= EDGES_READ.records) break;
    const name = key.slice(prefix.length);
    if (!RECORD.test(name)) continue;
    const n = Number(name);
    if (!Number.isSafeInteger(n)) continue;
    let record;
    try {
      record = JSON.parse(value);
    } catch {
      continue;
    }
    if (typeof record !== "object" || record === null || Array.isArray(record)) continue;
    const list = (kind) =>
      Array.isArray(record[kind]) ? record[kind].slice(0, EDGES_READ.entries).filter((entry) => typeof entry === "string" && EDGE.test(entry)) : [];
    records.set(n, { up: list("up"), down: list("down"), reply: list("reply") });
  }
  return records;
}

/** `edges` (as `edgesOf` returns them) as sets: `{ up, down, reply }`. */
export function edgeSets(edges) {
  const sets = { up: new Set(), down: new Set(), reply: new Set() };
  for (const record of edges.values()) for (const kind of ["up", "down", "reply"]) for (const entry of record[kind]) sets[kind].add(entry);
  for (const entry of sets.up) if (sets.down.has(entry)) (sets.up.delete(entry), sets.down.delete(entry));
  return sets;
}

/**
 * Votes by item from `setsBy` (a Map from account to its edges as sets, as
 * `edgeSets` makes them), counting only the accounts `counts` admits (the
 * members): a Map from `<author>/<id>` to `{ ups, downs, voters }`, `voters`
 * mapping each voter to 1 or -1.
 */
export function tally(setsBy, counts = () => true) {
  const items = new Map();
  const of = (target) => items.get(target) ?? items.set(target, { ups: 0, downs: 0, voters: new Map() }).get(target);
  for (const [a, { up, down }] of setsBy) {
    if (!counts(a)) continue;
    for (const target of up) (of(target).ups++, of(target).voters.set(a, 1));
    for (const target of down) (of(target).downs++, of(target).voters.set(a, -1));
  }
  return items;
}

/**
 * A post and its comments as a tree: the post with `replies`, each comment
 * with its own. A comment whose parent is missing (deleted, or never there)
 * answers the post.
 */
export async function thread(state, author, id) {
  const root = await item(state, author, id);
  if (!root) return undefined;
  const listed = await collect(state.list(`index/comment/${author}/${id}/`));
  const comments = (
    await Promise.all(
      listed.map(([key]) => {
        const [, , , , commentId, commentAuthor] = key.split("/");
        return item(state, commentAuthor, commentId);
      }),
    )
  ).filter((comment) => comment?.on?.author === author && comment.on.id === id);
  const byKey = new Map([[`${author}/${id}`, root], ...comments.map((c) => [`${c.author}/${c.id}`, c])]);
  for (const node of byKey.values()) node.replies = [];
  for (const comment of comments) {
    const parent = comment.parent && byKey.get(`${comment.parent.author}/${comment.parent.id}`);
    (parent && parent !== comment ? parent : root).replies.push(comment);
  }
  return root;
}

/** Every post and comment `a` has in the community. */
export async function itemsBy(state, a) {
  const ids = [];
  for await (const [key] of state.list(`user/${a}/post/`)) {
    const rest = key.slice(`user/${a}/post/`.length);
    if (!rest.includes("/")) ids.push(rest);
  }
  return (await Promise.all(ids.map((id) => item(state, a, id)))).filter(Boolean);
}

/**
 * The labels `a`'s labelled comments put on items: `"<author>/<id>"` → labels.
 * A labelled comment labels the comment it answers, or the post when it
 * answers the post. One prefix scan of `a`'s items.
 */
export async function labelsBy(state, a) {
  const labelled = new Map();
  for (const comment of await itemsBy(state, a)) {
    if (!comment.on || comment.labels.length === 0) continue;
    const target = comment.parent ?? comment.on;
    const key = `${target.author}/${target.id}`;
    labelled.set(key, [...(labelled.get(key) ?? []), ...comment.labels]);
  }
  return labelled;
}

/** `a`'s flair in the community, or undefined. */
export const flair = (state, a) => state.get(`user/${a}/flair`);

// Home chain.

/** Longest a profile's fields are shown: a name, a bio, a link. */
export const PROFILE_LIMITS = { name: 50, bio: 500, link: 300 };

/**
 * `a`'s Stoa profile, `{ name?, bio?, link? }`, or undefined. Written by its
 * owner only, but read like any record: a field that isn't text, a link that
 * isn't http(s) or is too long, is dropped, and the rest is cut to its limit.
 */
export async function profile(state, a) {
  const record = parse(await state.get(`user/${a}/profile`));
  if (!isObject(record)) return undefined;
  const found = {};
  for (const [field, most] of Object.entries(PROFILE_LIMITS)) {
    const text = typeof record[field] === "string" ? record[field].trim() : "";
    // A link cut short leads somewhere else: one over its limit is dropped.
    const value = field === "link" && text.length > most ? "" : text.slice(0, most);
    if (value) found[field] = value;
  }
  if (found.link && !/^https?:\/\/[^\s]+$/i.test(found.link)) delete found.link;
  return Object.keys(found).length ? found : undefined;
}

/** The communities `a` has joined. */
export async function joined(state, a) {
  const prefix = `user/${a}/join/`;
  return (await collect(state.list(prefix))).map(([key]) => key.slice(prefix.length));
}

/** The moderators `a` follows in `community`. */
export async function followedModerators(state, a, community) {
  const prefix = `user/${a}/follow-mod/${community}/`;
  return (await collect(state.list(prefix))).map(([key]) => key.slice(prefix.length));
}

/** Advertised communities: name → the accounts advertising it, with each `{ about }`. */
export async function communities(state) {
  const found = new Map();
  for await (const [key, value] of state.list("index/community/")) {
    const segments = key.split("/");
    const name = segments.slice(2, -1).join("/");
    if (!name) continue;
    if (!found.has(name)) found.set(name, new Map());
    found.get(name).set(segments.at(-1), parse(value));
  }
  return found;
}
