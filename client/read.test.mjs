//   node --test client/
import assert from "node:assert/strict";
import { test } from "node:test";
import { judge } from "./moderation.mjs";
import * as read from "./read.mjs";
import * as write from "./write.mjs";

/** A state view over a Map, applying writes the way consensus would. */
function memory() {
  const map = new Map();
  return {
    get: async (key) => map.get(key),
    async *list(prefix) {
      for (const key of [...map.keys()].sort()) if (key.startsWith(prefix)) yield [key, map.get(key)];
    },
    async apply(writes) {
      for (const { key, newValue } of await write.changes(this, writes)) {
        if (newValue === undefined) map.delete(key);
        else map.set(key, newValue);
      }
    },
    raw: map,
  };
}

const post = { author: "alice", id: "p1" };

test("a post carries its link, tags and media in order", async () => {
  const state = memory();
  await state.apply(
    write.post("alice", "p1", { title: "Hi", body: "text", link: "https://example.com", tags: ["oc"] }, ["c0", "c1"]),
  );
  await state.apply(write.media("alice", "p1", 10, "c10"));
  assert.deepEqual(await read.item(state, "alice", "p1"), {
    author: "alice",
    id: "p1",
    title: "Hi",
    body: "text",
    link: "https://example.com",
    tags: ["oc"],
    media: ["c0", "c1", "c10"],
  });
  assert.equal((await read.posts(state)).length, 1);
});

test("media of one post never leaks into another whose id it prefixes", async () => {
  const state = memory();
  await state.apply(write.post("alice", "p", { title: "short" }, ["only-p"]));
  await state.apply(write.post("alice", "p1", { title: "long" }));
  assert.deepEqual((await read.item(state, "alice", "p")).media, ["only-p"]);
  assert.deepEqual((await read.item(state, "alice", "p1")).media, []);
});

test("a thread nests comments under their parents", async () => {
  const state = memory();
  await state.apply(write.post("alice", "p1", { title: "Root" }));
  await state.apply(write.comment("bob", "c1", post, { body: "first" }));
  await state.apply(write.comment("carol", "c2", post, { body: "reply" }, { parent: { author: "bob", id: "c1" } }));
  await state.apply(write.comment("dave", "c3", post, { body: "orphan" }, { parent: { author: "nobody", id: "x" } }));
  const tree = await read.thread(state, "alice", "p1");
  assert.deepEqual(
    tree.replies.map((c) => c.id),
    ["c1", "c3"],
  );
  assert.deepEqual(
    tree.replies[0].replies.map((c) => c.id),
    ["c2"],
  );
  // Comments are not posts.
  assert.deepEqual(
    (await read.posts(state)).map((p) => p.id),
    ["p1"],
  );
});

test("a listing that its own record does not back is ignored", async () => {
  const state = memory();
  await state.apply([[`index/post/ghost/alice`, "1"]]);
  await state.apply([[`index/comment/alice/p1/c9/bob`, "1"]]);
  await state.apply(write.post("alice", "p1", { title: "Root" }));
  await state.apply([[`user/bob/post/c9`, JSON.stringify({ body: "elsewhere", on: "alice/other" })]]);
  await state.apply([[`user/eve/post/bad`, "not json"], [`index/post/bad/eve`, "1"]]);
  assert.deepEqual(
    (await read.posts(state)).map((p) => p.id),
    ["p1"],
  );
  assert.deepEqual((await read.thread(state, "alice", "p1")).replies, []);
});

test("votes: one per voter, changeable, retractable", async () => {
  const state = memory();
  await state.apply(write.vote("bob", "alice", "p1", 1));
  await state.apply(write.vote("carol", "alice", "p1", -1));
  await state.apply(write.vote("dave", "alice", "p1", 1));
  await state.apply(write.vote("dave", "alice", "p1", -1));
  await state.apply(write.vote("bob", "alice", "p1", 0));
  const { ups, downs, voters } = await read.votes(state, "alice", "p1");
  assert.deepEqual([ups, downs], [0, 2]);
  assert.deepEqual([...voters.keys()].sort(), ["carol", "dave"]);
});

test("deleting a post removes it and its listing", async () => {
  const state = memory();
  await state.apply(write.post("alice", "p1", { title: "Root" }));
  await state.apply(write.post("alice", "p1", undefined));
  assert.deepEqual(await read.posts(state), []);
  assert.equal(state.raw.size, 0);
});

test("marks: a reader's moderators decide what their client shows", async () => {
  const state = memory();
  await state.apply(write.moderate("mod1", { rules: "be kind", labels: ["spam", "nsfw"] }));
  await state.apply(write.mark("mod1", "alice", "p1", ["spam"]));
  await state.apply(write.mark("mod2", "alice", "p1", ["nsfw"]));
  await state.apply(write.markUser("mod2", "eve", ["spam"]));
  await state.apply(write.report("bob", "alice", "p1", "spam"));
  await state.apply(write.report("carol", "alice", "p1", "off-topic"));

  assert.deepEqual([...(await read.moderators(state)).keys()], ["mod1"]);
  assert.deepEqual(await read.reports(state), new Map([["alice/p1", [["bob", "spam"], ["carol", "off-topic"]]]]));

  const sets = async (...mods) => new Map(await Promise.all(mods.map(async (mod) => [mod, await read.marks(state, mod)])));
  const actions = { spam: "hide", nsfw: "blur" };
  assert.equal(judge(await sets(), actions)(post).treatment, "show");
  assert.equal(judge(await sets("mod2"), actions)(post).treatment, "blur");
  assert.equal(judge(await sets("mod1", "mod2"), actions)(post).treatment, "hide");
  assert.equal(judge(await sets("mod2"), actions)({ author: "eve", id: "any" }).treatment, "hide");
  assert.equal(judge(await sets("mod1"), {})(post).treatment, "badge", "an unnamed label gets the default");

  await state.apply(write.mark("mod1", "alice", "p1", []));
  assert.equal(judge(await sets("mod1"), actions)(post).treatment, "show", "a mark taken back");
});

test("home chain: profile, joins, followed moderators, communities", async () => {
  const state = memory();
  await state.apply(write.profile("alice", { name: "Alice", about: "hi" }));
  await state.apply(write.join("alice", "bitcoin"));
  await state.apply(write.join("alice", "bitcoin/lightning"));
  await state.apply(write.join("alice", "rust"));
  await state.apply(write.join("alice", "rust", false));
  await state.apply(write.followModerator("alice", "bitcoin", "mod1"));
  await state.apply(write.advertise("bob", "bitcoin/lightning", { about: "LN" }));
  assert.deepEqual(await read.profile(state, "alice"), { name: "Alice", about: "hi" });
  assert.deepEqual(await read.joined(state, "alice"), ["bitcoin", "bitcoin/lightning"]);
  assert.deepEqual(await read.followedModerators(state, "alice", "bitcoin"), ["mod1"]);
  assert.deepEqual(await read.communities(state), new Map([["bitcoin/lightning", new Map([["bob", { about: "LN" }]])]]));
});

test("an account's items, for karma", async () => {
  const state = memory();
  await state.apply(write.post("alice", "p1", { title: "Root" }, ["m"]));
  await state.apply(write.comment("alice", "c1", { author: "bob", id: "p" }, { body: "hi" }));
  assert.deepEqual(
    (await read.itemsBy(state, "alice")).map((i) => i.id),
    ["c1", "p1"],
  );
});
