//   node --test app/
import assert from "node:assert/strict";
import { test } from "node:test";
import { judge } from "../client/moderation.mjs";
import { ago, coinsMessage, commentNode, nameOf, parseRoute, postRow, safeLink } from "./lib.mjs";

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
  assert.equal(ago(NOW - 5 * 60000, NOW), "5m");
  assert.equal(ago(NOW - 3 * 3600000, NOW), "3h");
  assert.equal(ago(0, NOW), "older");
  assert.equal(nameOf("bafy-alice-address", names), "Alice");
  assert.equal(nameOf("bafyreiddhbge4sc33fsm55rxixcjh3bk2blcqpke75tlte4vyd6wci3woa", names), "bafyreid…3woa");
});

test("a poster without coins is told how to get them, not given them", () => {
  const message = coinsMessage("bitcoin", "bafy-me", 1n);
  assert.match(message, /costs 1/);
  assert.match(message, /Receive some at bafy-me, or mine s\/bitcoin/);
});

test("what people write is escaped, and a bad link is not linked", () => {
  const html = postRow(post({ title: '<img src=x onerror="alert(1)">', link: "javascript:alert(1)", author: "<b>x</b>" }), names, NOW);
  assert.ok(!html.includes("<img"), "the title is text");
  assert.ok(!html.includes("javascript:"), "the link is dropped");
  assert.ok(html.includes("&lt;img"));
  assert.ok(!html.includes("<b>x</b>"));
});

test("a post shows its score, comments, age, author name and link host", () => {
  const html = postRow(post({ link: "https://bitcoin.org/bitcoin.pdf", tags: ["oc"] }), names, NOW);
  assert.match(html, /<span>2<\/span>/, "score is ups minus downs");
  assert.match(html, /2 comments/);
  assert.match(html, /5m/);
  assert.match(html, /Alice/);
  assert.match(html, />bitcoin\.org ↗</);
  assert.match(html, /OC/);
});

test("labels the reader follows hide, collapse or blur a post; nothing else does", () => {
  const labels = [{ by: "bafy-mod", label: "spam" }];
  const hidden = postRow(post({ verdict: { treatment: "hide", labels } }), names, NOW);
  assert.match(hidden, /Hidden · labelled spam by/);
  assert.match(hidden, /data-reveal/);
  assert.ok(!hidden.includes("<h2>"), "the post itself is not drawn");

  const media = ["bafy-image"];
  const collapsed = postRow(post({ media, verdict: { treatment: "collapse", labels } }), names, NOW);
  assert.ok(collapsed.includes("<h2>") && !collapsed.includes("data-media"), "collapsed: title, no media");

  const blurred = postRow(post({ media, verdict: { treatment: "blur", labels } }), names, NOW);
  assert.match(blurred, /data-blur="1"/);
  const nsfw = postRow(post({ media, tags: ["nsfw"] }), names, NOW);
  assert.match(nsfw, /data-blur="1"/, "an author's own NSFW tag blurs too");
  const plain = postRow(post({ media }), names, NOW);
  assert.match(plain, /data-blur="0"/);
});

test("a labelled comment is a moderation note; a followed label collapses what it labels", () => {
  const reply = { author: "bafy-eve", id: "c2", body: "buy my coin", labels: [], ups: 0, downs: 0, replies: [] };
  const note = { author: "bafy-mod", id: "m1", body: "Shilling.", labels: ["spam"], ups: 0, downs: 0, replies: [reply] };
  const labelled = new Map([["bafy-mod", new Map([["bafy-eve/c2", ["spam"]]])]]);
  const html = commentNode(note, "bitcoin", judge(labelled, { spam: "collapse" }), ["bafy-mod"], names);
  assert.match(html, /class="c note"/);
  assert.match(html, /you follow their labels/);
  assert.match(html, /<span class="tag">spam<\/span> Shilling\./);
  assert.match(html, /Collapsed · labelled spam by/);
  assert.match(html, /<div class="body" hidden>buy my coin<\/div>/);

  const unfollowed = commentNode(note, "bitcoin", judge(new Map(), {}), [], names);
  assert.ok(!unfollowed.includes("Collapsed"), "a reader who follows no one sees everything");
  assert.ok(!unfollowed.includes("you follow their labels"));
});
