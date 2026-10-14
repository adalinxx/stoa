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
const labelList = (value) => {
  const labels = parse(value);
  return Array.isArray(labels) ? labels.filter((label) => typeof label === "string") : [];
};
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
 * `author`'s post or comment `id`, or undefined: `{ author, id, title?, body?,
 * link?, tags, on?, parent?, media }`. `on` and `parent` are `{ author, id }`.
 */
export async function item(state, author, id) {
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
    ...(text("title") !== undefined && { title: text("title") }),
    ...(text("body") !== undefined && { body: text("body") }),
    ...(text("link") !== undefined && { link: text("link") }),
    tags: Array.isArray(record.tags) ? record.tags.filter((tag) => typeof tag === "string") : [],
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

/** `{ ups, downs, voters }` for an item; `voters` maps each voter to 1 or -1. */
export async function votes(state, author, id) {
  const voters = new Map();
  for await (const [key, value] of state.list(`index/vote/${author}/${id}/`)) {
    const direction = Number(value);
    if (direction === 1 || direction === -1) voters.set(key.slice(key.lastIndexOf("/") + 1), direction);
  }
  let ups = 0;
  for (const direction of voters.values()) if (direction === 1) ups++;
  return { ups, downs: voters.size - ups, voters };
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

/** The accounts offering to moderate, each with its `{ rules, labels }`. */
export async function moderators(state) {
  const found = new Map();
  for await (const [key, value] of state.list("index/moderator/")) {
    const offer = parse(value);
    if (isObject(offer)) found.set(key.slice("index/moderator/".length), offer);
  }
  return found;
}

/**
 * One moderator's marks: `items` maps `"<author>/<id>"` and `accounts` maps
 * an account to the labels the moderator gave it.
 */
export async function marks(state, mod) {
  const items = new Map();
  const accounts = new Map();
  for await (const [key, value] of state.list(`user/${mod}/mark/`)) {
    const target = key.slice(`user/${mod}/mark/`.length);
    if (ref(target)) items.set(target, labelList(value));
  }
  for await (const [key, value] of state.list(`user/${mod}/mark-user/`)) {
    accounts.set(key.slice(`user/${mod}/mark-user/`.length), labelList(value));
  }
  return { items, accounts };
}

/** The mod queue: `"<author>/<id>"` → the reports on it as `[reporter, reason]`. */
export async function reports(state) {
  const queue = new Map();
  for await (const [key, reason] of state.list("index/report/")) {
    const [, , author, id, reporter] = key.split("/");
    const target = `${author}/${id}`;
    if (!queue.has(target)) queue.set(target, []);
    queue.get(target).push([reporter, reason]);
  }
  return queue;
}

/** `a`'s flair in the community, or undefined. */
export const flair = (state, a) => state.get(`user/${a}/flair`);

// Home chain.

/** `a`'s profile, or undefined. */
export async function profile(state, a) {
  const value = parse(await state.get(`user/${a}/profile`));
  return isObject(value) ? value : undefined;
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
