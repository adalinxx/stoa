// Stoa in the browser: reads every record from a node by CID, ranks and
// filters here, and asks the reader's Lattice Wallet to sign each write. No
// server of its own.
import * as sdk from "./vendor/lattice-sdk.js";
import { judge, treatments } from "../client/moderation.mjs";
import { rank } from "../client/rank.mjs";
import * as read from "../client/read.mjs";
import { tip, view, volumeLoader } from "../client/state.mjs";
import { blockTimes } from "../client/time.mjs";
import * as write from "../client/write.mjs";
import { coinsMessage, commentNode, esc, mediaSlot, nameOf, ordered, parseRoute, pathHTML, pendingNote, plural, postHref, postRow, safeLink, short, voteBox, when } from "./lib.mjs";

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
const nodeHost = () => {
  try {
    return new URL(settings.node).host;
  } catch {
    return settings.node;
  }
};
const WINDOW_DAYS = 14;
const ADDRESS = /^b[a-z2-7]{40,}$/;

// ---------------------------------------------------------------- wallet

// The reader's account: the address the Lattice Wallet gave this site. The
// wallet holds the key and asks the reader to approve every write.
let connected = null;
const wallet = () => window.lattice ?? null;
const signer = () => (connected ? { address: connected } : null);

class NoWallet extends Error {
  constructor() {
    super("This needs Lattice Wallet.");
  }
}

async function connectWallet() {
  if (!wallet()) throw new NoWallet();
  connected = await wallet().connect();
  renderWho();
  return signer();
}

/** The reader's signer, connecting first if they have not; NoWallet without the extension. */
const me = async () => signer() ?? (await connectWallet());

/** What the wallet said, in the page's words. */
function walletMessage(error) {
  const text = String(error?.message ?? error);
  if (/declin|reject|denied|cancel/i.test(text)) return "You declined it in the wallet. Nothing was sent.";
  if (/locked/i.test(text)) return "Unlock Lattice Wallet, then try again.";
  return text;
}

// The wallet takes one request from a page at a time: writes wait their turn.
let walletTurn = Promise.resolve();
function viaWallet(ask) {
  const run = walletTurn.then(ask, ask);
  walletTurn = run.catch(() => {});
  return run;
}

