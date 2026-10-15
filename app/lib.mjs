// The parts of the page that are pure: no network, no DOM, no storage. The
// page and its tests share them.

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

export const short = (address) => (address ? `${address.slice(0, 8)}…${address.slice(-4)}` : "");

/** An author's name: their profile's, else their shortened address. */
export const nameOf = (address, names) => names.get(address) ?? short(address);

/** `n` and the word, singular for one. */
export const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** `link` as an http(s) URL, or null: anything else is never made a link. */
export function safeLink(link) {
  try {
    const url = new URL(link);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * How long ago a block time was. Times are read from the last two weeks of
 * blocks, so anything without one is older than that.
 */
export function ago(time, now = Date.now()) {
  if (!time) return "2+ weeks ago";
  const minutes = Math.max(0, Math.floor((now - time) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

/** A block time as a <time>, with the exact moment on hover. */
export function when(time, now = Date.now()) {
  if (!time) return `<span title="Older than the two weeks of blocks this page reads">${ago(time, now)}</span>`;
  const at = new Date(time);
  return `<time datetime="${at.toISOString()}" title="${esc(at.toLocaleString())}">${ago(time, now)}</time>`;
}

/** A chain path that may wrap after each slash. */
export const pathHTML = (path) => path.map(esc).join("/<wbr>");

/** `#/`, `#/s/<community>`, `#/s/<community>/<author>/<id>`. */
export function parseRoute(hash) {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "s" && parts.length >= 4) return { view: "post", community: parts[1], author: parts[2], id: parts[3] };
  if (parts[0] === "s" && parts[1]) return { view: "community", community: parts[1] };
  return { view: "home" };
}

export const postHref = (community, author, id) =>
  `#/s/${encodeURIComponent(community)}/${encodeURIComponent(author)}/${encodeURIComponent(id)}`;

/** What a poster without coins is told: there is no faucet, coins are earned or received. */
export const coinsMessage = (community, address, fee) =>
  `Writing on s/${community} costs ${fee} s/${community} ${fee === 1n ? "coin" : "coins"}, and you have none. ` +
  `Receive some at your address (${short(address)}), or mine s/${community}.`;

/**
 * Comments in reading order at every level: higher score first, then older
 * first so a conversation reads forward. Unknown times (older than the window
 * read) count as oldest.
 */
export function ordered(node) {
  const replies = [...node.replies].map(ordered)
    .sort((a, b) => (b.ups - b.downs) - (a.ups - a.downs) || (a.time ?? 0) - (b.time ?? 0));
  return { ...node, replies };
}

const labelText = (labels, names) => labels.map((l) => `${esc(l.label)} by ${esc(nameOf(l.by, names))}`).join(", ");
const linkTag = (link, text) =>
  `<a class="link" href="${esc(link)}" target="_blank" rel="noopener noreferrer nofollow">${esc(text)} ↗</a>`;
const target = (community, author, id) => `${esc(community)}|${esc(author)}|${esc(id)}`;

/**
 * Up, score, down for a post or comment. `mine` is the reader's vote (1, -1
 * or 0); a vote still waiting for its block is drawn as pending.
 */
export function voteBox({ community, author, id, ups, downs, mine = 0, votePending = false, pending }, { row = false } = {}) {
  const t = target(community, author, id);
  const score = ups - downs;
  // An item still waiting for its own block cannot be voted on yet, and a
  // vote in flight settles before the next.
  const off = pending || votePending ? " disabled" : "";
  const tip = (what) => (votePending ? "Your vote is waiting for a block" : what);
  return `<div class="votes${row ? " row" : ""}${votePending ? " pending" : ""}" data-votes="${t}">`
    + `<button type="button" class="vote up" data-vote="1" data-target="${t}" aria-pressed="${mine === 1}" aria-label="Upvote" title="${tip("Upvote")}"${off}>▲</button>`
    + `<span class="score" aria-label="Score ${score}">${score}</span>`
    + `<button type="button" class="vote down" data-vote="-1" data-target="${t}" aria-pressed="${mine === -1}" aria-label="Downvote" title="${tip("Downvote")}"${off}>▼</button></div>`;
}

/** What the page says about a write of the reader's that is not in a block yet. */
export const pendingNote = (pending) =>
  pending === "slow" ? `<span class="pending-note">Sent, not in a block yet. It may still land.</span>`
    : `<span class="pending-note">Waiting for a block…</span>`;

/**
 * One post in a feed, as the reader's labels and treatments have it.
 * `inCommunity`: the feed is that community's, so its name is not repeated.
 */
export function postRow(p, names, { now = Date.now(), inCommunity = false } = {}) {
  const { treatment, labels } = p.verdict;
  if (treatment === "hide") {
    return `<div class="hidden-row">Hidden: labelled ${labelText(labels, names)} · <button class="linkish" data-reveal="${esc(p.author)}/${esc(p.id)}">Show</button></div>`;
  }
  const link = safeLink(p.link);
  const href = postHref(p.community, p.author, p.id);
  return `<article class="post${p.pending ? " pending" : ""}">
    ${voteBox(p)}
    <div>
      <h2><a href="${href}">${esc(p.title)}</a></h2>
      ${link ? linkTag(link, new URL(link).host) : ""}
      <div class="meta">${inCommunity ? "" : `<a href="#/s/${encodeURIComponent(p.community)}">s/${esc(p.community)}</a>`}<span>${esc(nameOf(p.author, names))}</span>${p.pending ? pendingNote(p.pending) : when(p.time, now)}<a href="${href}">${plural(p.comments, "comment")}</a>${p.tags.map((t) => `<span class="tag">${esc(t.toUpperCase())}</span>`).join("")}${labels.length ? `<span class="tag label">${labelText(labels, names)}</span>` : ""}</div>
      ${treatment === "collapse" ? "" : p.media.map((cid) => mediaSlot(cid, p.community, treatment === "blur" || p.tags.includes("nsfw"))).join("")}
      ${p.error ? `<p class="inline-error">${esc(p.error)}</p>` : ""}
    </div></article>`;
}

/** A place for a media file, filled once some node serves it. */
export const mediaSlot = (cid, community, blur) =>
  `<div class="media missing" data-media="${esc(cid)}" data-chain="${esc(community)}" data-blur="${blur ? 1 : 0}">loading…</div>`;

/**
 * A comment and its replies; a labelled comment is a moderation note, with a
 * way to follow (or stop following) its author's labels.
 */
export function commentNode(c, community, judgeItem, followed, names, now = Date.now()) {
  const verdict = judgeItem(c);
  const note = c.labels.length > 0;
  const link = safeLink(c.link);
  const following = followed.includes(c.author);
  const folded = verdict.treatment === "hide" || verdict.treatment === "collapse";
  const body = folded
    ? `<p class="muted" style="margin:2px 0">Collapsed: labelled ${labelText(verdict.labels, names)} · <button class="linkish" data-expand>Show</button></p><div class="body" hidden>${esc(c.body)}</div>`
    : `<div class="body">${note ? c.labels.map((l) => `<span class="tag label">${esc(l)}</span> `).join("") : ""}${esc(c.body)}</div>`;
  const follow = note
    ? following
      ? `<span class="tag">you follow their labels</span>`
      : `<button class="linkish" type="button" data-follow="${esc(c.author)}">Follow their labels</button>`
    : "";
  return `<div class="c${note ? " note" : ""}${c.pending ? " pending" : ""}">
    <div class="by"><strong>${esc(nameOf(c.author, names))}</strong>${c.pending ? pendingNote(c.pending) : when(c.time, now)}${follow}</div>
    ${body}${link ? linkTag(link, link) : ""}
    <div class="acts">${c.pending ? "" : `${voteBox({ ...c, community }, { row: true })}<button type="button" data-reply="${esc(c.author)}/${esc(c.id)}">Reply</button><button type="button" data-label="${esc(c.author)}/${esc(c.id)}">Label…</button>`}</div>
    ${c.error ? `<p class="inline-error">${esc(c.error)}</p>` : ""}
    ${c.replies.map((r) => commentNode(r, community, judgeItem, followed, names, now)).join("")}
  </div>`;
}
