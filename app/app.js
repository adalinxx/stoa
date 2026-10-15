// Stoa in the browser: reads every record from a node by CID, ranks and
// filters here, and signs writes with the reader's key. No server of its own.
import * as sdk from "./vendor/lattice-sdk.js";
import { judge, treatments } from "../client/moderation.mjs";
import { rank } from "../client/rank.mjs";
import * as read from "../client/read.mjs";
import { tip, view, volumeLoader } from "../client/state.mjs";
import { blockTimes } from "../client/time.mjs";
import * as write from "../client/write.mjs";
import { ago, coinsMessage, commentNode, esc, mediaSlot, nameOf, parseRoute, postRow, safeLink, short } from "./lib.mjs";

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

// The reader's account: the address the Lattice Wallet gave this site. The
// wallet holds the key and asks the reader to approve every write.
let connected = null;
const wallet = () => window.lattice ?? null;
function signer() {
  return connected ? { address: connected } : null;
}
async function connectWallet() {
  if (!wallet()) throw new Error("Install the Lattice Wallet extension to post, comment and vote.");
  connected = await wallet().connect();
  renderWho();
  return signer();
}

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
  const me = signer() ?? (await connectWallet());
  status("Preparing…");
  const state = await stateOf(chain);
  const actions = await write.changes(state, records);
  const [account, info] = await Promise.all([
    api(`/api/state/account/${me.address}`, chain).catch(() => null),
    api("/api/chain/info", chain).catch(() => ({})),
  ]);
  const fee = BigInt(info.minRelayFee ?? 0);
  if (fee > 0n && BigInt(account?.balance ?? 0) < fee) {
    const where = chain.length > homePath().length ? chain.slice(homePath().length).join("/") : "the home chain";
    throw new Error(coinsMessage(where, me.address, fee));
  }
  status("Approve it in your wallet…");
  // The wallet chooses the nonce, from its own node.
  const signed = await wallet().writeRecords({ chainPath: chain, actions, fee: String(fee) });
  status("Sending…");
  const response = await fetch(new URL("/transactions", settings.node), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(signed.payload),
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

// The reader's choices: on their home chain once written there, in this
// browser until then (or when writing them fails).
let mine = { joined: [], follows: new Map() };
// What the reader undid wins over the chain until the chain catches up.
const follows = (community) => {
  const off = store.get(`follows-off:${community}`, []);
  return [...new Set([...(mine.follows.get(community) ?? []), ...store.get(`follows:${community}`, [])])].filter((a) => !off.includes(a));
};
const joinedList = () => {
  const local = store.get("joined", null);
  const left = store.get("left", []);
  const list = mine.joined.length ? [...new Set([...mine.joined, ...(local ?? [])])] : local ?? communities;
  return list.filter((c) => !left.includes(c));
};

/** Read the reader's joins and followed labels from the home chain. */
async function loadMine(home) {
  const me = signer();
  if (!me) return (mine = { joined: [], follows: new Map() });
  const joined = await read.joined(home, me.address);
  const followed = await Promise.all(communities.map(async (c) => [c, await read.followedModerators(home, me.address, c)]));
  mine = { joined, follows: new Map(followed) };
}

/**
 * A reader choice: kept in the browser and shown at once, then written to the
 * home chain in the background (it lands a block later). If the write fails
 * the choice stays in the browser and the reader is told why.
 */
function saveChoice(records, keepLocally) {
  keepLocally();
  if (!signer()) return;
  submit(homePath(), records, () => {}).catch((error) => alertBox(`Kept in this browser only: ${error.message}`));
}

// Profile names, read from the home chain once per address.
const names = new Map();
async function loadNames(home, addresses) {
  await Promise.all([...new Set(addresses)].filter((a) => !names.has(a)).map(async (a) => {
    const profile = await read.profile(home, a).catch(() => undefined);
    if (typeof profile?.name === "string" && profile.name.trim()) names.set(a, profile.name.trim().slice(0, 40));
  }));
}
const labelActions = () => store.get("labelActions", { spam: "hide", nsfw: "blur", "off-topic": "collapse" });
let showAll = false;

async function judgeFor(state, community) {
  if (showAll) return () => ({ treatment: "show", labels: [] });
  const sets = new Map(await Promise.all(follows(community).map(async (a) => [a, await read.labelsBy(state, a)])));
  return judge(sets, labelActions());
}

// ---------------------------------------------------------------- render

const $ = (s) => document.querySelector(s);

let communities = [];
let route = { view: "home" };
let sort = store.get("sort", "hot");

function renderRail() {
  const joined = joinedList();
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
  $("#who").innerHTML = me
    ? `<span class="muted" title="${esc(me.address)}">${esc(nameOf(me.address, names))}</span>`
    : '<button class="btn" type="button" id="connect">Connect wallet</button>';
  $("#connect")?.addEventListener("click", () => connectWallet().then(render).catch((error) => alertBox(error.message)));
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

async function showFeed(communitiesShown, title, id) {
  $("#main").innerHTML = `<h1>${esc(title)}</h1>
    <div class="tabs">${["hot", "new", "top", "controversial"].map((s) => `<button class="tab ${s === sort ? "on" : ""}" data-sort="${s}">${s[0].toUpperCase() + s.slice(1)}</button>`).join("")}</div>
    <div id="feed"><p class="empty">Reading from ${esc(new URL(settings.node).host)}…</p></div>`;
  try {
    const all = (await Promise.all(communitiesShown.map((c) => loadPosts(c).catch(() => [])))).flat();
    await loadNames(await stateOf(homePath()), all.map((p) => p.author));
    if (stale(id)) return;
    const ranked = rank(all, sort);
    $("#feed").innerHTML = ranked.length ? ranked.map((p) => postRow(p, names)).join("") : '<p class="empty">No posts yet. Be the first: New post.</p>';
    loadMedia();
  } catch (error) {
    $("#feed").innerHTML = `<p class="error">${esc(error.message)}</p>`;
  }
}

async function showPost({ community, author, id }, renderOf) {
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
    const authors = [];
    const collect = (node) => { authors.push(node.author); node.replies.forEach(collect); };
    collect(tree);
    await loadNames(await stateOf(homePath()), authors);
    if (stale(renderOf)) return;
    const link = safeLink(tree.link);
    $("#thread").innerHTML = `<div class="op">
      <div class="meta"><span>s/${esc(community)}</span><span>${esc(nameOf(author, names))}</span><span>${ago(when.get(`${author}/${id}`))}</span></div>
      <h1>${esc(tree.title)}</h1>
      ${link ? `<a class="link" href="${esc(link)}" target="_blank" rel="noopener noreferrer nofollow">${esc(link)} ↗</a>` : ""}
      ${tree.media.map((cid) => mediaSlot(cid, community, tree.tags.includes("nsfw"))).join("")}
      ${tree.body ? `<div class="body" style="margin-top:10px">${esc(tree.body)}</div>` : ""}
      <div class="acts"><span>▲ ${tree.ups - tree.downs}</span><button data-reply="${esc(author)}/${esc(id)}">Reply</button><button data-label="${esc(author)}/${esc(id)}">Label…</button></div>
    </div>
    ${tree.replies.length ? tree.replies.map((c) => commentNode(c, community, judgeItem, follows(community), names)).join("") : '<p class="empty">No comments yet.</p>'}`;
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
  const joined = joinedList();
  $("#aside").innerHTML = `<div class="card"><h4>s/${esc(c)}</h4><p class="muted">A chain of its own. Anyone can post; anyone can mine it.</p>
    <dl class="kv"><dt>Chain</dt><dd class="mono">${esc(chainOf(c).join("/"))}</dd><dt>Height</dt><dd class="mono" id="aside-height">…</dd><dt>Labels you follow</dt><dd>${follows(c).length} ${follows(c).length === 1 ? "account" : "accounts"}</dd><dt>Your coins</dt><dd class="mono" id="aside-balance">…</dd></dl>
    <div class="row2" style="justify-content:flex-start"><button class="btn" id="join">${joined.includes(c) ? "Leave" : "Join"}</button><button class="btn" id="aside-mods">Moderation</button></div></div>`;
  api("/api/chain/info", chainOf(c)).then((i) => ($("#aside-height").textContent = i.height ?? "starting")).catch(() => ($("#aside-height").textContent = "unreachable"));
  const me = signer();
  if (me) api(`/api/state/account/${me.address}`, chainOf(c)).then((a) => ($("#aside-balance").textContent = a.balance ?? "0")).catch(() => ($("#aside-balance").textContent = "0"));
  else $("#aside-balance").textContent = "no key";
  $("#join").onclick = () => {
    const me = signer();
    const joining = !joinedList().includes(c);
    const keep = () => {
      const list = joinedList();
      store.set("joined", joining ? [...list, c] : list.filter((x) => x !== c));
      store.set("left", joining ? store.get("left", []).filter((x) => x !== c) : [...new Set([...store.get("left", []), c])]);
    };
    if (me) saveChoice(write.join(me.address, c, joining), keep);
    else keep();
    render();
  };
  $("#aside-mods").onclick = () => openMods(c);
}

// Renders overlap (a navigation while the last one still reads the node);
// only the newest one writes the page.
let renderId = 0;
const stale = (id) => id !== renderId;

async function render() {
  const id = ++renderId;
  route = parseRoute(location.hash);
  const home = await stateOf(homePath()).catch(() => null);
  if (home) {
    await loadMine(home).catch(() => {});
    const me = signer();
    if (me) await loadNames(home, [me.address]);
  }
  if (stale(id)) return;
  renderRail();
  renderWho();
  showAside();
  if (route.view === "post") return showPost(route, id);
  if (route.view === "community") return showFeed([route.community], `s/${route.community}`, id);
  const joined = joinedList().filter((c) => communities.includes(c));
  return showFeed(joined, "Home", id);
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
    let me;
    try {
      me = signer() ?? (await connectWallet());
    } catch (error) {
      return alertBox(error.message);
    }
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
  const { community, author: postAuthor, id: postId } = route;
  const on = { author: postAuthor, id: postId };
  const target = replyTarget.author === postAuthor && replyTarget.id === postId ? undefined : { author: replyTarget.author, id: replyTarget.id };
  const labels = replyTarget.labelling ? $("#rp-labels").value.split(",").map((l) => l.trim()).filter(Boolean) : [];
  if (replyTarget.labelling && labels.length === 0) return ($("#rp-status").textContent = "Name at least one label.");
  if (!replyTarget.labelling && !$("#rp-b").value.trim()) return ($("#rp-status").textContent = "Write something first.");
  $("#rp-send").disabled = true;
  try {
    const me = signer() ?? (await connectWallet());
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
  const community = $("#np-c").value;
  const title = $("#np-t").value.trim();
  const link = $("#np-l").value.trim();
  if (!title) return ($("#np-status").textContent = "A post needs a title.");
  if (link && !safeLink(link)) return ($("#np-status").textContent = "The link must start with https:// or http://");
  const tags = [...document.querySelectorAll("#new-form .checks input:checked")].map((i) => i.value);
  $("#np-post").disabled = true;
  try {
    const me = signer() ?? (await connectWallet());
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
  if (!$("#mods").open) $("#mods").showModal();
}
$("#open-mods").onclick = () => openMods();
$("#mods").addEventListener("click", (event) => {
  const c = $("#mods").dataset.community;
  const unfollow = event.target.closest("[data-unfollow]");
  if (unfollow) {
    const a = unfollow.dataset.unfollow;
    const keep = () => {
      store.set(`follows:${c}`, store.get(`follows:${c}`, []).filter((x) => x !== a));
      store.set(`follows-off:${c}`, [...new Set([...store.get(`follows-off:${c}`, []), a])]);
    };
    const me = signer();
    if (me) saveChoice(write.followModerator(me.address, c, a, false), keep);
    else keep();
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
  $("#mods-add").value = "";
  if (!address) return;
  const keep = () => {
    store.set(`follows:${c}`, [...new Set([...store.get(`follows:${c}`, []), address])]);
    store.set(`follows-off:${c}`, store.get(`follows-off:${c}`, []).filter((x) => x !== address));
  };
  const me = signer();
  if (me) saveChoice(write.followModerator(me.address, c, address), keep);
  else keep();
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
  $("#st-status").textContent = "";
  renderAccount();
  $("#settings").showModal();
};
function renderAccount() {
  $("#st-address").textContent = signer()?.address ?? (wallet() ? "not connected" : "no wallet installed");
  $("#st-name").value = names.get(signer()?.address) ?? "";
  $("#st-name").disabled = !signer();
  $("#st-connect").hidden = !wallet() || !!signer();
  $("#st-disconnect").hidden = !signer();
}
$("#st-connect").onclick = () =>
  connectWallet().then(renderAccount).catch((error) => ($("#st-status").textContent = error.message));
$("#st-disconnect").onclick = async () => {
  await wallet()?.disconnect();
  connected = null;
  renderAccount();
  renderWho();
};
$("#settings-form").addEventListener("submit", (event) => {
  if (event.submitter?.value !== "save") return;
  const name = $("#st-name").value.trim();
  const me = signer();
  if (me && name && name !== names.get(me.address)) {
    saveChoice(write.profile(me.address, { name }), () => names.set(me.address, name));
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
  connected = (await wallet()?.address().catch(() => null)) ?? null;
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