/** Shown when something needs the wallet and the browser does not have it. */
function needWallet(why) {
  $("#gw-why").textContent = why ?? "";
  if (!$("#getwallet").open) $("#getwallet").showModal();
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

/** Why a chain could not be read, for a person. */
function readFailure(error, community) {
  const where = community ? `s/${community}` : "Stoa";
  if (error?.status === 404 || /HTTP 404/.test(error?.message ?? "")) return `${nodeHost()} doesn't serve ${where}.`;
  if (error instanceof TypeError) return `Couldn't reach ${nodeHost()}.`;
  return `Couldn't read ${where} from ${nodeHost()}: ${error?.message ?? error}`;
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

const communityOf = (chain) => (chain.length > homePath().length ? chain.slice(homePath().length).join("/") : null);

/** What writing on `chain` costs the reader, and what they hold there. */
async function costOn(chain, address) {
  const [info, account] = await Promise.all([
    api("/api/chain/info", chain),
    address ? api(`/api/state/account/${address}`, chain).catch(() => null) : null,
  ]);
  return { fee: BigInt(info.minRelayFee ?? 0), balance: BigInt(account?.balance ?? 0) };
}

/**
 * Sign and send: resolves once the wallet has sent the write, with a promise
 * of its landing (true once every write reads back; `onSlow` after a minute
 * without it). Throws NoWallet, the no-coins message, or what the wallet said.
 */
async function send(chain, records, status = () => {}) {
  const { address } = await me();
  status("Preparing…");
  const community = communityOf(chain);
  let state, cost;
  try {
    [state, cost] = await Promise.all([stateOf(chain), costOn(chain, address)]);
  } catch (error) {
    throw new Error(readFailure(error, community));
  }
  if (cost.fee > 0n && cost.balance < cost.fee) {
    throw new Error(community ? coinsMessage(community, address, cost.fee)
      : `Saving this to your home chain costs ${cost.fee} of its coins, and you have none there yet.`);
  }
  const actions = await write.changes(state, records);
  status("Approve it in Lattice Wallet…");
  try {
    // The wallet chooses the nonce and sends the write, from and to its own node.
    await viaWallet(() => wallet().writeRecords({ chainPath: chain, actions, fee: String(cost.fee) }));
  } catch (error) {
    throw new Error(walletMessage(error));
  }
  return (onSlow = () => {}) => landing(chain, records, onSlow);
}

async function landing(chain, records, onSlow) {
  const started = Date.now();
  let slow = false;
  while (Date.now() - started < 10 * 60_000) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    if (!slow && Date.now() - started > 60_000) {
      slow = true;
      onSlow();
    }
    const now = await stateOf(chain).catch(() => null);
    if (!now) continue;
    let landed = true;
    for (const [key, value] of records) if ((await now.get(key)) !== value) landed = false;
    if (landed) return true;
  }
  return false;
}

// --------------------------------------------------------------- notices

/** A message that stays until dismissed (or closed by the code that opened it). */
function notice(message, { bad = false, action } = {}) {
  const box = document.createElement("div");
  box.className = `notice${bad ? " bad" : ""}`;
  box.setAttribute("role", bad ? "alert" : "status");
  const text = document.createElement("p");
  const close = Object.assign(document.createElement("button"), { className: "close", type: "button", textContent: "×", title: "Dismiss" });
  close.setAttribute("aria-label", "Dismiss");
  close.onclick = () => box.remove();
  box.append(text, close);
  const handle = {
    update(next, options = {}) {
      text.textContent = next;
      box.classList.toggle("bad", Boolean(options.bad));
      box.querySelector(".act")?.remove();
      const act = options.action;
      if (act) {
        const button = Object.assign(document.createElement("button"), { className: "btn small act", type: "button", textContent: act.label });
        button.onclick = () => {
          box.remove();
          act.run();
        };
        close.before(button);
      }
      return handle;
    },
    close: () => box.remove(),
  };
  handle.update(message, { bad, action });
  $("#notices").append(box);
  return handle;
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
  const reader = signer();
  if (!reader) return (mine = { joined: [], follows: new Map() });
  const joined = await read.joined(home, reader.address);
  const followed = await Promise.all(communities.map(async (c) => [c, await read.followedModerators(home, reader.address, c)]));
  mine = { joined, follows: new Map(followed) };
}

/**
 * A reader choice: kept in the browser and shown at once, then written to the
 * home chain (it lands a block later). The notice says where it stands; if the
 * write fails the choice stays in this browser and the notice says why.
 */
// Home-chain keys with a save in flight. A write is made against the state it
// read, so a second change to the same key waits for the first to land.
const savingKeys = new Set();
const saving = (records) => records.some(([key]) => savingKeys.has(key));

function saveChoice(records, keepLocally, what) {
  if (signer() && saving(records)) {
    notice(`Your last change to ${what} is still landing. Try again once it has.`);
    return false;
  }
  keepLocally();
  if (!signer()) return true;
  const Whats = what[0].toUpperCase() + what.slice(1);
  const keys = records.map(([key]) => key);
  keys.forEach((key) => savingKeys.add(key));
  const shown = notice(`Saving ${what}: approve it in Lattice Wallet.`);
  send(homePath(), records)
    .then((land) => {
      shown.update(`Saving ${what}: waiting for a block…`);
      return land(() => shown.update(`Saving ${what}: sent, not in a block yet. It may still land.`));
    })
    .then((landed) => (landed ? shown.close() : shown.update(`${Whats} was sent but hasn't landed. It's kept in this browser.`)))
    .catch((error) => shown.update(`${Whats} is kept in this browser only. ${error.message}`, { bad: true }))
    .finally(() => keys.forEach((key) => savingKeys.delete(key)));
  return true;
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
// Items the reader chose to see despite a label, for this visit.
const revealed = new Set();

async function judgeFor(state, community) {
  if (showAll) return () => ({ treatment: "show", labels: [] });
  const sets = new Map(await Promise.all(follows(community).map(async (a) => [a, await read.labelsBy(state, a)])));
  const verdict = judge(sets, labelActions());
  return (item) => (revealed.has(`${item.author}/${item.id}`) ? { treatment: "show", labels: verdict(item).labels } : verdict(item));
}

function follow(community, address, following) {
  const keep = () => {
    const on = store.get(`follows:${community}`, []), off = store.get(`follows-off:${community}`, []);
    store.set(`follows:${community}`, following ? [...new Set([...on, address])] : on.filter((x) => x !== address));
    store.set(`follows-off:${community}`, following ? off.filter((x) => x !== address) : [...new Set([...off, address])]);
  };
  const reader = signer();
  if (reader) saveChoice(write.followModerator(reader.address, community, address, following), keep, "who you follow");
  else keep();
}

// ------------------------------------------------- the reader's own writes

// Writes sent but not yet read back from a block, drawn in place as pending.
// Key: `<community>|<author>|<id>`.
const pendingItems = new Map(); // posts and comments: { kind, community, author, id, value, on?, parent?, slow? }
const pendingVotes = new Map(); // { direction, slow? }
const itemErrors = new Map(); // { message, direction? } shown under the item, until a read shows the vote
const keyOf = (community, author, id) => `${community}|${author}|${id}`;

/** An item with the reader's pending vote applied (and any error under it). */
function withVote(item, community) {
  const key = keyOf(community, item.author, item.id);
  const vote = pendingVotes.get(key);
  // A "still landing" note goes once the chain shows the vote.
  if (itemErrors.get(key)?.direction !== undefined && itemErrors.get(key).direction === (item.mine ?? 0)) itemErrors.delete(key);
  const error = itemErrors.get(key)?.message;
  if (!vote) return error ? { ...item, error } : item;
  const was = item.mine ?? 0, now = vote.direction;
  return {
    ...item, mine: now, error,
    ups: item.ups - (was === 1) + (now === 1), downs: item.downs - (was === -1) + (now === -1),
    votePending: true,
  };
}

async function castVote(button) {
  const [community, author, id] = button.dataset.target.split("|");
  const key = keyOf(community, author, id);
  if (pendingVotes.has(key)) return;
  const box = button.closest("[data-votes]");
  const current = box.querySelector('[aria-pressed="true"]');
  const direction = current === button ? 0 : Number(button.dataset.vote);
  itemErrors.delete(key);
  let land;
  try {
    // Connect first if needed: the wallet asks within this click.
    await me();
    pendingVotes.set(key, { direction });
    redraw();
    land = await send(chainOf(community), write.vote(signer().address, author, id, direction));
  } catch (error) {
    pendingVotes.delete(key);
    if (error instanceof NoWallet) return needWallet("Voting is signed by your key, so it needs the wallet.");
    const message = `Vote not counted. ${walletMessage(error)}`;
    itemErrors.set(key, { message });
    announce(message);
    return redraw();
  }
  const landed = await land(() => {
    itemErrors.set(key, { message: "Your vote is taking a while to land.", direction });
    redraw();
  });
  pendingVotes.delete(key);
  if (landed) itemErrors.delete(key);
  else itemErrors.set(key, { message: "Your vote was sent but hasn't landed yet. It may still land.", direction });
  refresh();
}

// ---------------------------------------------------------------- render

const $ = (s) => document.querySelector(s);

let communities = [];
let route = { view: "home" };
let sort = store.get("sort", "hot");
// What the current view last read, so a vote or reveal redraws without re-reading.
let shown = null;

function renderRail() {
  const joined = joinedList();
  const link = (c) => `<li><a href="#/s/${encodeURIComponent(c)}" data-c="${esc(c)}">s/${esc(c)}</a></li>`;
  const mineList = communities.filter((c) => joined.includes(c));
  const others = communities.filter((c) => !joined.includes(c));
  $("#communities").innerHTML = !communities.length
    ? '<p class="muted" style="padding:5px 8px;margin:0">No communities yet.</p>'
    : (mineList.length ? `<h3>Your communities</h3><ul class="tree">${mineList.map(link).join("")}</ul>` : "")
      + (others.length ? `<h3>${mineList.length ? "More communities" : "Communities"}</h3><ul class="tree">${others.map(link).join("")}</ul>` : "");
  document.querySelectorAll(".tree a").forEach((a) => {
    const on = (route.view === "home" && a.dataset.nav === "home") || a.dataset.c === route.community;
    a.classList.toggle("on", on);
    if (on) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  $("#np-c").innerHTML = communities.map((c) => `<option value="${esc(c)}" ${c === route.community ? "selected" : ""}>s/${esc(c)}</option>`).join("");
}

function renderWho() {
  const reader = signer();
  $("#who").innerHTML = reader
    ? `<button class="btn" type="button" id="account-btn" popovertarget="account" title="${esc(reader.address)}"><span class="account-name">${esc(nameOf(reader.address, names))}</span><span aria-hidden="true">▾</span></button>`
    : wallet()
      ? '<button class="btn" type="button" id="connect">Connect wallet</button>'
      : '<button class="btn" type="button" id="get-wallet">Get wallet</button>';
  $("#connect")?.addEventListener("click", () =>
    connectWallet().then(render).catch((error) => notice(`Not connected. ${walletMessage(error)}`, { bad: true })));
  $("#get-wallet")?.addEventListener("click", () => needWallet());
}

function setTitle(text) {
  document.title = text ? `${text} · Stoa` : "Stoa";
}

/** One community's posts with their votes, comment counts and block times. */
async function loadPosts(community) {
  const state = await stateOf(chainOf(community));
  const [posts, times, judgeItem] = await Promise.all([read.posts(state), timesOf(state), judgeFor(state, community)]);
  const reader = signer()?.address;
  return Promise.all(
    posts.map(async (post) => {
      const votes = await read.votes(state, post.author, post.id);
      let comments = 0;
      for await (const _ of state.list(`index/comment/${post.author}/${post.id}/`)) comments++;
      return {
        ...post, community, ups: votes.ups, downs: votes.downs, mine: reader ? votes.voters.get(reader) ?? 0 : 0,
        comments, time: times.get(`${post.author}/${post.id}`) ?? 0, verdict: judgeItem(post),
      };
    }),
  );
}

const sortTabs = () => `<div class="tabs" role="group" aria-label="Sort posts">${["hot", "new", "top", "controversial"].map((s) => `<button type="button" class="tab" data-sort="${s}" aria-pressed="${s === sort}">${s[0].toUpperCase() + s.slice(1)}</button>`).join("")}</div>`;

function communityActions(c) {
  return `<button class="btn" type="button" id="join" data-join="${esc(c)}">${joinedList().includes(c) ? "Leave" : "Join"}</button><button class="btn" type="button" data-mods="${esc(c)}">Moderation</button>`;
}

/**
 * The frame of a view: drawn once when the view changes, kept while the same
 * view re-reads (so a refresh never blanks the page or loses the scroll).
 */
function frame(key, html) {
  const main = $("#main");
  if (main.dataset.view === key) return false;
  main.dataset.view = key;
  main.innerHTML = html;
  // What was read for the last view no longer describes the page.
  shown = null;
  return true;
}

// Errors are said once to screen readers, when they happen, not on each redraw.
let lastAnnounced = "";
function announce(message) {
  if (!message || message === lastAnnounced) return;
  lastAnnounced = message;
  $("#announcer").textContent = message;
}

async function showFeed(list, { title, community }, id) {
  setTitle(community ? `s/${community}` : "Home");
  frame(`feed|${title}`, `<div class="titlebar"><h1>${esc(title)}</h1>${community ? communityActions(community) : ""}</div>
    ${sortTabs()}<div id="feed"><p class="empty">Reading from ${esc(nodeHost())}…</p></div>`);
  if (community && $("#join")) $("#join").textContent = joinedList().includes(community) ? "Leave" : "Join";
  const results = await Promise.all(list.map((c) => loadPosts(c).then((posts) => ({ c, posts }), (error) => ({ c, error }))));
  const posts = results.flatMap((r) => r.posts ?? []);
  const labellers = list.flatMap((c) => follows(c));
  await stateOf(homePath()).then((home) => loadNames(home, [...posts.map((p) => p.author), ...labellers])).catch(() => {});
  if (stale(id)) return;
  // A refresh keeps rows where the reader last saw them (a post never moves
  // under the pointer after a vote); a new sort or view ranks afresh.
  const order = shown?.view === "feed" && shown.title === title && shown.sort === sort ? shown.order : null;
  shown = { view: "feed", title, list, community, posts, failures: results.filter((r) => r.error), order, sort };
  if (shown.failures.length) announce(shown.failures.map((f) => readFailure(f.error, f.c)).join(" "));
  redraw();
}

function drawFeed() {
  if (!$("#feed")) return;
  const { list, community, posts, failures } = shown;
  const pending = [...pendingItems.values()].filter((p) => p.kind === "post" && list.includes(p.community))
    .filter((p) => !posts.some((q) => q.author === p.author && q.id === p.id))
    .map((p) => ({ ...p.value, tags: p.value.tags ?? [], media: [], author: p.author, id: p.id, community: p.community, ups: 0, downs: 0, mine: 0, comments: 0, verdict: { treatment: "show", labels: [] }, pending: p.slow ? "slow" : "waiting" }));
  const keyed = (p) => `${p.community}|${p.author}|${p.id}`;
  if (shown.sort !== sort || !shown.order) {
    shown.order = rank(posts, sort).map(keyed);
    shown.sort = sort;
  }
  const at = new Map(shown.order.map((k, n) => [k, n]));
  // Posts that arrived since the order was set go first, newest ranking first.
  const fresh = rank(posts.filter((p) => !at.has(keyed(p))), sort);
  const kept = posts.filter((p) => at.has(keyed(p))).sort((a, b) => at.get(keyed(a)) - at.get(keyed(b)));
  shown.order = [...fresh, ...kept].map(keyed);
  const rows = [...pending, ...[...fresh, ...kept].map((p) => withVote(p, p.community))];
  const retry = `<button class="btn" type="button" data-retry>Try again</button><button class="btn" type="button" data-choose-node>Choose another node</button>`;
  let html = "";
  if (failures.length && !rows.length) {
    html = `<div class="panel bad"><h2>${failures.length === 1 ? esc(readFailure(failures[0].error, failures[0].c)) : `Couldn't read your communities from ${esc(nodeHost())}.`}</h2>
      <p>Nothing here can be shown until a node serves ${failures.length === 1 ? `s/${esc(failures[0].c)}` : "them"}. Another node may have it.</p><div class="row2">${retry}</div></div>`;
  } else {
    if (failures.length) {
      html += `<div class="panel bad"><p style="margin:0 0 8px">${failures.map((f) => esc(readFailure(f.error, f.c))).join(" ")} Posts from ${failures.length === 1 ? "it" : "them"} are missing below.</p><div class="row2">${retry}</div></div>`;
    }
    if (rows.length) {
      html += rows.map((p) => postRow(p, names, { inCommunity: Boolean(community) })).join("");
    } else if (!list.length) {
      html += `<div class="panel"><h2>Your home feed is empty</h2><p>Join a community to see its posts here.</p><div class="row2">${communities.slice(0, 6).map((c) => `<a class="btn" href="#/s/${encodeURIComponent(c)}">s/${esc(c)}</a>`).join("")}</div></div>`;
    } else {
      html += `<div class="panel"><h2>No posts${community ? ` in s/${esc(community)}` : ""} yet</h2><p>Start the conversation.</p><div class="row2"><button class="btn primary" type="button" data-new-post>Write the first post</button></div></div>`;
    }
  }
  $("#feed").innerHTML = html;
  document.querySelector("#main .tabs")?.toggleAttribute("hidden", rows.length < 2);
  loadMedia();
}

async function showPost({ community, author, id }, renderId) {
  const fresh = frame(`post|${community}|${author}|${id}`, `<a class="back" href="#/s/${encodeURIComponent(community)}">← s/${esc(community)}</a><div id="thread"><p class="empty">Reading from ${esc(nodeHost())}…</p></div>`);
  if (fresh) setTitle(`s/${community}`);
  let tree, judgeItem;
  try {
    const state = await stateOf(chainOf(community));
    let times;
    [tree, times, judgeItem] = await Promise.all([read.thread(state, author, id), timesOf(state), judgeFor(state, community)]);
    const reader = signer()?.address;
    if (tree) {
      const withVotes = async (node) => {
        const v = await read.votes(state, node.author, node.id);
        Object.assign(node, { ups: v.ups, downs: v.downs, mine: reader ? v.voters.get(reader) ?? 0 : 0, time: times.get(`${node.author}/${node.id}`) ?? 0 });
        await Promise.all(node.replies.map(withVotes));
      };
      await withVotes(tree);
      const authors = [];
      const collect = (node) => { authors.push(node.author); node.replies.forEach(collect); };
      collect(tree);
      await stateOf(homePath()).then((home) => loadNames(home, [...authors, ...follows(community)])).catch(() => {});
    }
  } catch (error) {
    if (stale(renderId)) return;
    shown = null;
    const failure = readFailure(error, community);
    announce(failure);
    $("#thread").innerHTML = `<div class="panel bad"><h2>${esc(failure)}</h2><p>This post can't be shown until a node serves all of s/${esc(community)}.</p><div class="row2"><button class="btn" type="button" data-retry>Try again</button><button class="btn" type="button" data-choose-node>Choose another node</button></div></div>`;
    return;
  }
  if (stale(renderId)) return;
  // A refresh of the same post keeps comments where they were.
  const commentRank = shown?.view === "post" ? shown.commentRank : null;
  shown = { view: "post", community, author, id, tree, judgeItem, commentRank };
  redraw();
}

/** The thread as last read, with the reader's pending comments and votes in place. */
function drawThread() {
  if (!$("#thread")) return;
  const { community, author, id, judgeItem } = shown;
  let tree = shown.tree && ordered(structuredClone(shown.tree));
  const pendingPost = pendingItems.get(keyOf(community, author, id));
  if (!tree && pendingPost) tree = { ...pendingPost.value, author, id, tags: pendingPost.value.tags ?? [], labels: [], media: [], replies: [], ups: 0, downs: 0, mine: 0, pending: pendingPost.slow ? "slow" : "waiting" };
  if (!tree) {
    $("#thread").innerHTML = `<div class="panel"><h2>This post isn't here</h2><p>${esc(nodeHost())} doesn't have it in s/${esc(community)}. Its author may have deleted it, or it hasn't reached this node yet.</p><div class="row2"><a class="btn" href="#/s/${encodeURIComponent(community)}">Back to s/${esc(community)}</a></div></div>`;
    return;
  }
  setTitle(tree.title);
  // Pending comments, under what they answer.
  const byKey = new Map();
  const index = (node) => { byKey.set(`${node.author}/${node.id}`, node); node.replies.forEach(index); };
  index(tree);
  for (const p of pendingItems.values()) {
    if (p.kind !== "comment" || p.community !== community || p.on.author !== author || p.on.id !== id) continue;
    if (byKey.has(`${p.author}/${p.id}`)) continue;
    const parent = (p.parent && byKey.get(`${p.parent.author}/${p.parent.id}`)) || tree;
    parent.replies.push({ author: p.author, id: p.id, body: p.value.body ?? "", labels: p.value.labels ?? [], replies: [], ups: 0, downs: 0, pending: p.slow ? "slow" : "waiting" });
  }
  // Comments keep the places they were first drawn in (a vote landing never
  // moves one under the pointer); ones not seen before follow, in order.
  const rankOf = shown.commentRank ?? new Map();
  const keep = (node) => {
    node.replies.forEach(keep);
    node.replies = node.replies.map((r, n) => [r, n])
      .sort(([a, i], [b, j]) => (rankOf.get(`${a.author}/${a.id}`) ?? Infinity) - (rankOf.get(`${b.author}/${b.id}`) ?? Infinity) || i - j)
      .map(([r]) => r);
  };
  keep(tree);
  const ranks = new Map();
  const number = (node) => node.replies.forEach((r) => { ranks.set(`${r.author}/${r.id}`, ranks.size); number(r); });
  number(tree);
  shown.commentRank = ranks;
  const voted = (node) => {
    const n = withVote(node, community);
    n.replies = node.replies.map(voted);
    return n;
  };
  tree = voted(tree);
  let count = 0;
  const counting = (node) => node.replies.forEach((r) => { count++; counting(r); });
  counting(tree);
  const link = safeLink(tree.link);
  $("#thread").innerHTML = `<article class="op${tree.pending ? " pending" : ""}">
      <div class="meta"><a href="#/s/${encodeURIComponent(community)}">s/${esc(community)}</a><span>${esc(nameOf(author, names))}</span>${tree.pending ? pendingNote(tree.pending) : when(tree.time)}${tree.tags.map((t) => `<span class="tag">${esc(t.toUpperCase())}</span>`).join("")}</div>
      <h1>${esc(tree.title)}</h1>
      ${link ? `<a class="link" href="${esc(link)}" target="_blank" rel="noopener noreferrer nofollow">${esc(link)} ↗</a>` : ""}
      ${tree.media.map((cid) => mediaSlot(cid, community, tree.tags.includes("nsfw"))).join("")}
      ${tree.body ? `<div class="body" style="margin-top:10px">${esc(tree.body)}</div>` : ""}
      ${tree.pending ? "" : `<div class="acts" style="margin-top:10px">${voteBox({ ...tree, community }, { row: true })}<button type="button" data-reply="${esc(author)}/${esc(id)}">Reply</button><button type="button" data-label="${esc(author)}/${esc(id)}">Label…</button></div>`}
      ${tree.error ? `<p class="inline-error">${esc(tree.error)}</p>` : ""}
    </article>
    <section class="comments" aria-label="Comments">
      ${count ? `<p class="comments-head">${plural(count, "comment")}</p>${tree.replies.map((c) => commentNode(c, community, judgeItem, follows(community), names)).join("")}`
        : tree.pending ? "" : `<p class="empty">No comments yet. <button class="linkish" type="button" data-reply="${esc(author)}/${esc(id)}">Write the first one</button></p>`}
    </section>`;
  loadMedia();
}

function redraw() {
  // Keyboard focus on a vote button comes back to it after the redraw.
  const focused = document.activeElement?.closest?.("[data-vote]");
  const again = focused && `[data-vote="${focused.dataset.vote}"][data-target="${CSS.escape(focused.dataset.target)}"]`;
  if (shown?.view === "feed") drawFeed();
  else if (shown?.view === "post") drawThread();
  if (again) document.querySelector(again)?.focus();
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
      slot.outerHTML = slot.dataset.blur === "1" ? tag.replace('class="media"', 'class="media blur" title="Tap to show" data-unblur') : tag;
    } catch {
      slot.textContent = "No one is serving this file right now.";
      slot.removeAttribute("data-media");
    }
  }
}

function showAside() {
  const c = route.community;
  if (!c) {
    $("#aside").innerHTML = `<div class="card"><h4>Home</h4><p class="muted">Posts from the communities you joined, ranked on this page from votes and block times.</p><dl class="kv"><dt>Node</dt><dd>${esc(nodeHost())}</dd></dl></div>`;
    return;
  }
  const n = follows(c).length;
  $("#aside").innerHTML = `<div class="card"><h4>s/${esc(c)}</h4><p class="muted">A community with a chain of its own. Anyone can post here, and anyone can mine it.</p>
    <dl class="kv"><dt>Your coins</dt><dd id="aside-balance">${signer() ? "…" : `<button class="linkish" type="button" data-connect-or-get>Connect to see</button>`}</dd>
    <dt>Labels</dt><dd>${n ? `you follow ${plural(n, "account")}` : "you follow no one"} · <button class="linkish" type="button" data-mods="${esc(c)}">Manage</button></dd></dl>
    <details class="more"><summary>Chain details</summary><dl class="kv"><dt>Chain</dt><dd class="mono">${pathHTML(chainOf(c))}</dd><dt>Height</dt><dd class="mono" id="aside-height">…</dd><dt>Node</dt><dd>${esc(nodeHost())}</dd></dl></details></div>`;
  api("/api/chain/info", chainOf(c)).then((i) => ($("#aside-height").textContent = i.height ?? "starting")).catch(() => ($("#aside-height").textContent = "not served by this node"));
  const reader = signer();
  if (reader) api(`/api/state/account/${reader.address}`, chainOf(c)).then((a) => ($("#aside-balance").textContent = a.balance ?? "0")).catch(() => ($("#aside-balance").textContent = "0"));
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
    const reader = signer();
    if (reader) await loadNames(home, [reader.address]).catch(() => {});
  }
  if (stale(id)) return;
  renderRail();
  renderWho();
  showAside();
  if (route.view === "post") return showPost(route, id);
  if (route.view === "community") return showFeed([route.community], { title: `s/${route.community}`, community: route.community }, id);
  const joined = joinedList().filter((c) => communities.includes(c));
  return showFeed(joined, { title: "Home" }, id);
}
/** Re-read the current view in place. */
const refresh = () => render();

// --------------------------------------------------------------- actions

document.addEventListener("click", async (event) => {
  const el = event.target.closest("button, img, video, a[data-new-post]");
  if (!el || el.closest("dialog, #account")) return;
  if (el.dataset.sort) {
    sort = el.dataset.sort;
    store.set("sort", sort);
    document.querySelectorAll("[data-sort]").forEach((b) => b.setAttribute("aria-pressed", String(b === el)));
    if (shown?.view === "feed") drawFeed();
  } else if (el.dataset.reveal) {
    revealed.add(el.dataset.reveal);
    refresh();
  } else if (el.hasAttribute("data-expand")) {
    el.closest("p").nextElementSibling.hidden = false;
    el.closest("p").remove();
  } else if (el.hasAttribute("data-unblur")) {
    el.classList.remove("blur");
  } else if (el.dataset.vote) {
    castVote(el);
  } else if (el.dataset.reply || el.dataset.label) {
    openReply(el.dataset.reply ?? el.dataset.label, Boolean(el.dataset.label));
  } else if (el.dataset.follow) {
    follow(route.community, el.dataset.follow, true);
    refresh();
  } else if (el.dataset.mods) {
    openMods(el.dataset.mods);
  } else if (el.dataset.join) {
    toggleJoin(el.dataset.join);
  } else if (el.hasAttribute("data-retry")) {
    $("#main").dataset.view = "";
    boot();
  } else if (el.hasAttribute("data-choose-node")) {
    openSettings({ advanced: true });
  } else if (el.hasAttribute("data-new-post")) {
    openNewPost();
  } else if (el.hasAttribute("data-connect-or-get")) {
    if (!wallet()) needWallet();
    else connectWallet().then(render).catch((error) => notice(`Not connected. ${walletMessage(error)}`, { bad: true }));
  }
});

function toggleJoin(c) {
  const joining = !joinedList().includes(c);
  const keep = () => {
    const list = joinedList();
    store.set("joined", joining ? [...new Set([...list, c])] : list.filter((x) => x !== c));
    store.set("left", joining ? store.get("left", []).filter((x) => x !== c) : [...new Set([...store.get("left", []), c])]);
  };
  const reader = signer();
  if (reader) saveChoice(write.join(reader.address, c, joining), keep, joining ? `that you joined s/${c}` : `that you left s/${c}`);
  else keep();
  render();
}

// A write from a dialog: the dialog stays until the wallet has sent it, then
// closes, and the write is drawn in place as pending until its block lands.
async function sendFromDialog({ chain, records, status, button, pending, done }) {
  // While the write is on its way the dialog stays: its answer shows there.
  const dialog = button.closest("dialog");
  const sending = (on) => {
    dialog.toggleAttribute("data-sending", on);
    button.disabled = on;
    dialog.querySelectorAll("[data-close]").forEach((b) => (b.disabled = on));
  };
  sending(true);
  status.classList.remove("bad");
  let land;
  try {
    land = await send(chain, records, (s) => (status.textContent = s));
  } catch (error) {
    sending(false);
    status.classList.add("bad");
    if (error instanceof NoWallet) {
      status.innerHTML = `This needs Lattice Wallet, which holds your key. <a href="https://github.com/adalinxx/lattice-wallet/releases/latest" target="_blank" rel="noopener noreferrer">Get it ↗</a> Your draft stays here.`;
    } else {
      status.textContent = error.message;
    }
    return;
  }
  sending(false);
  status.textContent = "";
  pendingItems.set(pending.key, pending);
  done();
  const landed = await land(() => {
    pending.slow = true;
    redraw();
  });
  if (landed) pendingItems.delete(pending.key);
  refresh();
}

const drafts = new Map();
let replyTarget = null;
const KNOWN_LABELS = ["spam", "off-topic", "nsfw", "low-effort"];
function openReply(target, labelling) {
  const [author, id] = target.split("/");
  replyTarget = { author, id, labelling, key: `${labelling ? "label" : "reply"}:${target}` };
  const onPost = route.author === author && route.id === id;
  const findNode = (node) => (node.author === author && node.id === id ? node : node.replies.map(findNode).find(Boolean));
  const node = shown?.tree && findNode(shown.tree);
  const quoted = node ? (onPost ? node.title : node.body) : "";
  $("#reply-title").textContent = labelling ? `Label this ${onPost ? "post" : "comment"}` : `Reply to ${nameOf(author, names)}`;
  $("#rp-quote").innerHTML = `<strong>${esc(nameOf(author, names))}</strong>: ${esc((quoted ?? "").slice(0, 400))}`;
  $("#rp-labels-wrap").hidden = !labelling;
  $("#rp-chips").innerHTML = [...new Set([...KNOWN_LABELS, ...Object.keys(labelActions())])].map((l) => `<label><input type="checkbox" value="${esc(l)}"> ${esc(l)}</label>`).join("");
  $("#rp-b-label").innerHTML = labelling ? 'Reason <span class="muted">(optional, public)</span>' : "Your reply";
  $("#rp-send").textContent = labelling ? "Add label" : "Reply";
  $("#rp-b").value = drafts.get(replyTarget.key) ?? "";
  $("#rp-labels").value = "";
  $("#rp-status").textContent = "";
  $("#reply").showModal();
  $(labelling ? "#rp-chips input" : "#rp-b").focus();
  showCost($("#rp-cost"), route.community, labelling ? "Labelling" : "Replying");
}
$("#rp-b").addEventListener("input", () => replyTarget && drafts.set(replyTarget.key, $("#rp-b").value));
$("#reply-form").addEventListener("submit", async (event) => {
  if (event.submitter?.value !== "send") return;
  event.preventDefault();
  const status = $("#rp-status");
  status.classList.add("bad");
  const { community, author: postAuthor, id: postId } = route;
  const on = { author: postAuthor, id: postId };
  const target = replyTarget.author === postAuthor && replyTarget.id === postId ? undefined : { author: replyTarget.author, id: replyTarget.id };
  const typed = $("#rp-labels").value.split(",").map((l) => l.trim().toLowerCase()).filter(Boolean);
  const labels = replyTarget.labelling ? [...new Set([...[...document.querySelectorAll("#rp-chips input:checked")].map((i) => i.value), ...typed])] : [];
  const body = $("#rp-b").value.trim();
  if (replyTarget.labelling && labels.length === 0) return ($("#rp-status").textContent = "Choose at least one label.");
  if (!replyTarget.labelling && !body) return ($("#rp-status").textContent = "Write something first.");
  let reader;
  try {
    reader = await me();
  } catch (error) {
    if (!(error instanceof NoWallet)) return (status.textContent = walletMessage(error));
  }
  const newId = write.newId();
  const author = reader?.address ?? "";
  const value = replyTarget.labelling ? { body, labels } : { body };
  const records = replyTarget.labelling
    ? write.label(author, newId, on, labels, { target, body })
    : write.comment(author, newId, on, { body }, target ? { parent: target } : {});
  const draftKey = replyTarget.key;
  await sendFromDialog({
    chain: chainOf(community), records, status, button: $("#rp-send"),
    pending: { key: keyOf(community, author, newId), kind: "comment", community, author, id: newId, value, on, parent: target },
    done: () => {
      drafts.delete(draftKey);
      $("#reply").close();
      redraw();
    },
  });
});

/** The line in a dialog that says what a write costs before it is made. */
async function showCost(line, community, doing) {
  // Only the newest check may write the line (the community can change while one runs).
  const request = String(Number(line.dataset.request ?? 0) + 1);
  line.dataset.request = request;
  const current = () => line.dataset.request === request;
  line.classList.remove("bad");
  const button = line.closest("form").querySelector(".btn.primary");
  if (!line.closest("dialog").hasAttribute("data-sending")) button.disabled = false;
  if (!community) return (line.textContent = "");
  if (!wallet()) {
    line.innerHTML = `${esc(doing)} needs Lattice Wallet, a free browser extension that holds your key. <a href="https://github.com/adalinxx/lattice-wallet/releases/latest" target="_blank" rel="noopener noreferrer">Get it ↗</a> You can write your draft now.`;
    return;
  }
  const reader = signer();
  line.textContent = "";
  let cost;
  try {
    cost = await costOn(chainOf(community), reader?.address);
  } catch (error) {
    if (!current()) return;
    line.classList.add("bad");
    line.textContent = `${readFailure(error, community)} ${doing} won't work until a node serves it.`;
    button.disabled = true;
    return;
  }
  if (!current()) return;
  const fee = cost.fee === 0n ? "Free" : `Costs ${cost.fee} s/${community} ${cost.fee === 1n ? "coin" : "coins"}`;
  if (!reader) return (line.textContent = `${fee}. You'll connect and approve it in Lattice Wallet.`);
  if (cost.balance < cost.fee) {
    line.classList.add("bad");
    line.innerHTML = `${esc(coinsMessage(community, reader.address, cost.fee))} <button class="linkish" type="button" data-copy-address>Copy address</button>`;
    line.querySelector("[data-copy-address]").onclick = async (event) => {
      event.target.textContent = await navigator.clipboard.writeText(reader.address).then(() => "Copied", () => reader.address);
    };
    button.disabled = true;
    return;
  }
  line.textContent = `${fee} · you have ${cost.balance}. You'll approve it in Lattice Wallet.`;
}

function openNewPost() {
  if (!communities.length) return notice("There are no communities to post in yet.");
  $("#np-status").textContent = "";
  $("#np-status").classList.remove("bad");
  if (route.community && communities.includes(route.community)) $("#np-c").value = route.community;
  $("#new").showModal();
  $("#np-t").focus();
  showCost($("#np-cost"), $("#np-c").value, "Posting");
}
$("#open-new").onclick = openNewPost;
document.querySelectorAll("dialog").forEach((dialog) => {
  dialog.addEventListener("cancel", (event) => {
    if (dialog.hasAttribute("data-sending")) event.preventDefault();
  });
  dialog.querySelectorAll("[data-close]").forEach((button) => (button.onclick = () => dialog.close("cancel")));
});
$("#np-c").addEventListener("change", () => showCost($("#np-cost"), $("#np-c").value, "Posting"));
$("#new-form").addEventListener("submit", async (event) => {
  if (event.submitter?.value !== "post") return;
  event.preventDefault();
  const status = $("#np-status");
  status.classList.add("bad");
  const community = $("#np-c").value;
  const title = $("#np-t").value.trim();
  const link = $("#np-l").value.trim();
  if (!title) {
    $("#np-t").focus();
    return (status.textContent = "A post needs a title.");
  }
  if (link && !safeLink(link)) {
    $("#np-l").focus();
    return (status.textContent = "The link must start with https:// or http://");
  }
  const tags = [...document.querySelectorAll("#new-form .checks input:checked")].map((i) => i.value);
  let reader;
  try {
    reader = await me();
  } catch (error) {
    if (!(error instanceof NoWallet)) return (status.textContent = walletMessage(error));
  }
  const id = write.newId();
  const author = reader?.address ?? "";
  const value = { title, ...(link && { link }), ...($("#np-b").value.trim() && { body: $("#np-b").value.trim() }), ...(tags.length && { tags }) };
  await sendFromDialog({
    chain: chainOf(community), records: write.post(author, id, value), status, button: $("#np-post"),
    pending: { key: keyOf(community, author, id), kind: "post", community, author, id, value },
    done: () => {
      $("#new").close();
      $("#new-form").reset();
      location.hash = postHref(community, author, id);
    },
  });
});

function openMods(community) {
  const c = community ?? route.community ?? communities[0];
  if (!c) return;
  $("#mods-c").textContent = `s/${c}`;
  $("#mods-status").textContent = "";
  const list = follows(c);
  $("#mods-list").innerHTML = list.length
    ? list.map((a) => `<tr><td>${names.has(a) ? `<strong>${esc(names.get(a))}</strong> ` : ""}<span class="mono muted" title="${esc(a)}">${esc(short(a))}</span></td><td><button class="btn small" type="button" data-unfollow="${esc(a)}">Unfollow</button></td></tr>`).join("")
    : '<tr><td class="muted" colspan="2" style="text-align:left;white-space:normal">You follow no one here, so you see everything.</td></tr>';
  const actions = labelActions();
  $("#label-actions").innerHTML = Object.entries(actions).map(([label, chosen]) => `<tr><td>${esc(label)}</td><td><div class="seg" role="group" aria-label="What ${esc(label)} does" data-label-action="${esc(label)}">${treatments.map((t) => `<button type="button" aria-pressed="${t === chosen}">${t}</button>`).join("")}</div></td></tr>`).join("");
  $("#mods").dataset.community = c;
  $("#showall").checked = showAll;
  if (!$("#mods").open) $("#mods").showModal();
}
$("#mods").addEventListener("click", (event) => {
  const c = $("#mods").dataset.community;
  const unfollow = event.target.closest("[data-unfollow]");
  if (unfollow) {
    follow(c, unfollow.dataset.unfollow, false);
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
  if (!address) return $("#mods-add").focus();
  if (!ADDRESS.test(address)) return ($("#mods-status").textContent = "That isn't an account address. It starts with “b” and is about 60 characters.");
  $("#mods-add").value = "";
  follow(c, address, true);
  openMods(c);
};
$("#mods-add").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    $("#mods-add-btn").click();
  }
});
const addLabel = () => {
  const label = $("#new-label").value.trim().toLowerCase();
  if (!label) return $("#new-label").focus();
  $("#new-label").value = "";
  if (!(label in labelActions())) store.set("labelActions", { ...labelActions(), [label]: "badge" });
  openMods($("#mods").dataset.community);
};
$("#new-label-btn").onclick = addLabel;
$("#new-label").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    addLabel();
  }
});
$("#mods").addEventListener("close", () => {
  showAll = $("#showall").checked;
  refresh();
});

