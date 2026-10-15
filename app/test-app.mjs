//   node --test app/
import assert from "node:assert/strict";
import { test } from "node:test";
import { judge } from "../client/moderation.mjs";
import { ago, coinsMessage, commentNode, nameOf, ordered, parseRoute, pathHTML, plural, postRow, safeLink } from "./lib.mjs";

const NOW = 1_800_000_000_000;
const names = new Map([["bafy-alice-address", "Alice"]]);
const post = (over = {}) => ({
  community: "bitcoin", author: "bafy-alice-address", id: "p1", title: "Hello", link: undefined, tags: [], media: [],
  ups: 3, downs: 1, mine: 0, comments: 2, time: NOW - 5 * 60000, verdict: { treatment: "show", labels: [] }, ...over,
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
});

test("times and names", () => {
  assert.equal(ago(NOW - 20000, NOW), "just now");
  assert.equal(ago(NOW - 5 * 60000, NOW), "5m ago");
  assert.equal(ago(NOW - 3 * 3600000, NOW), "3h ago");
  assert.equal(ago(NOW - 3 * 864e5, NOW), "3d ago");
  assert.equal(ago(0, NOW), "2+ weeks ago", "no block time: older than the window read");
  assert.equal(plural(1, "comment"), "1 comment");
  assert.equal(plural(0, "comment"), "0 comments");
  assert.equal(pathHTML(["Nexus", "<x>"]), "Nexus/<wbr>&lt;x&gt;");
  assert.equal(nameOf("bafy-alice-address", names), "Alice");
  assert.equal(nameOf("bafyreiddhbge4sc33fsm55rxixcjh3bk2blcqpke75tlte4vyd6wci3woa", names), "bafyreid…3woa");
});

test("a poster without coins is told how to get them, not given them", () => {
  const message = coinsMessage("bitcoin", "bafyreiddhbge4sc33fsm55rxixcjh3bk2blcqpke75tlte4vyd6wci3woa", 1n);
  assert.match(message, /costs 1 s\/bitcoin coin, and you have none/);
  assert.match(message, /Receive some at your address \(bafyreid…3woa\), or mine s\/bitcoin/);
});

test("what people write is escaped, and a bad link is not linked", () => {
  const html = postRow(post({ title: '<img src=x onerror="alert(1)">', link: "javascript:alert(1)", author: "<b>x</b>" }), names, { now: NOW });
  assert.ok(!html.includes("<img"), "the title is text");
  assert.ok(!html.includes("javascript:"), "the link is dropped");
  assert.ok(html.includes("&lt;img"));
  assert.ok(!html.includes("<b>x</b>"));
});

test("a post shows its score, comments, age, author name and link host", () => {
  const html = postRow(post({ link: "https://bitcoin.org/bitcoin.pdf", tags: ["oc"] }), names, { now: NOW });
  assert.match(html, /<span class="score" aria-label="Score 2">2<\/span>/, "score is ups minus downs");
  assert.match(html, /2 comments/);
  assert.match(html, /5m ago/);
  assert.match(html, /href="#\/s\/bitcoin">s\/bitcoin</, "the community is named in a mixed feed");
  assert.ok(!postRow(post(), names, { now: NOW, inCommunity: true }).includes(">s/bitcoin<"), "not repeated in its own feed");
  assert.match(postRow(post({ comments: 1 }), names, { now: NOW }), />1 comment</);
  assert.match(html, /Alice/);
  assert.match(html, />bitcoin\.org ↗</);
  assert.match(html, /OC/);
});

test("labels the reader follows hide, collapse or blur a post; nothing else does", () => {
  const labels = [{ by: "bafy-mod", label: "spam" }];
  const hidden = postRow(post({ verdict: { treatment: "hide", labels } }), names, { now: NOW });
  assert.match(hidden, /Hidden: labelled spam by/);
  assert.match(hidden, /data-reveal/);
  assert.ok(!hidden.includes("<h2>"), "the post itself is not drawn");

  const media = ["bafy-image"];
  const collapsed = postRow(post({ media, verdict: { treatment: "collapse", labels } }), names, { now: NOW });
  assert.ok(collapsed.includes("<h2>") && !collapsed.includes("data-media"), "collapsed: title, no media");

  const blurred = postRow(post({ media, verdict: { treatment: "blur", labels } }), names, { now: NOW });
  assert.match(blurred, /data-blur="1"/);
  const nsfw = postRow(post({ media, tags: ["nsfw"] }), names, { now: NOW });
  assert.match(nsfw, /data-blur="1"/, "an author's own NSFW tag blurs too");
  const plain = postRow(post({ media }), names, { now: NOW });
  assert.match(plain, /data-blur="0"/);
});

test("a labelled comment is a moderation note; a followed label collapses what it labels", () => {
  const reply = { author: "bafy-eve", id: "c2", body: "buy my coin", labels: [], ups: 0, downs: 0, replies: [] };
  const note = { author: "bafy-mod", id: "m1", body: "Shilling.", labels: ["spam"], ups: 0, downs: 0, replies: [reply] };
  const labelled = new Map([["bafy-mod", new Map([["bafy-eve/c2", ["spam"]]])]]);
  const html = commentNode(note, "bitcoin", judge(labelled, { spam: "collapse" }), ["bafy-mod"], names);
  assert.match(html, /class="c note"/);
  assert.match(html, /you follow their labels/);
  assert.match(html, /<span class="tag label">spam<\/span> Shilling\./);
  assert.match(html, /Collapsed: labelled spam by/);
  assert.match(html, /<div class="body" hidden>buy my coin<\/div>/);

  const unfollowed = commentNode(note, "bitcoin", judge(new Map(), {}), [], names);
  assert.ok(!unfollowed.includes("Collapsed"), "a reader who follows no one sees everything");
  assert.ok(!unfollowed.includes("you follow their labels"));
  assert.match(unfollowed, /data-follow="bafy-mod">Follow their labels/, "a note offers to follow its author's labels");
});

test("the reader's vote shows as pressed, and a vote waiting for its block as pending", () => {
  const up = postRow(post({ mine: 1 }), names, { now: NOW });
  assert.match(up, /class="vote up"[^>]*aria-pressed="true"/);
  assert.match(up, /class="vote down"[^>]*aria-pressed="false"/);
  const waiting = postRow(post({ mine: -1, votePending: true }), names, { now: NOW });
  assert.match(waiting, /class="votes pending"/);
  assert.match(waiting, /class="vote down"[^>]*aria-pressed="true"/);
});

test("a post or comment waiting for its block says so and can't be voted on yet", () => {
  const html = postRow(post({ pending: "waiting" }), names, { now: NOW });
  assert.match(html, /class="post pending"/);
  assert.match(html, /Waiting for a block/);
  assert.match(html, /data-vote="1"[^>]*disabled/);
  assert.match(postRow(post({ pending: "slow" }), names, { now: NOW }), /It may still land/);
  const comment = commentNode({ author: "bafy-alice-address", id: "c9", body: "hi", labels: [], ups: 0, downs: 0, replies: [], pending: "waiting" }, "bitcoin", judge(new Map(), {}), [], names, NOW);
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
