//   node --test client/
import assert from "node:assert/strict";
import { test } from "node:test";
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

test("a post carries its link and media in order", async () => {
  const state = memory();
  await state.apply(
    write.post("alice", "p1", { title: "Hi", body: "text", link: "https://example.com", time: 1234 }, ["c0", "c1"]),
  );
  await state.apply(write.media("alice", "p1", 10, "c10"));
  assert.deepEqual(await read.item(state, "alice", "p1"), {
    author: "alice",
    id: "p1",
    time: 1234,
    title: "Hi",
    body: "text",
    link: "https://example.com",
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

test("votes: one per voter, changeable, retractable, kept with the voter", async () => {
  const state = memory();
  const cast = async (voter, direction, target = post) =>
    state.apply(write.vote(voter, await read.edgesOf(state, voter), target.author, target.id, direction));
  await cast("bob", 1);
  await cast("carol", -1);
  await cast("dave", 1);
  await cast("dave", -1);
  await cast("bob", 0);
  const edgesBy = new Map(await Promise.all(["bob", "carol", "dave"].map(async (a) => [a, read.edgeSets(await read.edgesOf(state, a))])));
  const { ups, downs, voters } = read.tally(edgesBy).get("alice/p1");
  assert.deepEqual([ups, downs], [0, 2]);
  assert.deepEqual([...voters.keys()].sort(), ["carol", "dave"]);
  assert.equal(state.raw.has("user/bob/edges/0"), false, "an emptied record is deleted");
  // Only the accounts that count are tallied.
  assert.deepEqual(read.tally(edgesBy, (a) => a === "carol").get("alice/p1").downs, 1);
});

test("edges: a full record starts the next; a vote changed stays where it is", async () => {
  const state = memory();
  const many = Array.from({ length: write.EDGES_PER_RECORD + 1 }, (_, n) => ({ author: "alice", id: `p${n}` }));
  for (const target of many) await state.apply(write.vote("bob", await read.edgesOf(state, "bob"), target.author, target.id, 1));
  let edges = await read.edgesOf(state, "bob");
  assert.deepEqual([...edges.keys()], [0, 1]);
  assert.equal(edges.get(0).up.length, write.EDGES_PER_RECORD);
  assert.deepEqual(edges.get(1).up, [`alice/p${write.EDGES_PER_RECORD}`]);
  // Turning the first vote down rewrites only its own record.
  const writes = write.vote("bob", edges, "alice", "p0", -1);
  assert.deepEqual(writes.map(([key]) => key), ["user/bob/edges/0"]);
  await state.apply(writes);
  edges = await read.edgesOf(state, "bob");
  assert.ok(edges.get(0).down.includes("alice/p0") && !edges.get(0).up.includes("alice/p0"));
  // A reply is listed, and taken back.
  await state.apply(write.replied("bob", edges, "carol", "c1"));
  assert.ok(read.edgeSets(await read.edgesOf(state, "bob")).reply.has("carol/c1"));
  await state.apply(write.replied("bob", await read.edgesOf(state, "bob"), "carol", "c1", false));
  assert.ok(!read.edgeSets(await read.edgesOf(state, "bob")).reply.has("carol/c1"));
});

test("edges: records that don't parse, and entries that aren't items, are skipped", async () => {
  const state = memory();
  state.raw.set("user/bob/edges/0", "not json");
  state.raw.set("user/bob/edges/x", JSON.stringify({ up: ["alice/p1"] }));
  state.raw.set("user/bob/edges/01", JSON.stringify({ up: ["alice/p9"] }));
  state.raw.set("user/bob/edges/3/x", JSON.stringify({ up: ["alice/p9"] }));
  state.raw.set("user/bob/edges/4", JSON.stringify({ up: Array.from({ length: 1000 }, (_, n) => `alice/q${n}`) }));
  state.raw.set("user/bob/edges/1", JSON.stringify({ up: ["alice/p1", "nope", 7, "a/b/c"], down: "alice/p2" }));
  state.raw.set("user/bob/edges/2", JSON.stringify({ down: ["alice/p1"] }));
  const edges = await read.edgesOf(state, "bob");
  assert.deepEqual([...edges.keys()], [1, 2, 4]);
  assert.equal(edges.get(4).up.length, read.EDGES_READ.entries, "past what an honest writer keeps is not read");
  assert.deepEqual(edges.get(1), { up: ["alice/p1"], down: [], reply: [] });
  // Voted both ways: neither.
  const sets = read.edgeSets(edges);
  assert.equal(sets.up.has("alice/p1") || sets.down.has("alice/p1"), false);
});

test("deleting a post removes it and its listing", async () => {
  const state = memory();
  await state.apply(write.post("alice", "p1", { title: "Root" }));
  await state.apply(write.post("alice", "p1", undefined));
  assert.deepEqual(await read.posts(state), []);
  assert.equal(state.raw.size, 0);
});

test("home chain: joins", async () => {
  const state = memory();
  await state.apply(write.join("alice", "bitcoin"));
  await state.apply(write.join("alice", "bitcoin/lightning"));
  await state.apply(write.join("alice", "rust"));
  await state.apply(write.join("alice", "rust", false));
  assert.deepEqual(await read.joined(state, "alice"), ["bitcoin", "bitcoin/lightning"]);
});

test("an account's items", async () => {
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

test("votes count from members: a commenter's once a member upvotes them", async () => {
  const { memberVotes, seedsOf } = await import("./standing.mjs");
  const state = memory();
  const at = (minutes) => ({ time: 1_800_000_000_000 + minutes * 60_000 });
  await state.apply(write.post("alice", "link", { title: "The whitepaper", ...at(0) }));
  await state.apply(write.post("bob", "text", { title: "Buy my coin", ...at(1) }));
  await state.apply(write.post("mod", "rules", { title: "Rules", ...at(2) }));
  const reply = async (a, id, on, parent) =>
    state.apply([...write.comment(a, id, on, { body: "…" }, parent ? { parent } : {}), ...write.replied(a, await read.edgesOf(state, a), (parent ?? on).author, (parent ?? on).id)]);
  const link = { author: "alice", id: "link" }, text = { author: "bob", id: "text" };
  await reply("bob", "c1", link);
  await reply("carol", "c2", link, { author: "bob", id: "c1" });
  const cast = async (a, target, direction) => state.apply(write.vote(a, await read.edgesOf(state, a), target.author, target.id, direction));
  await cast("carol", link, 1);
  await cast("carol", text, -1);
  await cast("carol", { author: "bob", id: "c1" }, 1);
  await cast("mod", link, 1);
  await cast("mod", text, -1);
  await cast("carol", text, 1);

  const seeds = seedsOf(await read.posts(state));
  assert.deepEqual(seeds, ["alice", "bob", "mod"]);
  const count = (votes, target) => [votes.get(target)?.ups ?? 0, votes.get(target)?.downs ?? 0];
  let { members, votes } = await memberVotes(state, seeds);
  assert.ok(!members.has("carol"), "nobody has engaged with Carol");
  assert.deepEqual([count(votes, "alice/link"), count(votes, "bob/text"), count(votes, "bob/c1")], [[1, 0], [0, 1], [0, 0]]);

  // Alice upvotes Carol's reply: Carol is a member, and her votes count.
  await cast("alice", { author: "carol", id: "c2" }, 1);
  ({ members, votes } = await memberVotes(state, seeds));
  assert.ok(members.has("carol"));
  assert.deepEqual([count(votes, "alice/link"), count(votes, "bob/text"), count(votes, "bob/c1")], [[2, 0], [1, 1], [1, 0]]);
});
