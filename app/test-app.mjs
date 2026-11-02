//   node --test app/
import assert from "node:assert/strict";
import { test } from "node:test";
import { ago, commentNode, nameOf, ordered, parseRoute, pathHTML, plural, postRow, safeLink } from "./lib.mjs";

const NOW = 1_800_000_000_000;
const names = new Map([["bafy-alice-address", "Alice"]]);
const post = (over = {}) => ({
  community: "bitcoin", author: "bafy-alice-address", id: "p1", title: "Hello", link: undefined, media: [],
  ups: 3, downs: 1, mine: 0, comments: 2, time: NOW - 5 * 60000, ...over,
});

test("only http(s) links become links", () => {
  assert.equal(safeLink("https://bitcoin.org/bitcoin.pdf"), "https://bitcoin.org/bitcoin.pdf");
  assert.equal(safeLink("http://example.com"), "http://example.com/");
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "not a url", undefined]) {
    assert.equal(safeLink(bad), null, String(bad));
  }
});

test("routes", () => {
  assert.deepEqual(parseRoute(""), { view: "home" });
  assert.deepEqual(parseRoute("#/s/bitcoin"), { view: "community", community: "bitcoin" });
  assert.deepEqual(parseRoute("#/s/bitcoin/bafy%2Fx/p1"), { view: "post", community: "bitcoin", author: "bafy/x", id: "p1" });
  assert.deepEqual(parseRoute("#/s/bit%E0coin"), { view: "community", community: "bit%E0coin" }, "a malformed escape does not throw");
});

test("times and names", () => {
  assert.equal(ago(NOW - 20000, NOW), "just now");
  assert.equal(ago(NOW - 5 * 60000, NOW), "5m ago");
  assert.equal(ago(NOW - 3 * 3600000, NOW), "3h ago");
  assert.equal(ago(NOW - 3 * 864e5, NOW), "3d ago");
  assert.equal(ago(0, NOW), "no time given");
  assert.equal(plural(1, "comment"), "1 comment");
  assert.equal(plural(0, "comment"), "0 comments");
  assert.equal(pathHTML(["Nexus", "<x>"]), "Nexus/<wbr>&lt;x&gt;");
  assert.equal(nameOf("bafy-alice-address", names), "Alice");
  assert.equal(nameOf("bafyreiddhbge4sc33fsm55rxixcjh3bk2blcqpke75tlte4vyd6wci3woa", names), "ddhb…ci3woa", "the short ID Moniker shows, past the bafyrei every ID shares");
});

test("what people write is escaped, and a bad link is not linked", () => {
  const html = postRow(post({ title: '<img src=x onerror="alert(1)">', link: "javascript:alert(1)", author: "<b>x</b>" }), names, { now: NOW });
  assert.ok(!html.includes("<img"), "the title is text");
  assert.ok(!html.includes("javascript:"), "the link is dropped");
  assert.ok(html.includes("&lt;img"));
  assert.ok(!html.includes("<b>x</b>"));
});

test("a post shows its score, comments, age, author name and link host", () => {
  const html = postRow(post({ link: "https://bitcoin.org/bitcoin.pdf" }), names, { now: NOW });
  assert.match(html, /<span class="score" aria-label="Score 2">2<\/span>/, "score is ups minus downs");
  assert.match(html, /2 comments/);
  assert.match(html, /5m ago/);
  assert.match(html, /href="#\/s\/bitcoin">s\/bitcoin</, "the community is named in a mixed feed");
  assert.ok(!postRow(post(), names, { now: NOW, inCommunity: true }).includes(">s/bitcoin<"), "not repeated in its own feed");
  assert.match(postRow(post({ comments: 1 }), names, { now: NOW }), />1 comment</);
  assert.match(html, /Alice/);
  assert.match(html, />bitcoin\.org ↗</);
});

