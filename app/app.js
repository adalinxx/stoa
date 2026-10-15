// Stoa in the browser: reads every record from a node by CID, ranks and
// filters here, and signs writes with the reader's key. No server of its own.
import * as sdk from "./vendor/lattice-sdk.js";
import { judge, treatments } from "../client/moderation.mjs";
import { rank } from "../client/rank.mjs";
import * as read from "../client/read.mjs";
import { tip, view, volumeLoader } from "../client/state.mjs";
import { blockTimes } from "../client/time.mjs";
import * as write from "../client/write.mjs";

// Settings and per-reader choices live in this browser.
const store = {
  get(key, fallback) {
    try {
      const value = localStorage.getItem(`stoa:${key}`);
      return value === null ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`stoa:${key}`, JSON.stringify(value));
    } catch {
      /* private window: choices last for this visit */
    }
  },
};
const settings = {
  node: store.get("node", "https://lattice-testnet-stoa.fly.dev"),
  home: store.get("home", "Nexus/testnet/stoa-3dc425"),
};
const homePath = () => settings.home.split("/");
const chainOf = (community) => [...homePath(), ...community.split("/")];
const WINDOW_DAYS = 14;

// ---------------------------------------------------------------- signer

/** The reader's key. The Lattice Wallet will provide the same two members. */
function signer() {
  const hex = store.get("key", null);
  if (!hex) return null;
  const account = sdk.accountFromPrivateKey(fromHex(hex));
  return {
    address: account.address,
    sign: (body) => sdk.signTransactionBody(body, account.privateKey),
  };
}
const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (hex) => Uint8Array.from(hex.match(/../g).map((b) => parseInt(b, 16)));

// --------------------------------------------------------------- network

