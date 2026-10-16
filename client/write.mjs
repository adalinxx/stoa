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

/** `a`'s custom feed `name`: a list of communities, or undefined to delete it. */
export const feed = (a, name, communities) => [[`user/${a}/feed/${name}`, json(communities)]];

/** `a` follows, or with `following` false stops following, a moderator's marks in a community. */
export const followModerator = (a, community, mod, following = true) => [
  [`user/${a}/follow-mod/${community}/${mod}`, flag(following)],
];

/** `a` advertises a community `{ about }`, so clients can list communities. */
export const advertise = (a, community, value) => [[`index/community/${community}/${a}`, json(value)]];

// Community chains.

const mediaWrites = (a, id, cids) => cids.map((cid, n) => [`user/${a}/post/${id}/media/${n}`, cid]);

/**
 * A post `{ title, body?, link?, tags? }` with the CIDs of its media, listed
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

/** `voter`'s vote on `author`'s post or comment `id`: 1, -1, or 0 to take it back. */
export const vote = (voter, author, id, direction) => [
  [`index/vote/${author}/${id}/${voter}`, direction === 0 ? undefined : String(Math.sign(direction))],
];

/**
 * A labelled comment: `a` labels the post `on` (`{ author, id }`) or, when
 * `target` is given, that comment in its thread, e.g. `["spam"]`, with an
 * optional reason. Moderation is this and nothing more: a reader whose client
 * follows `a` applies the labels; everyone else sees a comment. A report is
 * the same, from an account no reader follows as a moderator. Delete or edit
 * the comment to take it back.
 */
export const label = (a, id, on, labels, { target, body = "" } = {}) =>
  comment(a, id, on, { body, labels }, target ? { parent: target } : {});

/** `a`'s flair in the community. */
export const flair = (a, text) => [[`user/${a}/flair`, text]];
