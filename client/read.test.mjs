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
    write.post("alice", "p1", { title: "Hi", body: "text", link: "https://example.com", tags: ["oc"], time: 1234 }, ["c0", "c1"]),
  );
  await state.apply(write.media("alice", "p1", 10, "c10"));
  assert.deepEqual(await read.item(state, "alice", "p1"), {
    author: "alice",
    id: "p1",
    time: 1234,
    title: "Hi",
    body: "text",
    link: "https://example.com",
    tags: ["oc"],
    labels: [],
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

test("moderation is labelled comments; a reader's followed accounts decide what their client shows", async () => {
  const state = memory();
  await state.apply(write.post("alice", "p1", { title: "Root" }));
  await state.apply(write.comment("eve", "c1", post, { body: "buy my coin" }));
  await state.apply(write.label("mod1", "m1", post, ["spam"], { body: "Scam link." }));
  await state.apply(write.label("mod2", "m2", post, ["nsfw"]));
  await state.apply(write.label("mod2", "m3", post, ["spam"], { target: { author: "eve", id: "c1" } }));
  // A report is the same thing from an account nobody follows.
  await state.apply(write.label("bob", "r1", post, ["report: spam"]));

  const labelled = await read.labelsBy(state, "mod2");
  assert.deepEqual(labelled, new Map([["alice/p1", ["nsfw"]], ["eve/c1", ["spam"]]]));

  const sets = async (...mods) => new Map(await Promise.all(mods.map(async (m) => [m, await read.labelsBy(state, m)])));
  const actions = { spam: "hide", nsfw: "blur" };
  assert.equal(judge(await sets(), actions)(post).treatment, "show", "a reader following no one sees everything");
  assert.equal(judge(await sets("mod2"), actions)(post).treatment, "blur");
  assert.equal(judge(await sets("mod1", "mod2"), actions)(post).treatment, "hide");
  assert.equal(judge(await sets("mod2"), actions)({ author: "eve", id: "c1" }).treatment, "hide", "a comment can be labelled");
  assert.equal(judge(await sets("bob"), {})(post).treatment, "badge", "an unnamed label gets the default");

  // Labelled comments are comments: in the thread like any other.
  const tree = await read.thread(state, "alice", "p1");
  assert.deepEqual(tree.replies.map((c) => c.id).sort(), ["c1", "m1", "m2", "r1"]);
  assert.deepEqual(tree.replies.find((c) => c.id === "c1").replies.map((c) => c.id), ["m3"]);
  assert.deepEqual(tree.replies.find((c) => c.id === "m1").labels, ["spam"]);

  // Deleting the comment takes the label back.
  await state.apply(write.comment("mod1", "m1", post, undefined));
  assert.equal(judge(await sets("mod1"), actions)(post).treatment, "show");
});

test("home chain: joins, followed moderators, communities", async () => {
  const state = memory();
  await state.apply(write.join("alice", "bitcoin"));
  await state.apply(write.join("alice", "bitcoin/lightning"));
  await state.apply(write.join("alice", "rust"));
  await state.apply(write.join("alice", "rust", false));
  await state.apply(write.followModerator("alice", "bitcoin", "mod1"));
  await state.apply(write.advertise("bob", "bitcoin/lightning", { about: "LN" }));
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

test("a post and a comment say when they were written; one saying none reads as 0", async () => {
  const state = memory();
  const before = Date.now();
  await state.apply(write.post("alice", "p1", { title: "Hi" }));
  await state.apply(write.comment("bob", "c1", { author: "alice", id: "p1" }, { body: "yo" }));
  const [post, comment] = [await read.item(state, "alice", "p1"), await read.item(state, "bob", "c1")];
  for (const item of [post, comment]) assert.ok(item.time >= before && item.time <= Date.now());
  state.raw.set("user/carol/post/x", JSON.stringify({ title: "old" }));
  assert.equal((await read.item(state, "carol", "x")).time, 0);
});

test("a changed post keeps its time, a retried one changes nothing, and an empty id is no post", async () => {
  const state = memory();
  await state.apply(write.post("alice", "p1", { title: "Hi" }));
  const first = (await read.item(state, "alice", "p1")).time;
  const edit = await write.changes(state, write.post("alice", "p1", { title: "Hi again" }), first + 999_999);
  assert.equal(JSON.parse(edit[0].newValue).time, first);
  const retry = await write.changes(state, write.post("alice", "p1", { title: "Hi" }), first + 999_999);
  assert.equal(retry[0].newValue, retry[0].oldValue, "the same post again is no change");
  await state.apply([["user/alice/post/", JSON.stringify({ title: "x", time: 1 })], ["index/post//alice", "1"]]);
  assert.equal(await read.item(state, "alice", ""), undefined);
  assert.deepEqual((await read.posts(state)).map((p) => p.id), ["p1"]);
});

test("a profile: its owner's name, bio and link, each checked and cut to its limit", async () => {
  const state = memory();
  assert.equal(await read.profile(state, "alice"), undefined);
  await state.apply(write.profile("alice", { name: "  Alice Ng ", bio: "", link: "https://alice.example" }));
  assert.equal(state.raw.get("user/alice/profile"), JSON.stringify({ name: "Alice Ng", link: "https://alice.example" }));
  assert.deepEqual(await read.profile(state, "alice"), { name: "Alice Ng", link: "https://alice.example" });
  // Written by hand: what isn't text, a link that isn't http(s), and the excess are dropped.
  state.raw.set("user/bob/profile", JSON.stringify({ name: "B".repeat(80), bio: 7, link: "javascript:alert(1)" }));
  assert.deepEqual(await read.profile(state, "bob"), { name: "B".repeat(read.PROFILE_LIMITS.name) });
  // A link over its limit is dropped, not cut short into another address.
  state.raw.set("user/dan/profile", JSON.stringify({ name: "Dan", link: `https://dan.example/${"x".repeat(read.PROFILE_LIMITS.link)}` }));
  assert.deepEqual(await read.profile(state, "dan"), { name: "Dan" });
  state.raw.set("user/carol/profile", "not json");
  assert.equal(await read.profile(state, "carol"), undefined);
  // Emptied, it is deleted.
  await state.apply(write.profile("alice", { name: " ", bio: "" }));
  assert.equal(state.raw.has("user/alice/profile"), false);
});