function openSettings({ advanced = false } = {}) {
  $("#st-node").value = settings.node;
  $("#st-home").value = settings.home;
  $("#st-status").textContent = "";
  $("#st-advanced").open = advanced;
  renderAccount();
  $("#settings").showModal();
  if (advanced) $("#st-node").focus();
}
$("#open-settings").onclick = () => openSettings();
function renderAccount() {
  const reader = signer();
  $("#st-account-hint").innerHTML = reader ? "Lattice Wallet holds your key and asks you to approve each post, comment, vote and label."
    : wallet() ? "Connect Lattice Wallet to post, comment, vote and set a name."
      : 'Lattice Wallet, a browser extension, holds your key. <a href="https://github.com/adalinxx/lattice-wallet/releases/latest" target="_blank" rel="noopener noreferrer">Get it ↗</a>';
  $("#st-address-row").hidden = !reader;
  $("#st-address").textContent = reader?.address ?? "";
  $("#st-name").value = names.get(reader?.address) ?? "";
  $("#st-name").disabled = !reader;
  $("#st-name-hint").textContent = reader ? "Public, on the home chain. Saving a new name asks your wallet to approve it." : "Connect your wallet to set a name.";
  $("#st-connect").hidden = !wallet() || Boolean(reader);
  $("#st-disconnect").hidden = !reader;
}
$("#st-connect").onclick = () =>
  connectWallet().then(() => { renderAccount(); render(); }).catch((error) => ($("#st-status").textContent = walletMessage(error)));