test("what members downvoted more than upvoted is collapsed, with Show; the reader's own vote or choice shows it", () => {
  const buried = postRow(post({ ups: 1, downs: 2 }), names, { now: NOW });
  assert.match(buried, /Collapsed: more members downvoted it than upvoted it/);
  assert.match(buried, /data-reveal/);
  assert.ok(!buried.includes("<h2>"), "the post itself is not drawn");
  assert.match(postRow(post({ ups: 1, downs: 2, revealed: true }), names, { now: NOW }), /<h2>/, "Show draws it");
  assert.match(postRow(post({ ups: 1, downs: 2, mine: -1 }), names, { now: NOW }), /<h2>/, "the reader's own vote keeps it in view");
  assert.match(postRow(post({ ups: 2, downs: 2 }), names, { now: NOW }), /<h2>/, "a tie is not collapsed");

  const reply = { author: "bafy-eve", id: "c2", body: "buy my coin", ups: 0, downs: 3, replies: [] };
  const parent = { author: "bafy-bob", id: "c1", body: "Section 11.", ups: 2, downs: 0, replies: [reply] };
  const html = commentNode(parent, "bitcoin", names);
  assert.match(html, /<div class="body">Section 11\.<\/div>/);
  assert.match(html, /Collapsed: more members downvoted it than upvoted it · <button class="linkish" data-expand="bafy-eve\/c2">Show<\/button>/);
  assert.match(html, /<div class="body" hidden>buy my coin<\/div>/);
  assert.ok(!commentNode({ ...reply, expanded: true }, "bitcoin", names).includes("Collapsed"));
  assert.ok(!html.includes("Label"), "no labels");
});

test("the reader's vote shows as pressed, and a vote waiting for its block as pending", () => {
  const up = postRow(post({ mine: 1 }), names, { now: NOW });
  assert.match(up, /class="vote up"[^>]*aria-pressed="true"/);
  assert.match(up, /class="vote down"[^>]*aria-pressed="false"/);
  const waiting = postRow(post({ mine: -1, votePending: true }), names, { now: NOW });
  assert.match(waiting, /class="votes pending"/);
  assert.match(waiting, /class="vote down"[^>]*aria-pressed="true"/);
  assert.match(waiting, /class="vote up"[^>]*aria-disabled="true"/, "a vote in flight keeps its buttons focusable");
  assert.ok(!/class="vote up"[^>]*\sdisabled/.test(waiting));
});

test("a post or comment waiting for its block says so and can't be voted on yet", () => {
  const html = postRow(post({ pending: "waiting" }), names, { now: NOW });
  assert.match(html, /class="post pending"/);
  assert.match(html, /Waiting for a block/);
  assert.match(html, /data-vote="1"[^>]*\sdisabled[\s>]/);
  assert.match(postRow(post({ pending: "slow" }), names, { now: NOW }), /It may still land/);
  const comment = commentNode({ author: "bafy-alice-address", id: "c9", body: "hi", ups: 0, downs: 0, replies: [], pending: "waiting" }, "bitcoin", names, NOW);
  assert.match(comment, /Waiting for a block/);
  assert.ok(!comment.includes("data-reply"), "no replying to a comment not yet in a block");
});

test("a failed vote's message shows under its item", () => {
  assert.match(postRow(post({ error: "Vote not counted. You declined it in the wallet." }), names, { now: NOW }), /class="inline-error">Vote not counted/);
});

test("comments read best first, then oldest first", () => {
  const c = (id, ups, time, replies = []) => ({ id, ups, downs: 0, time, replies });
  const tree = ordered(c("post", 0, 1, [c("new", 0, 30), c("old", 0, 10), c("liked", 2, 20, [c("b", 0, 5), c("a", 0, 0)])]));
  assert.deepEqual(tree.replies.map((r) => r.id), ["liked", "old", "new"]);
  assert.deepEqual(tree.replies[0].replies.map((r) => r.id), ["a", "b"], "no time read: oldest");
});

test("an id with a | cannot shift what a vote is for", () => {
  const html = postRow(post({ id: "x|y" }), names, { now: NOW });
  const targetAttr = html.match(/data-target="([^"]+)"/)[1];
  assert.deepEqual(targetAttr.split("|").map(decodeURIComponent), ["bitcoin", "bafy-alice-address", "x|y"]);
});

test("a profile route, and bylines that link to it", () => {
  assert.deepEqual(parseRoute("#/u/bafyreiabc"), { view: "profile", address: "bafyreiabc" });
  assert.deepEqual(parseRoute("#/u/"), { view: "home" });
  const html = postRow(post({}), names, { now: NOW });
  assert.match(html, /<a class="author" href="#\/u\/bafy-alice-address">Alice<\/a>/);
});