async function api(path, chain) {
  const url = new URL(path, settings.node);
  if (chain) url.searchParams.set("chainPath", chain.join("/"));
  const response = await fetch(url);
  if (!response.ok) {
    const error = new Error(`${path}: HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

/** A chain's state at the node's tip, read by CID from the node's Volumes. */
async function stateOf(chain) {
  const volumes = new sdk.VolumeClient(new sdk.HTTPVolumeTransport(`${settings.node}/volumes`, { chainPath: chain }));
  const { hash, generalStateCID } = await tip(sdk, settings.node, chain, volumes);
  return { chain, hash, volumes, ...view(volumeLoader(volumes, sdk.decodeDagCbor), generalStateCID) };
}

const timeIndexes = new Map();
/** Block times of a chain's posts, from its blocks over the last two weeks. */
async function timesOf(state) {
  const key = state.chain.join("/");
  if (!timeIndexes.has(key)) timeIndexes.set(key, blockTimes(sdk, state.volumes));
  const index = timeIndexes.get(key);
  await index.follow(state.hash, { since: Date.now() - WINDOW_DAYS * 864e5 });
  return index.times(state.hash);
}

/** Sign, submit and wait until every write reads back. */
async function submit(chain, records, status) {
  const me = signer();
  if (!me) throw new Error("Make or import a key in Settings first.");
  status("Signing…");
  const state = await stateOf(chain);
  const actions = await write.changes(state, records);
  const [account, info] = await Promise.all([
    api(`/api/state/account/${me.address}`, chain).catch(() => null),
    api("/api/chain/info", chain).catch(() => ({})),
  ]);
  const fee = BigInt(info.minRelayFee ?? 0);
  if (fee > 0n && BigInt(account?.balance ?? 0) < fee) {
    throw new Error(`This node asks a fee of ${fee} and your account has no coins on s/${chain.slice(homePath().length).join("/")}.`);
  }
  const body = write.transaction({ owner: me.address, actions, fee, nonce: BigInt(account?.nonce ?? 0), chainPath: chain });
  const { publicKey, signature } = me.sign(body);
  status("Sending…");
  const response = await fetch(new URL("/transactions", settings.node), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sdk.transactionPayload({ [publicKey]: signature }, body)),
  });
  if (!response.ok) throw new Error(`The node refused it: ${(await response.text()).slice(0, 200)}`);
  status("Waiting for a block…");
  for (let tries = 0; tries < 120; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const now = await stateOf(chain).catch(() => null);
    if (!now) continue;
    let landed = true;
    for (const [key, value] of records) if ((await now.get(key)) !== value) landed = false;
    if (landed) return;
  }
  throw new Error("Sent, but not in a block yet. It may still land.");
}

// ------------------------------------------------------------ moderation

const follows = (community) => store.get(`follows:${community}`, []);
const labelActions = () => store.get("labelActions", { spam: "hide", nsfw: "blur", "off-topic": "collapse" });
let showAll = false;

async function judgeFor(state, community) {
  if (showAll) return () => ({ treatment: "show", labels: [] });
  const sets = new Map(await Promise.all(follows(community).map(async (a) => [a, await read.labelsBy(state, a)])));
  return judge(sets, labelActions());
}

// ---------------------------------------------------------------- render

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const short = (address) => (address ? `${address.slice(0, 8)}…${address.slice(-4)}` : "");
const safeLink = (link) => {
  try {
    const url = new URL(link);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
};
function ago(time) {
  if (!time) return "older";
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

let communities = [];
let route = { view: "home" };
let sort = store.get("sort", "hot");

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "s" && parts.length >= 4) return { view: "post", community: parts[1], author: parts[2], id: parts[3] };
  if (parts[0] === "s" && parts[1]) return { view: "community", community: parts[1] };
  return { view: "home" };
}

function renderRail() {
  const joined = store.get("joined", null) ?? communities;
  $("#communities").innerHTML = communities.length
    ? communities.map((c) => `<li><a href="#/s/${encodeURIComponent(c)}" data-c="${esc(c)}">${esc(c)}${joined.includes(c) ? "" : ' <span class="muted">·</span>'}</a></li>`).join("")
    : '<li class="muted" style="padding:5px 8px">None yet</li>';
  document.querySelectorAll(".tree a").forEach((a) => {
    a.classList.toggle("on", (route.view === "home" && a.dataset.nav === "home") || a.dataset.c === route.community);
  });
  $("#np-c").innerHTML = communities.map((c) => `<option ${c === route.community ? "selected" : ""}>${esc(c)}</option>`).join("");
}

function renderWho() {
  const me = signer();
  $("#who").innerHTML = me ? `<span class="mono muted" title="${esc(me.address)}">${esc(short(me.address))}</span>` : '<span class="muted">No key</span>';
}

/** One community's posts with their votes, comment counts and block times. */
async function loadPosts(community) {
  const state = await stateOf(chainOf(community));
  const [posts, when, judgeItem] = await Promise.all([read.posts(state), timesOf(state), judgeFor(state, community)]);
  const me = signer()?.address;
  return Promise.all(
    posts.map(async (post) => {
      const votes = await read.votes(state, post.author, post.id);
      let comments = 0;
      for await (const _ of state.list(`index/comment/${post.author}/${post.id}/`)) comments++;
      return {
        ...post, community, ups: votes.ups, downs: votes.downs, mine: me ? votes.voters.get(me) ?? 0 : 0,
        comments, time: when.get(`${post.author}/${post.id}`) ?? 0, verdict: judgeItem(post),
      };
    }),
  );
}

function postRow(p) {
  const { treatment, labels } = p.verdict;
  const by = labels.map((l) => `${esc(l.label)} by ${esc(short(l.by))}`).join(", ");
  if (treatment === "hide") {
    return `<div class="hidden-row">Hidden · labelled ${by} · <button class="linkish" data-reveal="${esc(p.author)}/${esc(p.id)}">Show</button></div>`;
  }
  const link = safeLink(p.link);
  const score = p.ups - p.downs;
  return `<article class="post">
    <div class="votes"><button class="vote up ${p.mine === 1 ? "on" : ""}" data-vote="1" data-target="${esc(p.community)}|${esc(p.author)}|${esc(p.id)}" aria-label="Upvote">▲</button><span>${score}</span><button class="vote down ${p.mine === -1 ? "on" : ""}" data-vote="-1" data-target="${esc(p.community)}|${esc(p.author)}|${esc(p.id)}" aria-label="Downvote">▼</button></div>
    <div>
      <h2><a href="#/s/${encodeURIComponent(p.community)}/${encodeURIComponent(p.author)}/${encodeURIComponent(p.id)}">${esc(p.title)}</a></h2>
      ${link ? `<a class="link" href="${esc(link)}" target="_blank" rel="noopener noreferrer nofollow">${esc(new URL(link).host)} ↗</a>` : ""}
      <div class="meta"><span>s/${esc(p.community)}</span><span class="mono">${esc(short(p.author))}</span><span>${ago(p.time)}</span><span>${p.comments} comments</span>${p.tags.map((t) => `<span class="tag">${esc(t.toUpperCase())}</span>`).join("")}${labels.length ? `<span class="tag">${by}</span>` : ""}</div>
      ${treatment === "collapse" ? "" : p.media.map((cid) => `<div class="media missing" data-media="${esc(cid)}" data-chain="${esc(p.community)}" data-blur="${treatment === "blur" || p.tags.includes("nsfw") ? 1 : 0}">loading image…</div>`).join("")}
    </div></article>`;
}

async function showFeed(communitiesShown, title) {
  $("#main").innerHTML = `<h1>${esc(title)}</h1>
    <div class="tabs">${["hot", "new", "top", "controversial"].map((s) => `<button class="tab ${s === sort ? "on" : ""}" data-sort="${s}">${s[0].toUpperCase() + s.slice(1)}</button>`).join("")}</div>
    <div id="feed"><p class="empty">Reading from ${esc(new URL(settings.node).host)}…</p></div>`;
  try {
    const all = (await Promise.all(communitiesShown.map((c) => loadPosts(c).catch(() => [])))).flat();
    const ranked = rank(all, sort);
    $("#feed").innerHTML = ranked.length ? ranked.map(postRow).join("") : '<p class="empty">No posts yet. Be the first: New post.</p>';
    loadMedia();
  } catch (error) {
    $("#feed").innerHTML = `<p class="error">${esc(error.message)}</p>`;
  }
}

function commentNode(c, community, judgeItem, post) {
  const verdict = judgeItem(c);
  const note = c.labels.length > 0;
  const followed = note && follows(community).includes(c.author);
  const link = safeLink(c.link);
  const body = verdict.treatment === "hide" || verdict.treatment === "collapse"
    ? `<p class="muted">Collapsed · labelled ${verdict.labels.map((l) => esc(l.label)).join(", ")} · <button class="linkish" data-expand>Show</button></p><div class="body" hidden>${esc(c.body)}</div>`
    : `<div class="body">${note ? c.labels.map((l) => `<span class="tag">${esc(l)}</span> `).join("") : ""}${esc(c.body)}</div>`;
  return `<div class="c ${note ? "note" : ""}">
    <div class="who"><span class="mono">${esc(short(c.author))}</span>${followed ? ' · <span class="tag">you follow their labels</span>' : ""} · ▲ ${c.ups - c.downs}</div>
    ${body}${link ? `<a class="link" href="${esc(link)}" target="_blank" rel="noopener noreferrer nofollow">${esc(link)}</a>` : ""}
    <div class="acts"><button data-reply="${esc(c.author)}/${esc(c.id)}">Reply</button><button data-label="${esc(c.author)}/${esc(c.id)}">Label…</button><button data-vote="1" data-target="${esc(community)}|${esc(c.author)}|${esc(c.id)}">▲</button><button data-vote="-1" data-target="${esc(community)}|${esc(c.author)}|${esc(c.id)}">▼</button></div>
    ${c.replies.map((r) => commentNode(r, community, judgeItem, post)).join("")}
  </div>`;
}

async function showPost({ community, author, id }) {
  $("#main").innerHTML = `<a class="tab" href="#/s/${encodeURIComponent(community)}">← s/${esc(community)}</a><div id="thread"><p class="empty">Reading…</p></div>`;
  try {
    const state = await stateOf(chainOf(community));
    const [tree, when, judgeItem] = await Promise.all([read.thread(state, author, id), timesOf(state), judgeFor(state, community)]);
    if (!tree) {
      $("#thread").innerHTML = '<p class="empty">This post is not in the state this node serves. Its author may have deleted it.</p>';
      return;
    }
    const withVotes = async (node) => {
      const v = await read.votes(state, node.author, node.id);
      node.ups = v.ups;
      node.downs = v.downs;
      await Promise.all(node.replies.map(withVotes));
    };
    await withVotes(tree);
    const link = safeLink(tree.link);
    $("#thread").innerHTML = `<div class="op">
      <div class="meta"><span>s/${esc(community)}</span><span class="mono">${esc(short(author))}</span><span>${ago(when.get(`${author}/${id}`))}</span></div>
      <h1>${esc(tree.title)}</h1>
      ${link ? `<a class="link" href="${esc(link)}" target="_blank" rel="noopener noreferrer nofollow">${esc(link)} ↗</a>` : ""}
      ${tree.media.map((cid) => `<div class="media missing" data-media="${esc(cid)}" data-chain="${esc(community)}" data-blur="${tree.tags.includes("nsfw") ? 1 : 0}">loading image…</div>`).join("")}
      ${tree.body ? `<div class="body" style="margin-top:10px">${esc(tree.body)}</div>` : ""}
      <div class="acts"><span>▲ ${tree.ups - tree.downs}</span><button data-reply="${esc(author)}/${esc(id)}">Reply</button><button data-label="${esc(author)}/${esc(id)}">Label…</button></div>
    </div>
    ${tree.replies.length ? tree.replies.map((c) => commentNode(c, community, judgeItem, tree)).join("") : '<p class="empty">No comments yet.</p>'}`;
    loadMedia();
  } catch (error) {
    $("#thread").innerHTML = `<p class="error">${esc(error.message)}</p>`;
  }
}

/** Fill media slots from any node that serves the Volume; checked by CID. */
async function loadMedia() {
  for (const slot of document.querySelectorAll("[data-media]")) {
    const cid = slot.dataset.media;
    try {
      const volumes = new sdk.VolumeClient(new sdk.HTTPVolumeTransport(`${settings.node}/volumes`, { chainPath: chainOf(slot.dataset.chain) }));
      const volume = await volumes.get(cid);
      const file = sdk.decodeDagCbor(volume.bytes(cid));
      if (typeof file?.type !== "string" || !(file.bytes instanceof Uint8Array) || file.bytes.length > 8 << 20) throw new Error("not media");
      const url = URL.createObjectURL(new Blob([file.bytes], { type: file.type }));
      const tag = file.type.startsWith("video/") ? `<video class="media" controls src="${url}"></video>` : file.type.startsWith("image/") ? `<img class="media" alt="" src="${url}">` : "";
      if (!tag) throw new Error("not media");
      slot.outerHTML = slot.dataset.blur === "1" ? tag.replace('class="media"', 'class="media blur" title="tap to show" data-unblur') : tag;
    } catch {
      slot.textContent = "No one is serving this file right now.";
      slot.removeAttribute("data-media");
    }
  }
}

function showAside() {
  const c = route.community;
  if (!c) {
    $("#aside").innerHTML = `<div class="card"><h4>Home</h4><p class="muted">Posts from your communities, ranked in this page from votes and block times.</p><dl class="kv"><dt>Node</dt><dd>${esc(new URL(settings.node).host)}</dd></dl></div>`;
    return;
  }
  const joined = store.get("joined", null) ?? communities;
  $("#aside").innerHTML = `<div class="card"><h4>s/${esc(c)}</h4><p class="muted">A chain of its own. Anyone can post; anyone can mine it.</p>
    <dl class="kv"><dt>Chain</dt><dd class="mono">${esc(chainOf(c).join("/"))}</dd><dt>Height</dt><dd class="mono" id="aside-height">…</dd><dt>Labels you follow</dt><dd>${follows(c).length} ${follows(c).length === 1 ? "account" : "accounts"}</dd><dt>Your coins</dt><dd class="mono" id="aside-balance">…</dd></dl>
    <div class="row2" style="justify-content:flex-start"><button class="btn" id="join">${joined.includes(c) ? "Leave" : "Join"}</button><button class="btn" id="aside-mods">Moderation</button></div></div>`;
  api("/api/chain/info", chainOf(c)).then((i) => ($("#aside-height").textContent = i.height ?? "starting")).catch(() => ($("#aside-height").textContent = "unreachable"));
  const me = signer();
  if (me) api(`/api/state/account/${me.address}`, chainOf(c)).then((a) => ($("#aside-balance").textContent = a.balance ?? "0")).catch(() => ($("#aside-balance").textContent = "0"));
  else $("#aside-balance").textContent = "no key";
  $("#join").onclick = () => {
    const list = store.get("joined", null) ?? [...communities];
    store.set("joined", list.includes(c) ? list.filter((x) => x !== c) : [...list, c]);
    render();
  };
  $("#aside-mods").onclick = () => openMods(c);
}

async function render() {
  route = parseRoute();
  renderRail();
  renderWho();
  showAside();
  if (route.view === "post") return showPost(route);
  if (route.view === "community") return showFeed([route.community], `s/${route.community}`);
  const joined = (store.get("joined", null) ?? communities).filter((c) => communities.includes(c));
  return showFeed(joined, "Home");
}

// --------------------------------------------------------------- actions

document.addEventListener("click", async (event) => {
  const el = event.target.closest("button, img, video");
  if (!el) return;
  if (el.dataset.sort) {
    sort = el.dataset.sort;
    store.set("sort", sort);
    render();
  } else if (el.dataset.reveal) {
    showAll = true;
    await render();
    showAll = false;
  } else if (el.hasAttribute("data-expand")) {
    el.closest("p").nextElementSibling.hidden = false;
    el.closest("p").remove();
  } else if (el.hasAttribute("data-unblur")) {
    el.classList.remove("blur");
  } else if (el.dataset.vote) {
    const [community, author, id] = el.dataset.target.split("|");
    const me = signer();
    if (!me) return alertBox("Make or import a key in Settings first.");
    const direction = el.classList.contains("on") ? 0 : Number(el.dataset.vote);
    el.disabled = true;
    try {
      await submit(chainOf(community), write.vote(me.address, author, id, direction), () => {});
      render();
    } catch (error) {
      alertBox(error.message);
    } finally {
      el.disabled = false;
    }
  } else if (el.dataset.reply || el.dataset.label) {
    openReply(el.dataset.reply ?? el.dataset.label, Boolean(el.dataset.label));
  }
});

function alertBox(message) {
  const main = $("#main");
  const p = document.createElement("p");
  p.className = "error";
  p.textContent = message;
  main.prepend(p);
  setTimeout(() => p.remove(), 8000);
}

let replyTarget = null;
function openReply(target, labelling) {
  const [author, id] = target.split("/");
  replyTarget = { author, id, labelling };
  $("#reply-title").textContent = labelling ? "Label" : "Reply";
  $("#rp-labels-wrap").hidden = !labelling;
  $("#rp-b").value = "";
  $("#rp-labels").value = "";
  $("#rp-status").textContent = "";
  $("#reply").showModal();
}
$("#reply-form").addEventListener("submit", async (event) => {
  if (event.submitter?.value !== "send") return;
  event.preventDefault();
  const me = signer();
  const { community, author: postAuthor, id: postId } = route;
  const on = { author: postAuthor, id: postId };
  const target = replyTarget.author === postAuthor && replyTarget.id === postId ? undefined : { author: replyTarget.author, id: replyTarget.id };
  const labels = replyTarget.labelling ? $("#rp-labels").value.split(",").map((l) => l.trim()).filter(Boolean) : [];
  if (replyTarget.labelling && labels.length === 0) return ($("#rp-status").textContent = "Name at least one label.");
  if (!replyTarget.labelling && !$("#rp-b").value.trim()) return ($("#rp-status").textContent = "Write something first.");
  $("#rp-send").disabled = true;
  try {
    if (!me) throw new Error("Make or import a key in Settings first.");
    const records = replyTarget.labelling
      ? write.label(me.address, write.newId(), on, labels, { target, body: $("#rp-b").value.trim() })
      : write.comment(me.address, write.newId(), on, { body: $("#rp-b").value.trim() }, target ? { parent: target } : {});
    await submit(chainOf(community), records, (s) => ($("#rp-status").textContent = s));
    $("#reply").close();
    render();
  } catch (error) {
    $("#rp-status").textContent = error.message;
  } finally {
    $("#rp-send").disabled = false;
  }
});

$("#open-new").onclick = () => {
  $("#np-status").textContent = "";
  $("#new").showModal();
};
$("#new-form").addEventListener("submit", async (event) => {
  if (event.submitter?.value !== "post") return;
  event.preventDefault();
  const me = signer();
  const community = $("#np-c").value;
  const title = $("#np-t").value.trim();
  const link = $("#np-l").value.trim();
  if (!title) return ($("#np-status").textContent = "A post needs a title.");
  if (link && !safeLink(link)) return ($("#np-status").textContent = "The link must start with https:// or http://");
  const tags = [...document.querySelectorAll("#new-form .checks input:checked")].map((i) => i.value);
  $("#np-post").disabled = true;
  try {
    if (!me) throw new Error("Make or import a key in Settings first.");
    const id = write.newId();
    const value = { title, ...(link && { link }), ...($("#np-b").value.trim() && { body: $("#np-b").value.trim() }), ...(tags.length && { tags }) };
    await submit(chainOf(community), write.post(me.address, id, value), (s) => ($("#np-status").textContent = s));
    $("#new").close();
    $("#new-form").reset();
    location.hash = `#/s/${encodeURIComponent(community)}/${encodeURIComponent(me.address)}/${id}`;
  } catch (error) {
    $("#np-status").textContent = error.message;
  } finally {
    $("#np-post").disabled = false;
  }
});