async function disconnect() {
  await wallet()?.disconnect().catch(() => {});
  connected = null;
  renderAccount();
  render();
}
$("#st-disconnect").onclick = disconnect;
$("#settings-form").addEventListener("submit", (event) => {
  if (event.submitter?.value !== "save") return;
  const node = $("#st-node").value.trim().replace(/\/$/, "");
  if (node && !safeLink(node)) {
    event.preventDefault();
    $("#st-advanced").open = true;
    $("#st-status").classList.add("bad");
    $("#st-status").textContent = "The node must be a web address, like https://node.example.";
    return $("#st-node").focus();
  }
  const name = $("#st-name").value.trim();
  const reader = signer();
  if (reader && name && name !== names.get(reader.address)) {
    saveChoice(write.profile(reader.address, { name }), () => names.set(reader.address, name), "your name");
    renderWho();
  }
  const moved = (node && node !== settings.node) || ($("#st-home").value.trim() && $("#st-home").value.trim() !== settings.home);
  if (!moved) return;
  settings.node = node || settings.node;
  settings.home = $("#st-home").value.trim() || settings.home;
  store.set("node", settings.node);
  store.set("home", settings.home);
  timeIndexes.clear();
  $("#main").dataset.view = "";
  boot();
});

// The account menu.
$("#account").addEventListener("toggle", async (event) => {
  if (event.newState !== "open") return;
  const reader = signer();
  if (!reader) return $("#account").hidePopover();
  $("#acc-name").textContent = nameOf(reader.address, names);
  $("#acc-address").textContent = reader.address;
  $("#acc-copy").textContent = "Copy address";
  $("#acc-coins").innerHTML = communities.map((c) => `<dt>s/${esc(c)}</dt><dd data-coins="${esc(c)}">…</dd>`).join("");
  for (const c of communities) {
    api(`/api/state/account/${reader.address}`, chainOf(c))
      .then((a) => `${a.balance ?? 0} coins`, () => "unavailable")
      .then((text) => { const dd = $(`#acc-coins [data-coins="${CSS.escape(c)}"]`); if (dd) dd.textContent = text; });
  }
});
$("#acc-copy").onclick = async () => {
  try {
    await navigator.clipboard.writeText(signer()?.address ?? "");
    $("#acc-copy").textContent = "Copied";
  } catch {
    $("#acc-copy").textContent = "Couldn't copy: select the address above";
  }
};
$("#acc-settings").onclick = () => {
  $("#account").hidePopover();
  openSettings();
};
$("#acc-disconnect").onclick = () => {
  $("#account").hidePopover();
  disconnect();
};

// ------------------------------------------------------------------ boot

async function boot() {
  connected = (await wallet()?.address().catch(() => null)) ?? null;
  try {
    communities = (await api("/api/chain/children", homePath())).directories ?? [];
  } catch (error) {
    communities = [];
    shown = null;
    $("#main").dataset.view = "";
    $("#main").innerHTML = `<div class="panel bad"><h2>${esc(readFailure(error))}</h2><p>Stoa reads everything from a node. Try again, or choose another node that hosts Stoa.</p><div class="row2"><button class="btn" type="button" data-retry>Try again</button><button class="btn primary" type="button" data-choose-node>Choose another node</button></div></div>`;
    renderRail();
    renderWho();
    $("#aside").innerHTML = "";
    return;
  }
  render();
}
window.addEventListener("hashchange", () => {
  window.scrollTo(0, 0);
  render();
});
boot();
