// Builds the transactions that write records. A record change is a
// general-state action `{ key, oldValue?, newValue? }`: consensus applies it
// only when `oldValue` is what the key holds now, so a change is always made
// against a state the writer has read.

const POST = /^user\/[^/]+\/post\/[^/]+$/;

/**
 * A post or comment says when it was written, and the chain's policy holds
 * that to the block that creates it: a new one is stamped `time`, a changed
 * one keeps the time it has.
 */
function stamped(key, newValue, oldValue, time) {
  if (newValue === undefined || !POST.test(key)) return newValue;
  const parse = (value) => {
    try {
      return JSON.parse(value);
    } catch {}
  };
  const record = parse(newValue);
  if (typeof record !== "object" || record === null || Array.isArray(record)) return newValue;
  return JSON.stringify({ ...record, time: parse(oldValue)?.time ?? record.time ?? time });
}

/**
 * The actions for a list of `[key, value]` writes against `state` (a view,
 * see state.mjs), as of `time` (when a new post or comment says it was
 * written). A value of undefined deletes the key.
 */
export async function changes(state, writes, time = Date.now()) {
  const actions = await Promise.all(
    writes.map(async ([key, value]) => {
      const oldValue = await state.get(key);
      const newValue = stamped(key, value, oldValue, time);
      return {
        key,
        ...(oldValue !== undefined && { oldValue }),
        ...(newValue !== undefined && { newValue }),
      };
    }),
  );
  // Deleting a key that is not there changes nothing.
  return actions.filter((action) => "oldValue" in action || "newValue" in action);
}

/** A transaction body carrying `actions`, signed for and paid by `owner`. */
export function transaction({ owner, actions, fee, nonce, chainPath }) {
  return {
    accountActions: fee > 0n ? [{ owner, delta: -fee }] : [],
    actions,
    depositActions: [],
    receiptActions: [],
    withdrawalActions: [],
    signers: [owner],
    nonce,
    chainPath: [...chainPath],
  };
}

/** A new id for a post or comment. Ids carry no meaning; the time is in the record. */
export const newId = () =>
  [...crypto.getRandomValues(new Uint8Array(8))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

// The record conventions in the README. Each returns the `[key, value]`
// writes for one act; a value of undefined deletes the key.

const json = (value) => (value === undefined ? undefined : JSON.stringify(value));
const flag = (on) => (on ? "1" : undefined);

// Home chain.

/** `a` joins a community, or leaves it with `joined` false. */
export const join = (a, community, joined = true) => [[`user/${a}/join/${community}`, flag(joined)]];



// Community chains.

const mediaWrites = (a, id, cids) => cids.map((cid, n) => [`user/${a}/post/${id}/media/${n}`, cid]);

/**
 * A post `{ title, body?, link? }` with the CIDs of its media, listed
 * in the community. Undefined deletes the post and its listing (delete media
 * with `media`).
 */
export const post = (a, id, value, mediaCIDs = []) => [
  [`user/${a}/post/${id}`, json(value)],
  [`index/post/${id}/${a}`, flag(value !== undefined)],
  ...mediaWrites(a, id, mediaCIDs),
];

/**
 * A comment `{ body, link? }` on the post `on` = `{ author, id }`, answering
 * the comment `parent` = `{ author, id }` or, without it, the post. A comment
 * is a post with no title, so votes, marks and media work the same on both.
 */
export const comment = (a, id, on, value, { parent, mediaCIDs = [] } = {}) => [
  [
    `user/${a}/post/${id}`,
    json(
      value && {
        ...value,
        on: `${on.author}/${on.id}`,
        ...(parent && { parent: `${parent.author}/${parent.id}` }),
      },
    ),
  ],
  [`index/comment/${on.author}/${on.id}/${id}/${a}`, flag(value !== undefined)],
  ...mediaWrites(a, id, mediaCIDs),
];

/** The `n`th media CID of `a`'s post or comment `id`; undefined deletes it. */
export const media = (a, id, n, cid) => [[`user/${a}/post/${id}/media/${n}`, cid]];

// An account's votes, kept together so that everything it vouched for is
// one or two records to read: `user/<a>/edges/<n>` holds `{ up, down }`,
// lists of `<author>/<id>`, at most EDGES_PER_RECORD entries in all. `edges`
// below is an account's records as `read.edgesOf` returns them, a Map from n
// to `{ up, down }`.

/** Most entries one edges record holds; past it, a new record is started. */
export const EDGES_PER_RECORD = 64;

const KINDS = ["up", "down"];

/**
 * The writes that take `target` out of the lists `from` in `a`'s edges and,
 * if `to` is given, put it in that list: in the record it was in, else the
 * last with room, else a new one. Only records that change are written; an
 * emptied one is deleted.
 */
function moveEdge(a, edges, target, from, to) {
  const records = new Map([...edges].map(([n, record]) => [n, Object.fromEntries(KINDS.map((kind) => [kind, [...(record[kind] ?? [])]]))]));
  const changed = new Set();
  let home;
  for (const [n, record] of records) {
    for (const kind of from) {
      if (!record[kind].includes(target)) continue;
      record[kind] = record[kind].filter((entry) => entry !== target);
      changed.add(n);
      home ??= n;
    }
  }
  if (to !== undefined && ![...records.values()].some((record) => record[to].includes(target))) {
    const size = (record) => KINDS.reduce((total, kind) => total + record[kind].length, 0);
    const numbers = [...records.keys()];
    const last = numbers.length ? Math.max(...numbers) : undefined;
    const n = home ?? (last !== undefined && size(records.get(last)) < EDGES_PER_RECORD ? last : (last ?? -1) + 1);
    if (!records.has(n)) records.set(n, { up: [], down: [] });
    records.get(n)[to].push(target);
    changed.add(n);
  }
  return [...changed].map((n) => {
    const record = records.get(n);
    const kept = Object.fromEntries(KINDS.filter((kind) => record[kind].length).map((kind) => [kind, record[kind]]));
    return [`user/${a}/edges/${n}`, Object.keys(kept).length ? json(kept) : undefined];
  });
}

/**
 * `a`'s vote on `author`'s post or comment `id`: 1, -1, or 0 to take it
 * back, as a change to `a`'s edges records (`edges`, as `read.edgesOf`
 * returns them).
 */
export const vote = (a, edges, author, id, direction) =>
  moveEdge(a, edges, `${author}/${id}`, ["up", "down"], direction > 0 ? "up" : direction < 0 ? "down" : undefined);


// Home chain: the profile.

/**
 * `a`'s Stoa profile `{ name?, bio?, link? }`, kept on the home chain; empty
 * fields are dropped, and undefined (or nothing left) deletes it.
 */
export const profile = (a, value) => {
  const kept = Object.fromEntries(Object.entries(value ?? {}).filter(([, v]) => typeof v === "string" && v.trim()).map(([k, v]) => [k, v.trim()]));
  return [[`user/${a}/profile`, Object.keys(kept).length ? json(kept) : undefined]];
};

// Follows (https://github.com/adalinxx/follows), the follow graph every app
// shares: `a` following `t` (an account, or `@<handle>`) is two keys, always
// written together, the `followers/` twin directly after its `follows/` key.

/** `a` follows `t`, or stops with `on` false. */
export const follow = (a, t, on = true) => [
  [`follows/${a}/${t}`, flag(on)],
  [`followers/${t}/${a}`, flag(on)],
];