function openMods(community) {
  const c = community ?? route.community ?? communities[0];
  if (!c) return;
  $("#mods-c").textContent = `s/${c}`;
  const list = follows(c);
  $("#mods-list").innerHTML = list.length
    ? list.map((a) => `<tr><td class="mono">${esc(a)}</td><td><button class="btn" type="button" data-unfollow="${esc(a)}">Unfollow</button></td></tr>`).join("")
    : '<tr><td class="muted">You follow no one here: you see everything.</td></tr>';
  const actions = labelActions();
  $("#label-actions").innerHTML = Object.entries(actions).map(([label, chosen]) => `<tr><td>${esc(label)}</td><td><div class="seg" data-label-action="${esc(label)}">${treatments.map((t) => `<button type="button" class="${t === chosen ? "on" : ""}">${t}</button>`).join("")}</div></td></tr>`).join("")
    + `<tr><td colspan="2"><input type="text" id="new-label" placeholder="Another label, e.g. low-effort" style="max-width:260px"></td></tr>`;
  $("#mods").dataset.community = c;
  $("#showall").checked = showAll;
  $("#mods").showModal();
}
$("#open-mods").onclick = () => openMods();
$("#mods").addEventListener("click", (event) => {
  const c = $("#mods").dataset.community;
  const unfollow = event.target.closest("[data-unfollow]");
  if (unfollow) {
    store.set(`follows:${c}`, follows(c).filter((a) => a !== unfollow.dataset.unfollow));
    openMods(c);
  }
  const seg = event.target.closest("[data-label-action]");
  if (seg && event.target.tagName === "BUTTON") {
    store.set("labelActions", { ...labelActions(), [seg.dataset.labelAction]: event.target.textContent });
    openMods(c);
  }
});
$("#mods-add-btn").onclick = () => {
  const c = $("#mods").dataset.community;
  const address = $("#mods-add").value.trim();
  if (address) store.set(`follows:${c}`, [...new Set([...follows(c), address])]);
  $("#mods-add").value = "";
  openMods(c);
};
$("#mods").addEventListener("close", () => {
  const label = $("#new-label")?.value.trim();
  if (label) store.set("labelActions", { ...labelActions(), [label]: "badge" });
  showAll = $("#showall").checked;
  render();
});

