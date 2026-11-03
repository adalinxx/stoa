//   node --test client/
import assert from "node:assert/strict";
import { test } from "node:test";
import * as places from "./places.mjs";
import * as read from "./read.mjs";
import * as write from "./write.mjs";

/** A chain's state over a Map, applying writes the way consensus would. */
function memory() {
  const map = new Map();
  return {
    get: async (key) => map.get(key),
    async *list(prefix) {
      for (const key of [...map.keys()].sort()) if (key.startsWith(prefix)) yield [key, map.get(key)];
    },
    async apply(writes) {
      for (const { key, newValue } of await write.changes(this, writes)) newValue === undefined ? map.delete(key) : map.set(key, newValue);
    },
    raw: map,
  };
}

test("names: a-z, 0-9 and -, up to four segments; never all", () => {
  for (const ok of ["bitcoin", "bitcoin/lightning", "a-b/c/d/e", "9"]) assert.ok(places.isName(ok), ok);
  for (const bad of ["all", "", "Bitcoin", "-x", "a//b", "a/b/c/d/e", "a.b", "a b", "x".repeat(33)]) assert.ok(!places.isName(bad), bad);
  assert.equal(places.nameOf(places.segmentOf("bitcoin/lightning")), "bitcoin/lightning");
});

test("on the home chain, a community's records are its own: posts, comments, votes", async () => {
  const home = memory();
  const apply = (name, writes) => home.apply(places.scopeWrites(name, writes));
  await apply("bitcoin", write.post("alice", "p1", { title: "Halving" }, ["cid0"]));
  await apply("rust", write.post("bob", "p2", { title: "Borrowing" }));
  await apply("bitcoin", write.comment("carol", "c1", { author: "alice", id: "p1" }, { body: "Soon" }));
  const bitcoin = places.scoped(home, "bitcoin");
  await apply("bitcoin", write.vote("carol", await read.edgesOf(bitcoin, "carol"), "alice", "p1", 1));

  // The keys as the home chain holds them: the post keeps its key, and says where it is.
  assert.ok(home.raw.has("index/c/bitcoin/post/p1/alice"));
  assert.ok(home.raw.has("user/carol/c/bitcoin/edges/0"));
  assert.equal(JSON.parse(home.raw.get("user/alice/post/p1")).c, "bitcoin");

  const posts = await read.posts(bitcoin);
  assert.deepEqual(posts.map((p) => [p.author, p.id, p.title, p.media]), [["alice", "p1", "Halving", ["cid0"]]]);
  const tree = await read.thread(bitcoin, "alice", "p1");
  assert.deepEqual(tree.replies.map((r) => r.body), ["Soon"]);
  assert.deepEqual([...read.edgeSets(await read.edgesOf(bitcoin, "carol")).up], ["alice/p1"]);

  // Another community sees none of it, even an author's post by its key.
  const rust = places.scoped(home, "rust");
  assert.deepEqual((await read.posts(rust)).map((p) => p.id), ["p2"]);
  assert.equal(await read.item(rust, "alice", "p1"), undefined);
  assert.equal((await read.edgesOf(rust, "carol")).size, 0);
  assert.deepEqual((await read.itemsBy(bitcoin, "alice")).map((p) => p.id), ["p1"]);
  assert.deepEqual(await read.itemsBy(rust, "alice"), []);
});

test("a post listed in a community it doesn't say it's in is not shown there", async () => {
  const home = memory();
  await home.apply(places.scopeWrites("bitcoin", write.post("alice", "p1", { title: "Mine" })));
  // Alice lists her bitcoin post in rust too, by writing rust's listing directly.
  await home.apply([["index/c/rust/post/p1/alice", "1"]]);
  assert.deepEqual(await read.posts(places.scoped(home, "rust")), []);
});

