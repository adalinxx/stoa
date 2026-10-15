// The parts of the page that are pure: no network, no DOM, no storage. The
// page and its tests share them.

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

export const short = (address) => (address ? `${address.slice(0, 8)}…${address.slice(-4)}` : "");

/** An author's name: their profile's, else their shortened address. */
export const nameOf = (address, names) => names.get(address) ?? short(address);

/** `link` as an http(s) URL, or null: anything else is never made a link. */
export function safeLink(link) {
  try {
    const url = new URL(link);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/** How long ago a block time was; "older" when it is outside the time window. */
export function ago(time, now = Date.now()) {
  if (!time) return "older";
  const minutes = Math.max(0, Math.round((now - time) / 60000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

/** `#/`, `#/s/<community>`, `#/s/<community>/<author>/<id>`. */
export function parseRoute(hash) {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "s" && parts.length >= 4) return { view: "post", community: parts[1], author: parts[2], id: parts[3] };
  if (parts[0] === "s" && parts[1]) return { view: "community", community: parts[1] };
  return { view: "home" };
}

/** What a poster without coins is told: there is no faucet, coins are earned or received. */
export const coinsMessage = (community, address, fee) =>
  `Posting on s/${community} costs ${fee} of its coin, and this account has none. ` +
  `Receive some at ${address}, or mine s/${community}.`;

const labelText = (labels, names) => labels.map((l) => `${esc(l.label)} by ${esc(nameOf(l.by, names))}`).join(", ");
const linkTag = (link, text) =>
  `<a class="link" href="${esc(link)}" target="_blank" rel="noopener noreferrer nofollow">${esc(text)} ↗</a>`;
const target = (community, author, id) => `${esc(community)}|${esc(author)}|${esc(id)}`;

/** One post in a feed, as the reader's labels and treatments have it. */
export function postRow(p, names, now = Date.now()) {
  const { treatment, labels } = p.verdict;
  if (treatment === "hide") {
    return `<div class="hidden-row">Hidden · labelled ${labelText(labels, names)} · <button class="linkish" data-reveal="${esc(p.author)}/${esc(p.id)}">Show</button></div>`;
  }
  const link = safeLink(p.link);
  return `<article class="post">
    <div class="votes"><button class="vote up ${p.mine === 1 ? "on" : ""}" data-vote="1" data-target="${target(p.community, p.author, p.id)}" aria-label="Upvote">▲</button><span>${p.ups - p.downs}</span><button class="vote down ${p.mine === -1 ? "on" : ""}" data-vote="-1" data-target="${target(p.community, p.author, p.id)}" aria-label="Downvote">▼</button></div>
    <div>
      <h2><a href="#/s/${encodeURIComponent(p.community)}/${encodeURIComponent(p.author)}/${encodeURIComponent(p.id)}">${esc(p.title)}</a></h2>
      ${link ? linkTag(link, new URL(link).host) : ""}
      <div class="meta"><span>s/${esc(p.community)}</span><span>${esc(nameOf(p.author, names))}</span><span>${ago(p.time, now)}</span><span>${p.comments} comments</span>${p.tags.map((t) => `<span class="tag">${esc(t.toUpperCase())}</span>`).join("")}${labels.length ? `<span class="tag">${labelText(labels, names)}</span>` : ""}</div>
      ${treatment === "collapse" ? "" : p.media.map((cid) => mediaSlot(cid, p.community, treatment === "blur" || p.tags.includes("nsfw"))).join("")}
    </div></article>`;
}

/** A place for a media file, filled once some node serves it. */
export const mediaSlot = (cid, community, blur) =>
  `<div class="media missing" data-media="${esc(cid)}" data-chain="${esc(community)}" data-blur="${blur ? 1 : 0}">loading…</div>`;

/** A comment and its replies; a labelled comment is a moderation note. */
export function commentNode(c, community, judgeItem, followed, names) {
  const verdict = judgeItem(c);
  const note = c.labels.length > 0;
  const link = safeLink(c.link);
  const body = verdict.treatment === "hide" || verdict.treatment === "collapse"
    ? `<p class="muted">Collapsed · labelled ${labelText(verdict.labels, names)} · <button class="linkish" data-expand>Show</button></p><div class="body" hidden>${esc(c.body)}</div>`
    : `<div class="body">${note ? c.labels.map((l) => `<span class="tag">${esc(l)}</span> `).join("") : ""}${esc(c.body)}</div>`;
  return `<div class="c ${note ? "note" : ""}">
    <div class="who">${esc(nameOf(c.author, names))}${note && followed.includes(c.author) ? ' · <span class="tag">you follow their labels</span>' : ""} · ▲ ${c.ups - c.downs}</div>
    ${body}${link ? linkTag(link, link) : ""}
    <div class="acts"><button data-reply="${esc(c.author)}/${esc(c.id)}">Reply</button><button data-label="${esc(c.author)}/${esc(c.id)}">Label…</button><button data-vote="1" data-target="${target(community, c.author, c.id)}">▲</button><button data-vote="-1" data-target="${target(community, c.author, c.id)}">▼</button></div>
    ${c.replies.map((r) => commentNode(r, community, judgeItem, followed, names)).join("")}
  </div>`;
}