$("#open-settings").onclick = () => {
  $("#st-node").value = settings.node;
  $("#st-home").value = settings.home;
  $("#st-address").textContent = signer()?.address ?? "none";
  $("#st-key").hidden = true;
  $("#st-status").textContent = "";
  $("#settings").showModal();
};
$("#st-generate").onclick = () => {
  store.set("key", toHex(sdk.generatePrivateKey()));
  $("#st-address").textContent = signer().address;
  $("#st-status").textContent = "New key made and kept in this browser.";
};
$("#st-import").onclick = () => {
  $("#st-key").hidden = false;
  $("#st-key").value = "";
  $("#st-key").focus();
};
$("#st-export").onclick = () => {
  $("#st-key").hidden = false;
  $("#st-key").value = store.get("key", "");
};
$("#settings-form").addEventListener("submit", (event) => {
  if (event.submitter?.value !== "save") return;
  const key = $("#st-key").value.trim().toLowerCase();
  if (!$("#st-key").hidden && key && key !== store.get("key", "")) {
    if (!/^[0-9a-f]{64}$/.test(key)) {
      event.preventDefault();
      $("#st-status").textContent = "A key is 64 hex characters.";
      return;
    }
    store.set("key", key);
  }
  settings.node = $("#st-node").value.trim().replace(/\/$/, "") || settings.node;
  settings.home = $("#st-home").value.trim() || settings.home;
  store.set("node", settings.node);
  store.set("home", settings.home);
  timeIndexes.clear();
  boot();
});

// ------------------------------------------------------------------ boot

async function boot() {
  try {
    communities = (await api("/api/chain/children", homePath())).directories ?? [];
  } catch (error) {
    communities = [];
    $("#main").innerHTML = `<p class="error">Could not reach ${esc(settings.node)}: ${esc(error.message)}. Pick another node in Settings.</p>`;
    renderRail();
    renderWho();
    return;
  }
  render();
}
window.addEventListener("hashchange", render);
boot();