test("a community that moved is read from both places: posts, votes, and where each item lives", async () => {
  const own = memory(); // its own chain, as README.md lays records out
  const home = memory();
  await own.apply(write.post("alice", "old", { title: "Before the move" }));
  await own.apply(write.vote("bob", new Map(), "alice", "old", 1));
  await home.apply(places.scopeWrites("bitcoin", write.post("alice", "new", { title: "After the move" })));
  const scoped = places.scoped(home, "bitcoin");
  await home.apply(places.scopeWrites("bitcoin", write.vote("bob", await read.edgesOf(scoped, "bob"), "alice", "new", 1)));

  const both = places.union([own, scoped]);
  assert.deepEqual((await read.posts(both)).map((p) => p.id).sort(), ["new", "old"]);
  // Bob's votes are record 0 in each place: both are read.
  assert.deepEqual([...read.edgeSets(await read.edgesOf(both, "bob")).up].sort(), ["alice/new", "alice/old"]);
  assert.equal(await both.where("user/alice/post/old"), 0);
  assert.equal(await both.where("user/alice/post/new"), 1);
  assert.equal(await both.where("user/alice/post/none"), -1);
});

test("where new posts go: the place the most member standing chose", () => {
  const standing = new Map([["a", 0.5], ["b", 0.3], ["c", 0.2], ["sybil", 0.001]]);
  const members = new Set(["a", "b", "c"]);
  const at = (declared, hasOwn) => places.chosenPlace({ declared: new Map(declared), standing, members, hasOwn }).at;
  assert.equal(at([], false), "home");
  assert.equal(at([], true), "own", "a community with a chain of its own stays there until members choose otherwise");
  assert.equal(at([["b", "home"], ["c", "home"]], true), "home");
  assert.equal(at([["a", "own"], ["b", "home"]], true), "own");
  assert.equal(at([["a", "home"], ["b", "own"]], true), "home");
  assert.equal(at([["a", "home"], ["b", "own"], ["c", "own"]], true), "own", "a tie stays where it is");
  assert.equal(at([["a", "own"]], false), "home", "no chain of its own to go to");
  assert.equal(at([["sybil", "home"]], true), "own", "only members choose");
  const founded = (declared, place) => places.chosenPlace({ declared: new Map(declared), standing, members, hasOwn: true, founded: place }).at;
  assert.equal(founded([], "home"), "home", "a chain made for a community founded on the home chain doesn't move it");
  assert.equal(founded([["a", "own"]], "home"), "own");
});

test("founding: the place of the earliest post, and the first posters there; a place moved to later adds no seeds", async () => {
  const own = memory();
  const home = memory();
  // Founded on the home chain; a chain of its own made later, where others post first.
  await home.apply(places.scopeWrites("x", write.post("alice", "p1", { title: "First", time: 100 })));
  await home.apply(places.scopeWrites("x", write.post("bob", "p2", { title: "Second", time: 300 })));
  await own.apply(write.post("mallory", "m1", { title: "Mine now", time: 200 }));
  const both = places.union([own, places.scoped(home, "x")]);
  const { at, seeds } = await places.founding(both, await read.posts(both));
  assert.equal(at, 1);
  assert.deepEqual(seeds, ["alice", "bob"]);
  assert.deepEqual(await places.founding(both, []), { at: -1, seeds: [] });
});

test("declarations: listed by name and account, the rest skipped", async () => {
  const home = memory();
  await home.apply([
    ...places.declare("alice", "bitcoin", "home"),
    ...places.declare("bob", "bitcoin/lightning", "own"),
    ["index/community/Bad/carol", JSON.stringify({ at: "home" })],
    ["index/community/rust/dave", "not json"],
    ["index/community/rust/erin/extra", JSON.stringify({ at: "home" })],
  ]);
  const got = await places.declarations(home);
  assert.deepEqual([...got.keys()].sort(), ["bitcoin", "bitcoin/lightning"], "a record naming no place names no community");
  assert.deepEqual([...got.get("bitcoin")], [["alice", "home"]]);
  assert.deepEqual([...got.get("bitcoin/lightning")], [["bob", "own"]]);
});
