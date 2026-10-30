// Stoa in the browser: reads every record from a node by CID, ranks and
// filters here, and asks Selfhold to sign each write: its window over the
// page, whose key a passkey keeps, or Selfhold for Chrome. A fee sponsor takes
// this device's work for each fee, and a storage sponsor for each file kept,
// so taking part needs no coins. No server of its own.
import * as sdk from "./vendor/lattice-sdk.js";
import { judge, treatments } from "../client/moderation.mjs";
import { rank } from "../client/rank.mjs";
import * as read from "../client/read.mjs";
import { tip, view, volumeLoader } from "../client/state.mjs";
import { mediaVolume } from "../client/media.mjs";
import { StorageRefused, StorageStopped, store as storeFile, storageChain } from "../client/storage.mjs";
import { hasher, workDevice } from "../client/work/hash.mjs";
import { accountIcon, createMoniker, DEFAULTS as MONIKER } from "./vendor/moniker-sdk/src/index.mjs";
import * as monikerNames from "./vendor/moniker-sdk/src/records/names.mjs";
import { writeRequest } from "./vendor/moniker-sdk/src/records/wallet.mjs";
import { stepFor } from "./vendor/moniker-sdk/src/picker.mjs";
import { selfhold } from "./vendor/selfhold.mjs";
import * as write from "../client/write.mjs";
import { byline, commentNode, esc, mediaSlot, nameOf, ordered, parseRoute, pathHTML, pendingNote, plural, postHref, postRow, profileHref, safeLink, short, voteBox, when } from "./lib.mjs";

const $ = (s) => document.querySelector(s);

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
const DEFAULT_NODE = "https://lattice-testnet-apps-iad.fly.dev";
// The sponsor that takes this device's work for fees and for keeping files.
const DEFAULT_SPONSOR = "https://lattice-testnet-apps-iad.fly.dev:8650/sponsor";
// Selfhold's window; the tests serve their own.
const DEFAULT_WALLET_PAGE = "https://wallet.selfhold.app/";
// Nodes Stoa used to default to that no longer run.
const RETIRED_NODES = ["lattice-testnet-stoa.fly.dev"];
// Moniker's trial chains, before it launched as Nexus/moniker: a reader who
// saved one follows the move.
const RETIRED_MONIKER = /^Nexus\/testnet\/moniker-[0-9a-f]+$/;
/** `url` as a node address the SDK will dial (https, or http on loopback), else null. */
const nodeAddress = (url) => {
  try {
    const address = sdk.normalizeNodeURL(url);
    return RETIRED_NODES.includes(new URL(address).host) ? null : address;
  } catch {
    return null;
  }
};
const local = (host) => host === "localhost" || host === "127.0.0.1";
/**
 * Selfhold's window: its own page, or, for a page served on this computer,
 * one served on this computer too, as the tests do. Never anywhere else: the
 * window keeps the account.
 */
function walletPageOf(saved) {
  try {
    const url = new URL(saved);
    if (url.protocol === "http:" && local(url.hostname) && local(location.hostname) && !url.username && !url.password) return url.href;
  } catch {}
  return DEFAULT_WALLET_PAGE;
}
/** A sponsor's address as typed: https (http only on this computer), else "" for none. */
const sponsorAddress = (url) => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || (parsed.protocol === "http:" && local(parsed.hostname)) ? parsed.href.replace(/\/$/, "") : "";
  } catch {
    return "";
  }
};
const savedMoniker = store.get("monikerChain", null);
const savedSponsor = store.get("sponsor", null);
const savedStorage = store.get("storage", null);
const settings = {
  // A node saved before addresses were checked, or since retired, falls back
  // to the default.
  node: nodeAddress(store.get("node", DEFAULT_NODE)) ?? DEFAULT_NODE,
  home: store.get("home", "Nexus/testnet/stoa-41d5ab"),
  // Kept only when the reader chose a chain other than the SDK's, so a
  // reader on the default follows it when an SDK release moves Moniker.
  moniker: savedMoniker && !RETIRED_MONIKER.test(savedMoniker) ? savedMoniker : MONIKER.chain.join("/"),
  // Kept only when the reader chose another (or none, ""), as the moniker chain is.
  sponsor: typeof savedSponsor === "string" ? savedSponsor : DEFAULT_SPONSOR,
  storage: typeof savedStorage === "string" ? savedStorage : DEFAULT_SPONSOR,
  // Selfhold for Chrome only where Settings choose it; else Selfhold's window.
  extension: store.get("wallet", "web") === "extension",
  walletPage: walletPageOf(store.get("walletPage", DEFAULT_WALLET_PAGE)),
};
const homePath = () => settings.home.split("/");
// The Stoa chain is a community too, s/all: posts of its own, and its page
// shows every community's posts with them.
const ALL = "all";
const chainOf = (community) => (community === ALL ? homePath() : [...homePath(), ...community.split("/")]);
const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
const nodeHost = () => hostOf(settings.node);
const ADDRESS = /^b[a-z2-7]{40,}$/;

// ---------------------------------------------------------------- wallet

// The reader's account: the address Selfhold gave this site. Selfhold holds
// the key and asks the reader to approve every write.
let connected = null;
// Selfhold's window, opened over the page from a click, for Stoa's chains
// (sent to the node in Settings) and for Moniker's (sent to its hosts). Its
// fee is paid with this device's work, through the sponsor in Settings.
const webFor = (hosts) => selfhold({ use: "window", wallet: settings.walletPage, hosts, sponsor: () => settings.sponsor || undefined });
const web = webFor(() => [settings.node]);
const webMoniker = webFor(() => moniker.hosts());
// Selfhold for Chrome, through the same calls.
const chrome = selfhold({ use: "extension", hosts: () => [settings.node] });
const chromeMoniker = selfhold({ use: "extension", hosts: () => moniker.hosts() });
/** Selfhold for Chrome where Settings choose it and it is installed, else Selfhold's window. */
const extension = () => settings.extension && Boolean(window.lattice?.isLatticeWallet);
const wallet = () => (extension() ? chrome : web);
const monikerWallet = () => (extension() ? chromeMoniker : webMoniker);
/** Where the reader approves: said in every prompt. */
const walletName = () => (extension() ? "Selfhold" : "Selfhold's window");
const signer = () => (connected ? { address: connected } : null);

/** An error already in the page's words (its text may hold a community name). */
class Said extends Error {}
const said = (error) => (error instanceof Said ? error.message : walletMessage(error));
/** A draft's record already holds something else: an earlier send of it landed. */
class Landed extends Error {
  constructor() {
    super("An earlier send of this landed. Send again to post this as a new one.");
  }
}
/** The reader closed the dialog before the wallet was asked: nothing to say. */
class Withdrawn extends Error {}
/** This write needs an account, and this click made one (or connected it): the next click sends. */
class JustConnected extends Error {}

/** The reader's account changed: what was pending or noted was theirs. */
function setConnected(address) {
  if (address !== connected) {
    pendingVotes.clear();
    pendingItems.clear();
    itemErrors.clear();
  }
  connected = address;
}

/** Asks Selfhold for this site's account. Its window opens only from a click: call it before any other wait. */
async function connectWallet() {
  setConnected(await wallet().connect());
  renderWho();
  // The page under any dialog becomes the reader's: their votes, communities, and no Sign in card.
  render();
  welcome();
  return signer();
}

/**
 * The reader's signer. Not connected yet, it connects in this click; with
 * Selfhold's window that click is spent opening it, so JustConnected says to
 * press again (Selfhold for Chrome answers within the same click).
 */
async function me() {
  if (signer()) return signer();
  await connectWallet();
  if (extension()) return signer();
  throw new JustConnected();
}

/** What Selfhold said, in the page's words. */
function walletMessage(error) {
  const text = String(error?.message ?? error);
  if (error?.code === "NeedsCoins") return needsCoins(error);
  if (/just declined|ask again in a moment/i.test(text)) return "Selfhold waits a few seconds after a decline. Try again in a moment.";
  if (/declined|rejected|denied/i.test(text)) return "You declined it in Selfhold. Nothing was sent.";
  if (/locked/i.test(text) && extension()) return "Unlock Selfhold, then try again.";
  return text;
}

/**
 * The fee couldn't be paid in work this time, and the account holds too few
 * coins: why, and the way out. Stoa's fees are usually paid with this device's work.
 */
function needsCoins({ sponsor: why, address }) {
  const reason = extension()
    ? "Selfhold for Chrome pays fees in coins, and this account holds too few. Turn off Selfhold for Chrome in Settings to take part with Selfhold's window, where this device's work pays."
    : {
      down: "This device's work usually pays the fee, but the fee sponsor isn't answering right now. Try again in a few minutes.",
      dear: "This device can't do the fee's work in reasonable time right now. Try again in a few minutes.",
      most: "The fee sponsor pays only so much for one write, and this one costs more than that.",
    }[why] ?? (settings.sponsor ? "The fee sponsor couldn't pay this fee. Try again in a few minutes." : "No fee sponsor is set in Settings, so the fee is paid in coins.");
  return `${reason} Or send coins to your account ID (${short(address ?? connected ?? "")}).`;
}

/** Said when something needs an account and the reader has none here yet. */
function needAccount(why) {
  $("#join-why").textContent = why ?? "";
  $("#join-window").hidden = extension();
  $("#join-extension").hidden = !extension();
  $("#join-status").textContent = "";
  if (!$("#signin").open) $("#signin").showModal();
  // Enter goes on, as the dialog asks; Escape or Not now leaves.
  $("#join-continue").focus();
}
$("#join-continue").onclick = async () => {
  $("#join-status").classList.remove("bad");
  $("#join-status").textContent = `Continue in ${walletName()}…`;
  try {
    await connectWallet();
    $("#signin").close();
    render();
  } catch (error) {
    $("#join-status").classList.add("bad");
    $("#join-status").textContent = walletMessage(error);
  }
};

/** Once connected, a reader with no name yet is asked to choose how they appear. */
function welcome() {
  const reader = signer()?.address;
  if (!reader || store.get(`welcomed:${reader}`, false)) return;
  loadNames([reader]).then(() => {
    if (signer()?.address !== reader || profiles.get(reader)?.name || handles.get(reader)) return;
    store.set(`welcomed:${reader}`, true);
    const greet = () => notice("Welcome to Stoa. Choose the name and @handle people see on your posts.", { action: { label: "Set up your profile", run: () => openProfile() } });
    // Not behind a dialog the reader is busy in: once it closes.
    const open = [...document.querySelectorAll("dialog[open]")].find((d) => d.id !== "signin");
    if (open) open.addEventListener("close", greet, { once: true });
    else greet();
  }, () => {});
}

// --------------------------------------------------------------- network

// Each chain is read from the nodes that serve it, in order: the chosen node
// when it serves it, then the hosts its directory declares (the SDK's
// ChainNodes); the list is made again when the chosen node changes.
const browserFetch = (...args) => fetch(...args);
const findNodes = () => new sdk.ChainNodes(settings.node, { fetch: browserFetch });
let nodes = findNodes();
/** `path` on node `base`, kept under any path the node's URL has. */
const onNode = (base, path) => new URL(`${base.replace(/\/+$/, "")}${path}`);

async function api(path, chain) {
  if (chain) return nodes.read(chain, (node) => apiOn(node.url, path, chain));
  return apiOn(settings.node, path);
}

async function apiOn(base, path, chain) {
  const url = onNode(base, path);
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
  if (error instanceof sdk.ChainOfflineError) return `No node serves ${where} right now.`;
  if (error?.status === 404 || /HTTP 404/.test(error?.message ?? "")) return `${nodeHost()} doesn't serve ${where}.`;
  if (error instanceof TypeError) return `Couldn't reach ${nodeHost()}.`;
  return `Couldn't read ${where} from ${nodeHost()}: ${error?.message ?? error}`;
}

/** A chain's state at the node's tip, read by CID from the node's Volumes. */
async function stateOf(chain) {
  return nodes.read(chain, async (node) => {
    const volumes = new sdk.VolumeClient(new sdk.HTTPVolumeTransport(`${node.url}/volumes`, { chainPath: chain }));
    const { hash, generalStateCID } = await tip(sdk, node.url, chain, volumes);
    return { chain, hash, volumes, ...view(volumeLoader(volumes, sdk.decodeDagCbor), generalStateCID) };
  });
}

const communityOf = (chain) => (chain.length > homePath().length ? chain.slice(homePath().length).join("/") : ALL);

/**
 * Sign and send `records` on `chain`, as the connected account. Selfhold's
 * window opens at once, in the click, while the page reads the chain and
 * builds the write; Selfhold shows it, pays its fee (with this device's
 * work, through the fee sponsor) and sends it. Resolves once it is sent, with
 * a promise of its landing (true once every write reads back; `onSlow`
 * after a minute without it), or of true at once when nothing needed
 * changing. `status(text)` hears where it stands.
 *
 * `beforeWallet()` is asked first: false withdraws it, nothing sent.
 * `fresh`: the key of a draft's record, which this write may create (or
 * rewrite identically) but never change: if it holds something else, an
 * earlier send landed, and Landed is thrown rather than editing it.
 */
async function send(chain, records, status = () => {}, beforeWallet = () => true, fresh) {
  const address = connected;
  if (!address) throw new Said("Connect Selfhold first.");
  if (!beforeWallet()) throw new Withdrawn();
  const community = communityOf(chain);
  // Our own refusal while building, said as is (the window closes, nothing sent).
  let refused = null;
  let sentActions = [];
  const request = (async () => {
    let state;
    try {
      state = await stateOf(chain);
    } catch (error) {
      throw new Said(readFailure(error, community));
    }
    // A key already holding its new value is no change: nothing to sign for it.
    const actions = (await write.changes(state, records)).filter((a) => a.oldValue !== a.newValue);
    const record = fresh && actions.find((a) => a.key === fresh);
    if (record && record.oldValue !== undefined) throw new Landed();
    // Already so on the chain: nothing to sign, nothing to pay.
    if (!actions.length) return null;
    sentActions = actions;
    return { chainPath: chain, actions };
  })().catch((error) => {
    refused = error;
    throw error;
  });
  status(`Approve it in ${walletName()}…`);
  let sent;
  try {
    sent = await wallet().writeRecords(request, { account: address, progress: (text) => status(`${text}…`.replace(/[.…]+…$/, "…")) });
  } catch (error) {
    if (refused) throw refused;
    if (error?.code === "AccountChanged" || error?.code === "NotConnected") {
      setConnected(await wallet().address().catch(() => null));
      render();
    }
    // Sent, though the node did not confirm it: it is on its way, and the
    // landing poll decides. Calling it a failure would invite a second copy.
    if (!/may still land/i.test(String(error?.message ?? error))) throw new Said(walletMessage(error));
  }
  if (sent === null) return () => Promise.resolve(true);
  const landed = sentActions.map((a) => [a.key, a.newValue]);
  return (onSlow = () => {}) => landing(chain, landed, onSlow);
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
    // A read that fails (a node serving part of the state, a blip) is one poll missed.
    try {
      const now = await stateOf(chain);
      let landed = true;
      for (const [key, value] of records) if ((await now.get(key)) !== value) landed = false;
      if (landed) return true;
    } catch {
      continue;
    }
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

function saveChoice(records, keepLocally, what, { about = what } = {}) {
  if (signer() && saving(records)) {
    const message = `Your last change to ${about} is still landing. Try again once it has.`;
    // A notice behind an open dialog would go unseen: say it in the dialog.
    const inDialog = document.querySelector("dialog[open] .status");
    if (inDialog) {
      inDialog.textContent = message;
      announce(message);
    } else {
      notice(message);
    }
    return false;
  }
  keepLocally();
  if (!signer()) return true;
  const Whats = what[0].toUpperCase() + what.slice(1);
  const keys = records.map(([key]) => key);
  keys.forEach((key) => savingKeys.add(key));
  const shown = notice(`Saving ${what}: approve it in ${walletName()}.`);
  send(homePath(), records)
    .then((land) => {
      shown.update(`Saving ${what}: waiting for a block…`);
      return land(() => shown.update(`Saving ${what}: sent, not in a block yet. It may still land.`));
    })
    .then((landed) => (landed ? shown.close() : shown.update(`${Whats} was sent but hasn't landed yet. It may still land.`)))
    .catch((error) => shown.update(`${Whats} is kept in this browser only. ${said(error)}`, { bad: true }))
    .finally(() => keys.forEach((key) => savingKeys.delete(key)));
  return true;
}

// How an author appears: the name on their Stoa profile (home chain,
// `user/<a>/profile`) and the @handle Moniker shows for them, verified there
// (it names the handle and the handle points back). Read once per address
// per visit; without either, an author is shown by account ID.
//
// Moniker is read from the reader's node, else, for Moniker's own chain,
// from the hosts Nexus lists for it, tried per read.
function monikerFor() {
  const chain = settings.moniker.split("/");
  const own = createMoniker({ sdk, chain, nodes: [settings.node] });
  // Moniker's hosts serve only Moniker's chain; `shared` also gives its pages.
  const shared = chain.join("/") === MONIKER.chain.join("/") ? createMoniker({ sdk, chain }) : null;
  const either = (read) => read(own).catch((error) => {
    if (!shared) throw error;
    return read(shared);
  });
  return {
    chain,
    shared,
    handlesOf: (addresses) => either((m) => m.handlesOf(addresses)),
    handleOf: (address) => either((m) => m.handleOf(address)),
    state: () => either((m) => m.state({ fresh: true })),
    /** Where a Moniker write goes: the reader's node first, as reads do, then Moniker's hosts. */
    hosts: async () => [...new Set([settings.node, ...(shared ? await shared.hosts().catch(() => []) : [])])],
  };
}
let moniker = monikerFor();
const profiles = new Map(); // address → { name?, bio?, link? }, from the home chain
const handles = new Map(); // address → "alice", while Moniker shows it
const names = new Map(); // address → what a byline says: "Alice Ng @alice", "@alice", "Alice Ng"
// Lookups in flight or done, shared by overlapping renders. A lookup that
// failed to read is dropped so a later render tries again; a change of node
// or chain starts a new set, and older lookups write nothing.
let lookups = new Map(); // address → Promise
// Names that come in after a render stopped waiting are drawn in one redraw.
let nameRedraw = null;
const nameArrived = () => {
  clearTimeout(nameRedraw);
  nameRedraw = setTimeout(() => {
    const again = focusSelector();
    renderWho();
    redraw(again);
  }, 300);
};
/** The byline for `a` from what is known of them, or nothing to add to their account ID. */
function setName(a) {
  const name = monikerNames.displayName(profiles.get(a)?.name)?.slice(0, read.PROFILE_LIMITS.name);
  const handle = handles.get(a);
  if (name || handle) names.set(a, monikerNames.label(a, { name, handle }));
  else names.delete(a);
}
async function loadNames(addresses) {
  const set = lookups;
  const wanted = [...new Set(addresses)].filter((a) => a && !set.has(a));
  if (wanted.length) {
    // One read of Moniker for the lot, and the profiles from the home chain.
    const handlesRead = moniker.handlesOf(wanted);
    const home = homeState ? Promise.resolve(homeState) : stateOf(homePath());
    for (const [n, a] of wanted.entries()) {
      set.set(a, Promise.allSettled([handlesRead.then((found) => found[n]), home.then((state) => read.profile(state, a))]).then(([handle, profile]) => {
        if (set !== lookups) return;
        // A read that failed is tried again by a later render.
        if (handle.status === "rejected" && profile.status === "rejected") return set.delete(a);
        if (handle.status === "fulfilled") {
          if (handle.value) handles.set(a, handle.value);
          else handles.delete(a);
        }
        if (profile.status === "fulfilled") {
          if (profile.value) profiles.set(a, profile.value);
          else profiles.delete(a);
        }
        if (handle.status === "rejected" || profile.status === "rejected") set.delete(a);
        const before = names.get(a);
        setName(a);
        if (names.get(a) !== before) nameArrived();
      }));
    }
  }
  // A render waits for its names a moment at most: they are a nicety, and one
  // stalled read must not hold every page that shows that author.
  await Promise.race([Promise.all([...new Set(addresses)].map((a) => set.get(a))), new Promise((resolve) => setTimeout(resolve, 2000))]);
}
/** Reads `a`'s name and handle again, as they changed them. */
function forgetName(a) {
  lookups.delete(a);
}
const labelActions = () => store.get("labelActions", { spam: "hide", nsfw: "blur", "off-topic": "collapse" });
let showAll = false;
// Items the reader chose to see despite a label, for this visit.
const revealed = new Set();
// Collapsed comments the reader opened, and blurred media they uncovered.
const expanded = new Set();
const unblurred = new Set();

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
  if (reader) return saveChoice(write.followModerator(reader.address, community, address, following), keep, "who you follow");
  keep();
  return true;
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
  let vote = pendingVotes.get(key);
  // A landed vote is drawn until a read shows it, so it never flickers back.
  if (vote?.landed && (item.mine ?? 0) === vote.direction) {
    pendingVotes.delete(key);
    vote = undefined;
  }
  // A "still landing" note goes once the chain shows the vote.
  if (itemErrors.get(key)?.direction !== undefined && itemErrors.get(key).direction === (item.mine ?? 0)) itemErrors.delete(key);
  const error = itemErrors.get(key)?.message;
  if (!vote) return error ? { ...item, error } : item;
  const was = item.mine ?? 0, now = vote.direction;
  return {
    ...item, mine: now, error,
    ups: item.ups - (was === 1) + (now === 1), downs: item.downs - (was === -1) + (now === -1),
    votePending: !vote.landed,
  };
}

async function castVote(button) {
  const [community, author, id] = button.dataset.target.split("|").map(decodeURIComponent);
  const key = keyOf(community, author, id);
  if ((pendingVotes.has(key) && !pendingVotes.get(key).landed) || button.getAttribute("aria-disabled") === "true") return;
  const box = button.closest("[data-votes]");
  const current = box.querySelector('[aria-pressed="true"]');
  const direction = current === button ? 0 : Number(button.dataset.vote);
  itemErrors.delete(key);
  // What follows belongs to this account: a switch meanwhile drops it.
  const owner = connected;
  const mine = () => connected === owner;
  let land;
  try {
    // No account here yet: the reader is told what Selfhold is, and continues
    // from there. The page then reads again, with the reader's own votes.
    if (!signer()) return needAccount("Votes are signed by your account, so others can count them.");
    pendingVotes.set(key, { direction });
    redraw();
    land = await send(chainOf(community), write.vote(signer().address, author, id, direction));
  } catch (error) {
    if (error instanceof Withdrawn || !mine()) return;
    pendingVotes.delete(key);
    const message = `Vote not counted. ${said(error)}`;
    // Shown until the reader leaves this page or votes here again.
    itemErrors.set(key, { message, untilNavigation: true });
    announce(message);
    return redraw();
  }
  const landed = await land(() => {
    if (!mine()) return;
    itemErrors.set(key, { message: "Your vote is taking a while to land.", direction });
    redraw();
  });
  if (!mine()) return;
  if (landed) {
    pendingVotes.set(key, { direction, landed: true });
    itemErrors.delete(key);
  } else {
    pendingVotes.delete(key);
    itemErrors.set(key, { message: "Your vote was sent but hasn't landed yet. It may still land.", direction });
  }
  refresh();
}

// ---------------------------------------------------------------- render

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
  // A redraw while New post is open keeps the community the reader chose.
  const chosen = $("#new").open ? $("#np-c").value : route.community;
  $("#np-c").innerHTML = communities.map((c) => `<option value="${esc(c)}" ${c === chosen ? "selected" : ""}>s/${esc(c)}</option>`).join("");
}

function renderWho() {
  const reader = signer();
  const html = reader
    ? `<button class="btn" type="button" id="account-btn" popovertarget="account" title="${esc(reader.address)}"><span class="avatar" aria-hidden="true">${accountIcon(reader.address, 20)}</span><span class="account-name">${esc(nameOf(reader.address, names))}</span><span aria-hidden="true">▾</span></button>`
    : '<button class="btn" type="button" id="sign-in">Sign in</button>';
  // Unchanged, it is left as is: an open account menu keeps its button.
  if ($("#who").dataset.html === html) return;
  $("#who").dataset.html = html;
  $("#who").innerHTML = html;
  $("#sign-in")?.addEventListener("click", () => needAccount());
}

function setTitle(text) {
  document.title = text ? `${text} · Stoa` : "Stoa";
}

/** One community's posts with their votes and comment counts. */
async function loadPosts(community) {
  const state = await stateOf(chainOf(community));
  const [posts, judgeItem] = await Promise.all([read.posts(state), judgeFor(state, community)]);
  const reader = signer()?.address;
  return Promise.all(
    posts.map(async (post) => {
      const votes = await read.votes(state, post.author, post.id);
      let comments = 0;
      for await (const _ of state.list(`index/comment/${post.author}/${post.id}/`)) comments++;
      return {
        ...post, community, ups: votes.ups, downs: votes.downs, mine: reader ? votes.voters.get(reader) ?? 0 : 0,
        comments, verdict: judgeItem(post),
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
// A feed's failure is said once, though each refresh finds it again; anything
// else is said each time it happens, even when the words repeat.
let lastAnnounced = "";
function announce(message, { once = false } = {}) {
  if (!message || (once && message === lastAnnounced)) return;
  lastAnnounced = message;
  const region = $("#announcer");
  region.textContent = "";
  requestAnimationFrame(() => (region.textContent = message));
}

async function showFeed(list, { title, community }, id) {
  setTitle(community ? `s/${community}` : "Home");
  frame(`feed|${title}`, `<div class="titlebar"><h1>${esc(title)}</h1>${community ? communityActions(community) : ""}</div>
    ${sortTabs()}<div id="feed"><p class="empty">Reading from ${esc(nodeHost())}…</p></div>`);
  if (community && $("#join")) $("#join").textContent = joinedList().includes(community) ? "Leave" : "Join";
  const results = await Promise.all(list.map((c) => loadPosts(c).then((posts) => ({ c, posts }), (error) => ({ c, error }))));
  const posts = results.flatMap((r) => r.posts ?? []);
  const labellers = list.flatMap((c) => follows(c));
  await loadNames([...posts.map((p) => p.author), ...labellers]).catch(() => {});
  if (stale(id)) return;
  // A refresh keeps rows where the reader last saw them (a post never moves
  // under the pointer after a vote); a new sort or view ranks afresh.
  const order = shown?.view === "feed" && shown.title === title && shown.sort === sort ? shown.order : null;
  shown = { view: "feed", title, list, community, posts, failures: results.filter((r) => r.error), order, sort };
  if (shown.failures.length) announce(shown.failures.map((f) => readFailure(f.error, f.c)).join(" "), { once: true });
  redraw();
}

function drawFeed() {
  if (!$("#feed")) return;
  const { list, community, posts, failures } = shown;
  const read = new Set(posts.map((q) => keyOf(q.community, q.author, q.id)));
  for (const p of pendingItems.values()) if (p.kind === "post" && read.has(p.key)) pendingItems.delete(p.key);
  const pending = [...pendingItems.values()].filter((p) => p.kind === "post" && list.includes(p.community))
    .map((p) => ({ ...p.value, tags: p.value.tags ?? [], media: p.media ?? [], author: p.author, id: p.id, community: p.community, ups: 0, downs: 0, mine: 0, comments: 0, verdict: { treatment: "show", labels: [] }, pending: p.slow ? "slow" : "waiting" }));
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
      html += rows.map((p) => postRow(p, names, { inCommunity: Boolean(community) && community !== ALL })).join("");
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
    [tree, judgeItem] = await Promise.all([read.thread(state, author, id), judgeFor(state, community)]);
    const reader = signer()?.address;
    if (tree) {
      const withVotes = async (node) => {
        const v = await read.votes(state, node.author, node.id);
        Object.assign(node, { ups: v.ups, downs: v.downs, mine: reader ? v.voters.get(reader) ?? 0 : 0 });
        await Promise.all(node.replies.map(withVotes));
      };
      await withVotes(tree);
      const authors = [];
      const collect = (node) => { authors.push(node.author); node.replies.forEach(collect); };
      collect(tree);
      await loadNames([...authors, ...follows(community)]).catch(() => {});
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
  if (tree) pendingItems.delete(keyOf(community, author, id));
  const pendingPost = pendingItems.get(keyOf(community, author, id));
  if (!tree && pendingPost) tree = { ...pendingPost.value, author, id, tags: pendingPost.value.tags ?? [], labels: [], media: pendingPost.media ?? [], replies: [], ups: 0, downs: 0, mine: 0, pending: pendingPost.slow ? "slow" : "waiting" };
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
    if (byKey.has(`${p.author}/${p.id}`)) {
      pendingItems.delete(p.key);
      continue;
    }
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
    n.expanded = expanded.has(`${node.author}/${node.id}`);
    n.replies = node.replies.map(voted);
    return n;
  };
  tree = voted(tree);
  let count = 0;
  const counting = (node) => node.replies.forEach((r) => { count++; counting(r); });
  counting(tree);
  const link = safeLink(tree.link);
  $("#thread").innerHTML = `<article class="op${tree.pending ? " pending" : ""}">
      <div class="meta"><a href="#/s/${encodeURIComponent(community)}">s/${esc(community)}</a>${byline(author, names)}${tree.pending ? pendingNote(tree.pending) : when(tree.time)}${tree.tags.map((t) => `<span class="tag">${esc(t.toUpperCase())}</span>`).join("")}</div>
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

// A profile page: how an account appears, what it wrote in each community,
// and its karma. Read from every community chain (one prefix scan each).
let profileTab = "posts";

async function showProfile({ address }, renderId) {
  const fresh = frame(`profile|${address}`, `<a class="back" href="#/">← Home</a><div id="profile"><p class="empty">Reading from ${esc(nodeHost())}…</p></div>`);
  if (fresh) profileTab = "posts";
  const reader = signer()?.address;
  const [, results] = await Promise.all([
    loadNames([address]).catch(() => {}),
    Promise.all(communities.map(async (c) => {
      try {
        const state = await stateOf(chainOf(c));
        const [items, judgeItem] = await Promise.all([read.itemsBy(state, address), judgeFor(state, c)]);
        return {
          c,
          items: await Promise.all(items.map(async (item) => {
            const votes = await read.votes(state, item.author, item.id);
            let comments = 0, on;
            if (item.on) on = await read.item(state, item.on.author, item.on.id);
            else for await (const _ of state.list(`index/comment/${item.author}/${item.id}/`)) comments++;
            return { ...item, community: c, ups: votes.ups, downs: votes.downs, mine: reader ? votes.voters.get(reader) ?? 0 : 0, comments, verdict: judgeItem(item), onTitle: on?.title };
          })),
        };
      } catch (error) {
        return { c, error };
      }
    })),
  ]);
  if (stale(renderId)) return;
  const items = results.flatMap((r) => r.items ?? []);
  shown = { view: "profile", address, items, failures: results.filter((r) => r.error) };
  redraw();
}

function drawProfile() {
  if (!$("#profile")) return;
  const { address, items, failures } = shown;
  const mine = signer()?.address === address;
  const profile = profiles.get(address) ?? {};
  const handle = handles.get(address);
  const name = monikerNames.displayName(profile.name)?.slice(0, read.PROFILE_LIMITS.name);
  setTitle(name || (handle ? `@${handle}` : short(address)));
  // The reader's own posts not yet in a block are shown here too.
  const pending = mine ? [...pendingItems.values()].filter((p) => p.kind === "post" && p.author === address && !items.some((i) => i.community === p.community && i.id === p.id)) : [];
  const posts = items.filter((i) => i.title !== undefined && !i.on);
  const comments = items.filter((i) => i.on);
  const karma = items.reduce((total, i) => total + i.ups - i.downs, 0);
  const handleLine = handle
    ? `<a class="handle" href="${esc(`${MONIKER.app}#/@${handle}`)}" target="_blank" rel="noopener" title="This handle points at this account on Moniker">@${esc(handle)}</a>`
    : `<span class="muted">${mine ? "No @handle yet" : "No @handle"}</span>`;
  const link = safeLink(profile.link);
  const list = profileTab === "posts"
    ? [...pending.map((p) => ({ ...p.value, tags: p.value.tags ?? [], media: p.media ?? [], author: p.author, id: p.id, community: p.community, ups: 0, downs: 0, mine: 0, comments: 0, verdict: { treatment: "show", labels: [] }, pending: p.slow ? "slow" : "waiting" })),
      ...rank(posts, "new").map((p) => withVote(p, p.community))].map((p) => postRow(p, names)).join("")
    : rank(comments, "new").map((c) => commentRow(withVote(c, c.community))).join("");
  const empty = profileTab === "posts"
    ? `<p class="empty">${mine ? "You haven't posted yet." : "No posts yet."}</p>`
    : `<p class="empty">${mine ? "You haven't commented yet." : "No comments yet."}</p>`;
  $("#profile").innerHTML = `<section class="profile-head">
      <span class="avatar big" aria-hidden="true">${accountIcon(address, 64)}</span>
      <div class="who-lines">
        <h1>${esc(name || (handle ? `@${handle}` : short(address)))}</h1>
        <p class="handle-line">${handleLine}</p>
        <p class="id-line">${name || handle ? `<span class="mono muted" title="${esc(address)}">${esc(short(address))}</span> ` : ""}<button class="linkish" type="button" data-copy-id="${esc(address)}">Copy account ID</button></p>
      </div>
      ${mine ? '<button class="btn" type="button" data-edit-profile>Edit profile</button>' : ""}
    </section>
    ${profile.bio ? `<p class="bio">${esc(profile.bio)}</p>` : mine && !profile.name ? '<p class="bio muted">Add a name and a few words about yourself, so people know who\'s posting.</p>' : ""}
    ${link ? `<a class="link" href="${esc(link)}" target="_blank" rel="noopener noreferrer nofollow">${esc(link)} ↗</a>` : ""}
    <dl class="stats"><div><dt>Karma</dt><dd>${karma}</dd></div><div><dt>Posts</dt><dd>${posts.length}</dd></div><div><dt>Comments</dt><dd>${comments.length}</dd></div></dl>
    ${failures.length ? `<div class="panel bad"><p style="margin:0">${failures.map((f) => esc(readFailure(f.error, f.c))).join(" ")} What they wrote there is missing below.</p></div>` : ""}
    <div class="tabs" role="group" aria-label="Show"><button type="button" class="tab" data-profile-tab="posts" aria-pressed="${profileTab === "posts"}">Posts</button><button type="button" class="tab" data-profile-tab="comments" aria-pressed="${profileTab === "comments"}">Comments</button></div>
    <div id="profile-items">${list || empty}</div>`;
  loadMedia();
}

/** One of an account's comments, on its profile: where, on what, and what it said. */
function commentRow(c) {
  const href = postHref(c.community, c.on.author, c.on.id);
  const { treatment, labels } = c.verdict;
  const folded = treatment === "hide" || treatment === "collapse";
  return `<article class="mini">
    <div class="meta"><a href="#/s/${encodeURIComponent(c.community)}">s/${esc(c.community)}</a><span>on <a href="${href}">${esc(c.onTitle ?? "a post")}</a></span>${when(c.time)}${c.labels.map((l) => `<span class="tag label">${esc(l)}</span>`).join("")}</div>
    ${folded ? `<p class="muted" style="margin:2px 0">Labelled ${esc(labels.map((l) => l.label).join(", "))}. <a href="${href}">See it in the thread</a></p>` : `<div class="body">${esc((c.body ?? "").slice(0, 600))}</div>`}
    <div class="acts">${voteBox({ ...c, community: c.community }, { row: true })}<a href="${href}">Open thread</a></div>
    ${c.error ? `<p class="inline-error">${esc(c.error)}</p>` : ""}
  </article>`;
}

/**
 * A selector that finds the focused control again after a redraw replaces
 * it, or null. Writes land in the background, so redraws come at any time.
 */
function focusSelector(el = document.activeElement) {
  const found = focusIn(el);
  // Within the region it was in, so an aside button is not taken for its twin in the title bar.
  const region = el?.closest?.("#aside, #main, #who, nav.rail");
  return found && region ? `${region.id ? `#${region.id}` : "nav.rail"} ${found}` : found;
}
function focusIn(el) {
  if (!el || el === document.body || !$(".app").contains(el)) return null;
  const by = (attr) => `[${attr}="${CSS.escape(el.getAttribute(attr))}"]`;
  if (el.dataset.vote) return `${by("data-vote")}${by("data-target")}`;
  if (el.tagName === "SUMMARY") return "summary";
  for (const attr of ["data-reply", "data-label", "data-reveal", "data-follow", "data-sort", "data-mods", "data-join", "data-cid", "data-profile-tab", "data-edit-profile", "data-copy-id"]) {
    if (el.hasAttribute(attr)) return `${el.tagName.toLowerCase()}${by(attr)}`;
  }
  if (el.id) return `#${CSS.escape(el.id)}`;
  if (el.tagName === "A" && el.hasAttribute("href")) return `a${by("href")}`;
  return null;
}
// Only focus that a redraw dropped (to the body) is put back: the reader may
// have moved on while a background read ran.
const refocus = (selector) => {
  const lost = !document.activeElement || document.activeElement === document.body;
  if (selector && lost) document.querySelector(selector)?.focus({ preventScroll: true });
};

function redraw(again = focusSelector()) {
  if (shown?.view === "feed") drawFeed();
  else if (shown?.view === "post") drawThread();
  else if (shown?.view === "profile") drawProfile();
  refocus(again);
}

// Media read once per CID for the visit (content-addressed: it never
// changes), so a redraw puts it straight back instead of loading it again.
const media = new Map(); // cid → Promise<{ kind, url } | { unsupported } | null (not served)>
// Raster images and video only: an SVG is a document that can run script.
const MEDIA_TYPES = /^(image\/(png|jpeg|gif|webp|avif)|video\/(mp4|webm|ogg))$/;
function mediaFile(cid, community) {
  if (!media.has(cid)) {
    media.set(cid, (async () => {
      const volume = await nodes.read(chainOf(community), (node) =>
        new sdk.VolumeClient(new sdk.HTTPVolumeTransport(`${node.url}/volumes`, { chainPath: chainOf(community) })).get(cid));
      const file = sdk.decodeDagCbor(volume.bytes(cid));
      if (typeof file?.type !== "string" || !MEDIA_TYPES.test(file.type) || !(file.bytes instanceof Uint8Array) || file.bytes.length > 8 << 20) return { unsupported: true };
      return { kind: file.type.startsWith("video/") ? "video" : "img", url: URL.createObjectURL(new Blob([file.bytes], { type: file.type })) };
    })().catch(() => {
      // Not served now; asked again after a while, not on every redraw.
      unserved.add(cid);
      setTimeout(() => {
        media.delete(cid);
        unserved.delete(cid);
      }, 60_000);
      return null;
    }));
  }
  return media.get(cid);
}
const mediaTag = ({ kind, url }, cid, blur) => {
  const blurred = blur && !unblurred.has(cid);
  const attrs = `class="media${blurred ? " blur" : ""}" data-cid="${esc(cid)}" src="${url}"${blurred ? ' title="Tap to show" data-unblur tabindex="0" role="button" aria-label="Blurred: show it"' : ""}`;
  return kind === "video" ? `<video ${attrs} controls></video>` : `<img ${attrs} alt="">`;
};
const settled = new Map(); // cid → { kind, url } once read, for drawing without a wait
const unserved = new Set(); // CIDs no node served on the last try
const notServed = (slot) => {
  slot.textContent = "No one is serving this file right now.";
  slot.removeAttribute("data-media");
};
/** Fill media slots from any node that serves the Volume; checked by CID. */
async function loadMedia() {
  const slots = [...document.querySelectorAll("[data-media]")];
  // Already read: in place before the next paint.
  for (const slot of slots) {
    const file = settled.get(slot.dataset.media);
    if (file) slot.outerHTML = mediaTag(file, slot.dataset.media, slot.dataset.blur === "1");
    else if (unserved.has(slot.dataset.media)) notServed(slot);
  }
  // The rest are read side by side, each filled as it arrives.
  await Promise.all(slots.filter((s) => s.isConnected && s.dataset.media).map(async (slot) => {
    const cid = slot.dataset.media;
    const file = await mediaFile(cid, slot.dataset.chain);
    if (!slot.isConnected) return;
    if (file?.unsupported) {
      slot.textContent = "This file isn't an image or video this page shows.";
      slot.removeAttribute("data-media");
    } else if (file) {
      settled.set(cid, file);
      slot.outerHTML = mediaTag(file, cid, slot.dataset.blur === "1");
    } else {
      notServed(slot);
    }
  }));
}

/** For a reader without an account here: what taking part takes, which is nothing to install and no coins. */
const joinCard = () => signer() ? "" : `<div class="card"><h4>Take part</h4><p class="muted">Post, comment and vote for free. Selfhold makes your account with a passkey: nothing to install, no coins.</p><button class="btn primary" type="button" data-sign-in>Sign in</button></div>`;

function showAside() {
  const c = route.community;
  if (route.view === "profile") {
    $("#aside").innerHTML = `<div class="card"><h4>Profiles</h4><p class="muted">A name and a few words, kept on Stoa's chain and changed only by their owner. The @handle comes from Moniker, which every Lattice app shares: it shows only while the handle points at this account.</p></div>${joinCard()}`;
    return;
  }
  if (!c) {
    $("#aside").innerHTML = `<div class="card"><h4>Home</h4><p class="muted">Posts from the communities you joined, ranked on this page from votes and post times.</p><dl class="kv"><dt>Node</dt><dd>${esc(nodeHost())}</dd></dl></div>${joinCard()}`;
    return;
  }
  const n = follows(c).length;
  const detailsOpen = $("#aside details")?.open ? " open" : "";
  const about = c === ALL
    ? "Every community's posts, with posts of its own on the Stoa chain. Anyone can post here, and anyone can mine it."
    : "A community with a chain of its own. Anyone can post here, and anyone can mine it.";
  $("#aside").innerHTML = `<div class="card"><h4>s/${esc(c)}</h4><p class="muted">${about}</p>
    <dl class="kv"><dt>Labels</dt><dd>${n ? `you follow ${plural(n, "account")}` : "you follow no one"} · <button class="linkish" type="button" data-mods="${esc(c)}">Manage</button></dd></dl>
    <details class="more"${detailsOpen}><summary>Chain details</summary><dl class="kv"><dt>Chain</dt><dd class="mono">${pathHTML(chainOf(c))}</dd><dt>Height</dt><dd class="mono" id="aside-height">…</dd><dt>Node</dt><dd id="aside-node">${esc(nodeHost())}</dd></dl></details></div>${joinCard()}`;
  // Each read fills only the aside it was made for.
  const height = $("#aside-height"), node = $("#aside-node");
  nodes.list(chainOf(c)).then(([first]) => first && (node.textContent = first.found ? `${hostOf(first.url)}, found for this community: its operator declared it, and what it serves isn't checked` : hostOf(first.url)), () => {});
  api("/api/chain/info", chainOf(c)).then((i) => (height.textContent = i.height ?? "starting")).catch(() => (height.textContent = "not served by this node"));
}

// Renders overlap (a navigation while the last one still reads the node);
// only the newest one writes the page.
let renderId = 0;
// The home chain as the last render read it: profiles are read from it.
let homeState = null;
const stale = (id) => id !== renderId;

async function render() {
  const id = ++renderId;
  // The page acts on the route it shows: the new one takes over only when it
  // is drawn, not while its reads run under the old page.
  const next = parseRoute(location.hash);
  const home = await stateOf(homePath()).catch(() => null);
  homeState = home;
  if (home) {
    await loadMine(home).catch(() => {});
    const reader = signer();
    if (reader) await loadNames([reader.address]).catch(() => {});
  }
  if (stale(id)) return;
  route = next;
  // A navigation scrolls to the top as its view is drawn, not before.
  if (navigated) {
    navigated = false;
    window.scrollTo(0, 0);
  }
  const again = focusSelector();
  renderRail();
  renderWho();
  showAside();
  refocus(again);
  if (route.view === "post") await showPost(route, id);
  else if (route.view === "profile") await showProfile(route, id);
  else if (route.view === "community") await showFeed(route.community === ALL ? communities : [route.community], { title: `s/${route.community}`, community: route.community }, id);
  else await showFeed(joinedList().filter((c) => communities.includes(c)), { title: "Home" }, id);
  if (!stale(id)) refocus(again);
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
    expanded.add(el.dataset.expand);
    el.closest("p").nextElementSibling.hidden = false;
    el.closest("p").remove();
  } else if (el.hasAttribute("data-unblur")) {
    unblurred.add(el.dataset.cid);
    el.classList.remove("blur");
    for (const attr of ["data-unblur", "role", "aria-label", "title"]) el.removeAttribute(attr);
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
  } else if (el.hasAttribute("data-sign-in")) {
    needAccount();
  } else if (el.dataset.profileTab) {
    profileTab = el.dataset.profileTab;
    if (shown?.view === "profile") redraw();
  } else if (el.hasAttribute("data-edit-profile")) {
    openProfile();
  } else if (el.dataset.copyId) {
    copyText(el, el.dataset.copyId, "Copied");
  }
});

/** Copies `text`, saying so on `button` for a moment; where it can't, the text is shown to select. */
async function copyText(button, text, done = "Copied") {
  const was = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = done;
  } catch {
    button.textContent = text;
    return;
  }
  setTimeout(() => button.isConnected && (button.textContent = was), 2000);
}

function toggleJoin(c) {
  const joining = !joinedList().includes(c);
  const keep = () => {
    const list = joinedList();
    store.set("joined", joining ? [...new Set([...list, c])] : list.filter((x) => x !== c));
    store.set("left", joining ? store.get("left", []).filter((x) => x !== c) : [...new Set([...store.get("left", []), c])]);
  };
  const reader = signer();
  if (reader) saveChoice(write.join(reader.address, c, joining), keep, joining ? `that you joined s/${c}` : `that you left s/${c}`, { about: `joining s/${c}` });
  else keep();
  render();
}

// A write from a dialog: the dialog stays until the wallet has sent it, then
// closes, and the write is drawn in place as pending until its block lands.
/**
 * A write from a dialog. The dialog is held (Cancel and Escape too) from the
 * click until the wallet has sent, connecting first if need be; `build`
 * makes the write once the reader's address is known. A failure is said in
 * the dialog, or in a notice if it was closed anyway.
 */
async function sendFromDialog({ status, button, build, sent = () => {}, forget = () => {}, done, landed: afterLanding = () => {} }) {
  const dialog = button.closest("dialog");
  // This opening of the dialog: a later one (after Cancel) is not touched.
  const opening = dialog.dataset.opening;
  const same = () => dialog.open && dialog.dataset.opening === opening;
  // The write is built from the fields at the click: they lock with the
  // button, so no edit made meanwhile is silently left out.
  const busy = (on) => {
    dialog.toggleAttribute("data-busy", on);
    button.disabled = on;
    dialog.querySelectorAll("input, textarea, select").forEach((field) => (field.disabled = on));
  };
  // Held (Cancel and Escape too) only while the wallet is asked; until then
  // the reader may still cancel, and nothing is sent if they do.
  const held = (on) => {
    dialog.toggleAttribute("data-sending", on);
    dialog.querySelectorAll("[data-close]").forEach((b) => (b.disabled = on));
  };
  // Locking moved focus off the clicked control; it goes back when unlocked.
  const focused = document.activeElement;
  const release = () => {
    if (dialog.dataset.opening !== opening) return;
    busy(false);
    held(false);
    if (dialog.open && (!document.activeElement || document.activeElement === document.body)) focused?.focus();
  };
  busy(true);
  status.classList.remove("bad");
  let land, pending;
  try {
    // An account first, in this click, if there is none here yet.
    const reader = await me().catch((error) => {
      if (error instanceof JustConnected) throw error;
      throw new Said(walletMessage(error));
    });
    const made = build(reader.address);
    pending = made.pending;
    land = await send(made.chain, made.records, (s) => same() && (status.textContent = s), () => {
      if (!same()) return false;
      held(true);
      return true;
    }, made.fresh);
  } catch (error) {
    release();
    if (error instanceof Withdrawn) return;
    // The draft's id is taken by what landed: the next send gets a new one.
    if (error instanceof Landed) forget();
    if (!same()) {
      if (!(error instanceof JustConnected)) notice(said(error), { bad: true });
      return;
    }
    if (error instanceof JustConnected) {
      dialog.querySelector(".cost").textContent = signingNote();
      status.textContent = `You're signed in. Press ${button.textContent} to send it.`;
      button.focus();
      return;
    }
    status.classList.add("bad");
    status.textContent = said(error);
    return;
  }
  const owner = connected;
  const ours = same();
  release();
  if (owner !== pending.author) return;
  // Sent: its draft is spent whether or not the dialog is still showing.
  sent();
  if (ours) status.textContent = "";
  pendingItems.set(pending.key, pending);
  if (ours) done();
  else redraw();
  const landed = await land(() => {
    pending.slow = true;
    redraw();
  });
  if (connected !== owner) return;
  // Kept until a read contains it (the draws drop it then), so it never
  // vanishes between landing and the re-read.
  if (landed) {
    pending.landed = true;
    afterLanding(owner);
  }
  refresh();
}

const drafts = new Map();
// A draft keeps one record id until it is sent, so sending it again (after a
// wallet that went quiet, then signed the first) rewrites the same record
// instead of adding a second copy.
const draftIds = new Map(); // draft key → id
const draftId = (key) => {
  if (!draftIds.has(key)) draftIds.set(key, write.newId());
  return draftIds.get(key);
};
let replyTarget = null;
const KNOWN_LABELS = ["spam", "off-topic", "nsfw", "low-effort"];
function openReply(target, labelling) {
  const [author, id] = target.split("/");
  // What is answered is fixed now, whatever the route does while the dialog is open.
  opened($("#reply"));
  replyTarget = { author, id, labelling, key: `${labelling ? "label" : "reply"}:${target}`, community: route.community, post: { author: route.author, id: route.id } };
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
  $("#rp-cost").textContent = signingNote();
}
$("#rp-b").addEventListener("input", () => replyTarget && drafts.set(replyTarget.key, $("#rp-b").value));
$("#reply-form").addEventListener("submit", async (event) => {
  if (event.submitter?.value !== "send") return;
  event.preventDefault();
  const status = $("#rp-status");
  status.classList.add("bad");
  const { community, post: on, key: draftKey } = replyTarget;
  const { author: postAuthor, id: postId } = on;
  const target = replyTarget.author === postAuthor && replyTarget.id === postId ? undefined : { author: replyTarget.author, id: replyTarget.id };
  const typed = $("#rp-labels").value.split(",").map((l) => l.trim().toLowerCase()).filter(Boolean);
  const labels = replyTarget.labelling ? [...new Set([...[...document.querySelectorAll("#rp-chips input:checked")].map((i) => i.value), ...typed])] : [];
  const body = $("#rp-b").value.trim();
  if (replyTarget.labelling && labels.length === 0) return ($("#rp-status").textContent = "Choose at least one label.");
  if (!replyTarget.labelling && !body) return ($("#rp-status").textContent = "Write something first.");
  const labelling = replyTarget.labelling;
  const value = labelling ? { body, labels } : { body };
  await sendFromDialog({
    status, button: $("#rp-send"),
    build: (author) => {
      const newId = draftId(draftKey);
      return {
        chain: chainOf(community),
        records: labelling ? write.label(author, newId, on, labels, { target, body }) : write.comment(author, newId, on, { body }, target ? { parent: target } : {}),
        fresh: `user/${author}/post/${newId}`,
        pending: { key: keyOf(community, author, newId), kind: "comment", community, author, id: newId, value, on, parent: target },
      };
    },
    sent: () => {
      drafts.delete(draftKey);
      draftIds.delete(draftKey);
    },
    forget: () => draftIds.delete(draftKey),
    done: () => {
      $("#reply").close();
      redraw();
    },
  });
});

/** The line in a dialog that says how a write is signed and paid for: without coins, wherever a sponsor takes work. */
function signingNote() {
  if (!signer()) return "Free. You'll sign in with Selfhold first: a passkey makes your account, with nothing to install.";
  if (extension()) return "You'll approve it, and its fee, in Selfhold.";
  if (!settings.sponsor) return "You'll approve it, and its fee, in Selfhold's window.";
  return "Free: this device does a moment's work for the fee. You'll approve it in Selfhold's window.";
}

/** A new opening of a dialog: a send still running from an earlier one leaves it alone. */
function opened(dialog) {
  dialog.dataset.opening = String(Number(dialog.dataset.opening ?? 0) + 1);
  dialog.removeAttribute("data-busy");
  dialog.removeAttribute("data-sending");
  dialog.querySelectorAll("[data-close]").forEach((b) => (b.disabled = false));
  dialog.querySelector(".btn.primary").disabled = false;
  dialog.querySelectorAll("input, textarea, select").forEach((field) => (field.disabled = false));
}

function openNewPost() {
  // s/all is always one once read: none means they're still being read, or couldn't be.
  if (!communities.length) return notice("Stoa is still reading the communities from the node. Try again in a moment.");
  opened($("#new"));
  $("#np-status").textContent = "";
  $("#np-status").classList.remove("bad");
  if (route.community && communities.includes(route.community)) $("#np-c").value = route.community;
  $("#new").showModal();
  $("#np-t").focus();
  $("#np-cost").textContent = signingNote();
  drawAttachment();
  drawMediaPicker();
}
$("#open-new").onclick = openNewPost;
document.querySelectorAll("dialog").forEach((dialog) => {
  // Focus goes back to what opened the dialog, found again if a redraw
  // replaced it meanwhile (refocus acts only when focus fell to the page).
  const show = dialog.showModal.bind(dialog);
  dialog.showModal = () => {
    dialog.dataset.from = focusSelector() ?? "";
    show();
  };
  dialog.addEventListener("close", () => setTimeout(() => refocus(dialog.dataset.from || null), 0));
  dialog.addEventListener("cancel", (event) => {
    if (dialog.hasAttribute("data-sending")) event.preventDefault();
  });
  dialog.querySelectorAll("[data-close]").forEach((button) => (button.onclick = () => dialog.close("cancel")));
});
$("#np-c").addEventListener("change", drawMediaPicker);
$("#new-form").addEventListener("submit", async (event) => {
  if (event.submitter?.value !== "post") return;
  event.preventDefault();
  const status = $("#np-status");
  status.classList.add("bad");
  if (attachment && attachment.state !== "kept") {
    return (status.textContent = attachment.state === "failed" ? "Your file wasn't kept: try again, or remove it." : "Your file is still being kept. Post once it's ready.");
  }
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
  const value = { title, ...(link && { link }), ...($("#np-b").value.trim() && { body: $("#np-b").value.trim() }), ...(tags.length && { tags }) };
  let made;
  const media = attachment ? [attachment.cid] : [];
  await sendFromDialog({
    status, button: $("#np-post"),
    build: (author) => {
      const id = draftId(`new-post:${community}`);
      made = { author, id };
      return { chain: chainOf(community), records: write.post(author, id, value, media), fresh: `user/${author}/post/${id}`, pending: { key: keyOf(community, author, id), kind: "post", community, author, id, value, media } };
    },
    sent: () => {
      $("#new-form").reset();
      attachment = null;
      drawAttachment();
      draftIds.delete(`new-post:${community}`);
    },
    forget: () => draftIds.delete(`new-post:${community}`),
    done: () => {
      $("#new").close();
      location.hash = postHref(community, made.author, made.id);
    },
  });
});

function openMods(community) {
  const c = community ?? route.community ?? communities[0];
  if (!c) return;
  $("#mods-c").textContent = `s/${c}`;
  // Opening clears the status; a redraw of the open dialog keeps what it says.
  if (!$("#mods").open) $("#mods-status").textContent = "";
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
  $("#mods-status").textContent = "";
  // Kept in the box when the change has to wait, so it can be sent again.
  if (follow(c, address, true)) $("#mods-add").value = "";
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

// ---------------------------------------------------------------- profile

/** The reader's profile, to change: the @handle from Moniker, and the name, bio and link kept on Stoa. */
function openProfile() {
  const reader = signer();
  if (!reader) return needAccount("Your profile belongs to your account.");
  const dialog = $("#profile-dialog");
  opened(dialog);
  const profile = profiles.get(reader.address) ?? {};
  $("#pf-name").value = profile.name ?? "";
  $("#pf-bio").value = profile.bio ?? "";
  $("#pf-link").value = profile.link ?? "";
  $("#pf-status").textContent = "";
  $("#pf-status").classList.remove("bad");
  $("#pf-cost").textContent = signingNote();
  $("#pf-handle").value = "";
  handleCheck = null;
  $("#pf-handle-btn").textContent = "Use this handle";
  $("#pf-handle-status").textContent = "";
  $("#pf-handle-status").classList.remove("bad");
  // A claim still waiting for Moniker keeps its button, and says so.
  $("#pf-handle-btn").disabled = claiming === reader.address;
  if (claiming === reader.address) $("#pf-handle-status").textContent = "Your last handle is still on its way to Moniker…";
  drawHandleNow(reader.address);
  dialog.showModal();
  $("#pf-name").focus();
  // The names the account owns on Moniker, to pick from.
  $("#pf-handle-mine").innerHTML = "";
  moniker.state().then((state) => monikerNames.namesOf(state, reader.address)).then((owned) => {
    if (signer()?.address !== reader.address || !owned.length) return;
    const now = handles.get(reader.address);
    $("#pf-handle-mine").innerHTML = `Your names on Moniker: ${owned.map(({ handle }) => `<button class="chip" type="button" data-pick-handle="${esc(handle)}"${handle === now ? ' aria-current="true"' : ""}>@${esc(handle)}</button>`).join(" ")}`;
  }, () => {});
}

function drawHandleNow(address) {
  const now = handles.get(address);
  $("#pf-handle-now").innerHTML = now
    ? `You show <strong>@${esc(now)}</strong> in every Lattice app. Choose another below, or claim a free one.`
    : "You have no @handle yet. Claim a free one: it's yours, and every Lattice app shows it.";
}

$("#pf-handle-mine").addEventListener("click", (event) => {
  const pick = event.target.closest("[data-pick-handle]");
  if (!pick) return;
  $("#pf-handle").value = pick.dataset.pickHandle;
  $("#pf-handle").focus();
  checkHandle();
});

/** The typed handle, as Moniker keeps names, or "" for none; `bad` says why it can't be one. */
function typedHandle() {
  const handle = $("#pf-handle").value.trim().replace(/^@/, "").toLowerCase();
  return { handle, bad: handle && !/^[a-z0-9_]+$/.test(handle) ? "A handle is lowercase letters, digits and _." : null };
}

/**
 * What the typed handle would be for the reader, read from Moniker as they
 * type: free to claim, theirs to show, already shown, or someone else's.
 * The button says what it will do; a handle that can't be theirs is said at
 * once, and never opens Selfhold's window.
 */
let handleCheck = null; // { account, handle, step }, for the handle last read
let checkTimer = 0;
function checkHandle() {
  clearTimeout(checkTimer);
  const button = $("#pf-handle-btn");
  const status = $("#pf-handle-status");
  const say = (text, bad = false) => {
    status.textContent = text;
    status.classList.toggle("bad", bad);
  };
  if (claiming === connected) return;
  const { handle, bad } = typedHandle();
  handleCheck = null;
  button.textContent = handle && !bad ? `Use @${handle}` : "Use this handle";
  button.disabled = Boolean(bad);
  if (!handle) return say("");
  if (bad) return say(bad, true);
  say("");
  const account = connected;
  checkTimer = setTimeout(async () => {
    let step;
    try {
      const state = await moniker.state();
      const [entry, shownNow] = await Promise.all([monikerNames.resolve(state, handle), monikerNames.handleOf(state, account)]);
      step = stepFor(entry, account, handle, shownNow);
    } catch {
      return; // Unread: the button reads Moniker again when pressed.
    }
    if (typedHandle().handle !== handle || connected !== account || claiming === account) return;
    handleCheck = { account, handle, step };
    if (step.refused) {
      button.disabled = true;
      return say(step.refused, true);
    }
    button.disabled = step === "shown";
    button.textContent = step === "claim" ? `Claim @${handle}` : `Show @${handle}`;
    say(step === "claim" ? `@${handle} is free. It's yours once you claim it.` : step === "show" ? `@${handle} is yours: show it on your posts.` : `@${handle} is your handle already.`);
  }, 300);
}
$("#pf-handle").addEventListener("input", checkHandle);
$("#pf-handle").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    $("#pf-handle-btn").click();
  }
});

/**
 * Shows the typed @handle for the reader, through Moniker: a free one is
 * claimed, pointed at them and shown, in one transaction; one they own or
 * that points at them is shown. Selfhold's window opens at once, in the
 * click, while the page reads Moniker and builds the write.
 */
let claiming = null; // the account whose handle claim is waiting for Moniker
$("#pf-handle-btn").onclick = async () => {
  const status = $("#pf-handle-status");
  const button = $("#pf-handle-btn");
  const say = (text, bad = false) => {
    status.textContent = text;
    status.classList.toggle("bad", bad);
  };
  const { handle, bad } = typedHandle();
  if (!handle) return say("Type a handle first.", true);
  if (bad) return say(bad, true);
  const account = connected;
  if (!account) return needAccount();
  // Known already not to be theirs, or shown: no window to open.
  if (handleCheck?.account === account && handleCheck.handle === handle) {
    if (handleCheck.step.refused) return say(handleCheck.step.refused, true);
    if (handleCheck.step === "shown") return say(`@${handle} is your handle already.`);
  }
  clearTimeout(checkTimer);
  let refused = null;
  let step;
  const request = (async () => {
    const state = await moniker.state();
    const [entry, shownNow] = await Promise.all([monikerNames.resolve(state, handle), monikerNames.handleOf(state, account)]);
    step = stepFor(entry, account, handle, shownNow);
    if (step.refused) throw new Said(step.refused);
    if (step === "shown") return null;
    const made = step === "claim" ? await monikerNames.claim(state, account, handle, { show: true }) : await monikerNames.showName(state, account, handle);
    return writeRequest(moniker.chain, made);
  })().catch((error) => {
    refused = error;
    throw error;
  });
  button.disabled = true;
  say(`Approve it in ${walletName()}…`);
  let sent;
  try {
    sent = await monikerWallet().writeRecords(request, { account, progress: (text) => say(`${text}…`.replace(/[.…]+…$/, "…")) });
  } catch (error) {
    button.disabled = false;
    if (refused) return say(refused instanceof Said || !(refused instanceof TypeError) ? String(refused?.message ?? refused) : `Couldn't read Moniker: ${refused.message}`, true);
    return say(walletMessage(error), true);
  }
  if (sent === null) {
    button.disabled = false;
    return say(`@${handle} is your handle already.`);
  }
  say(`Sent. Moniker shows @${handle} for you in about 10 seconds.`);
  claiming = account;
  try {
    const started = Date.now();
    while (Date.now() - started < 10 * 60_000) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      if (connected !== account) return;
      const now = await moniker.handleOf(account).catch(() => undefined);
      if (now !== handle) continue;
      handles.set(account, handle);
      forgetName(account);
      setName(account);
      renderWho();
      redraw();
      if ($("#profile-dialog").open) {
        button.disabled = false;
        $("#pf-handle").value = "";
        button.textContent = "Use this handle";
        drawHandleNow(account);
        say(`@${handle} is your handle now.`);
      } else {
        notice(`@${handle} is your handle now.`);
      }
      return;
    }
    button.disabled = false;
    say(`@${handle} hasn't shown yet. It may still go through: look again in a minute.`, true);
  } finally {
    if (claiming === account) claiming = null;
  }
};

$("#profile-form").addEventListener("submit", async (event) => {
  if (event.submitter?.value !== "save") return;
  event.preventDefault();
  const status = $("#pf-status");
  const link = $("#pf-link").value.trim();
  if (link && !safeLink(link)) {
    status.classList.add("bad");
    $("#pf-link").focus();
    return (status.textContent = "The link must start with https:// or http://");
  }
  if (link.length > read.PROFILE_LIMITS.link) {
    status.classList.add("bad");
    $("#pf-link").focus();
    return (status.textContent = `The link is too long: ${read.PROFILE_LIMITS.link} characters at most.`);
  }
  // One change at a time: a second, made before the first lands, would be made against what it replaces.
  const inFlight = connected && pendingItems.get(`profile|${connected}`);
  if (inFlight && !inFlight.slow) {
    status.classList.add("bad");
    return (status.textContent = "Your last change is still landing. Try again in a few seconds.");
  }
  const value = { name: $("#pf-name").value, bio: $("#pf-bio").value, link };
  await sendFromDialog({
    status, button: $("#pf-save"),
    build: (author) => ({ chain: homePath(), records: write.profile(author, value), pending: { key: `profile|${author}`, kind: "profile", author } }),
    done: () => {
      const reader = signer().address;
      // Shown at once; read again from the chain once it lands.
      const kept = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
      if (Object.keys(kept).length) profiles.set(reader, kept);
      else profiles.delete(reader);
      setName(reader);
      $("#profile-dialog").close();
      renderWho();
      redraw();
    },
    landed: (author) => {
      pendingItems.delete(`profile|${author}`);
      forgetName(author);
    },
  });
});

// ------------------------------------------------------------------ media

// A post's image or video is kept for good by the storage sponsor, paid with
// this device's work: no coins, and no node of the poster's own.
const MOST_MEDIA = (1 << 20) - 256; // one Volume of at most 1 MiB, its block's framing included
const UPLOADS = /^(image\/(png|jpeg|gif|webp|avif)|video\/(mp4|webm))$/;
let attachment = null; // { cid, file: { kind, url }, state: "storing" | "kept" | "failed", stop, chain }
const storageChains = new Map(); // "<sponsor> <community>" → Promise<chain | null>
const storageOn = (community) => {
  if (!settings.storage) return Promise.resolve(null);
  const key = `${settings.storage} ${community}`;
  if (!storageChains.has(key)) {
    const asked = storageChain(settings.storage, [chainOf(community).join("/"), homePath().join("/")]);
    storageChains.set(key, asked);
    // A sponsor that didn't answer is asked again next time.
    asked.then((chain) => chain || storageChains.delete(key));
  }
  return storageChains.get(key);
};

/** Shows whether a file can be added, for the community chosen. */
async function drawMediaPicker() {
  const community = $("#np-c").value;
  const chain = await storageOn(community);
  if ($("#np-c").value !== community) return;
  $("#np-file-wrap").hidden = !chain && !attachment;
  $("#np-media-off").hidden = Boolean(chain || attachment);
  $("#np-media-off").textContent = settings.storage
    ? "Images and video can't be added right now: the storage sponsor in Settings isn't keeping files."
    : "Images and video need a storage sponsor, set in Settings.";
}

function drawAttachment() {
  const box = $("#np-media");
  box.hidden = !attachment;
  $("#np-file-btn").hidden = Boolean(attachment);
  if (!attachment) return;
  const { file, state, text } = attachment;
  box.querySelector(".preview").innerHTML = file.kind === "video" ? `<video src="${file.url}" muted></video>` : `<img src="${file.url}" alt="">`;
  const line = box.querySelector(".media-status");
  line.textContent = text;
  line.classList.toggle("bad", state === "failed");
  $("#np-media-retry").hidden = state !== "failed";
  $("#np-post").disabled = state === "storing" || $("#new").hasAttribute("data-busy");
}

/** Keeps the chosen file through the storage sponsor, saying how far along it is. */
async function keepAttachment() {
  const mine = attachment;
  const stop = new AbortController();
  Object.assign(mine, { state: "storing", stop: () => stop.abort(), text: "Getting ready…" });
  drawAttachment();
  const device = await workDevice();
  const say = (text, state = "storing") => {
    if (attachment !== mine) return;
    Object.assign(mine, { text, state });
    drawAttachment();
  };
  try {
    const chain = await storageOn($("#np-c").value);
    if (!chain) throw new StorageRefused("The storage sponsor isn't keeping files right now.");
    await storeFile(settings.storage, mine.volume, {
      chain, hash: hasher, signal: stop.signal,
      progress: ({ stage, done }) => say({
        upload: "Sending it to the storage sponsor…",
        work: `Keeping it for good: this device's ${device} is paying with work…`,
        busy: "The storage sponsor is busy: waiting a moment…",
        grind: `Keeping it for good: this device's ${device} is paying with work… ${Math.round((done ?? 0) * 100)}%`,
        pin: "Paid. The storage sponsor is keeping it…",
      }[stage]),
    });
    // Kept: shown at once in the post, without reading it back.
    settled.set(mine.cid, mine.file);
    say("Kept for good, paid with this device's work.", "kept");
  } catch (error) {
    if (error instanceof StorageStopped) return;
    say(error instanceof StorageRefused ? error.message : `Couldn't keep it: ${error?.message ?? error}`, "failed");
  }
}

$("#np-file").addEventListener("change", async () => {
  const chosen = $("#np-file").files?.[0];
  $("#np-file").value = "";
  if (!chosen) return;
  const status = $("#np-status");
  status.classList.add("bad");
  if (!UPLOADS.test(chosen.type)) return (status.textContent = "Choose a PNG, JPEG, GIF, WebP or AVIF image, or an MP4 or WebM video.");
  if (chosen.size > MOST_MEDIA) return (status.textContent = `That file is ${(chosen.size / 1048576).toFixed(1)} MB. Files up to 1 MB can be kept: try a smaller one.`);
  status.textContent = "";
  const bytes = new Uint8Array(await chosen.arrayBuffer());
  const volume = mediaVolume(sdk, chosen.type, bytes);
  attachment?.stop?.();
  attachment = { cid: volume.cid, volume, file: { kind: chosen.type.startsWith("video/") ? "video" : "img", url: URL.createObjectURL(chosen) } };
  keepAttachment();
});
$("#np-media-retry").onclick = () => attachment && keepAttachment();
$("#np-media-remove").onclick = () => {
  attachment?.stop?.();
  attachment = null;
  drawAttachment();
  $("#np-post").disabled = false;
  drawMediaPicker();
  $("#np-file").focus();
};

// ---------------------------------------------------------------- settings

function openSettings({ advanced = false } = {}) {
  $("#st-node").value = settings.node;
  $("#st-home").value = settings.home;
  $("#st-moniker").value = settings.moniker;
  $("#st-sponsor").value = settings.sponsor;
  $("#st-storage").value = settings.storage;
  $("#st-extension-row").hidden = !window.lattice?.isLatticeWallet;
  $("#st-extension").checked = settings.extension;
  $("#st-status").textContent = "";
  $("#st-advanced").open = advanced;
  renderAccount();
  $("#settings").showModal();
  if (advanced) $("#st-node").focus();
}
$("#open-settings").onclick = () => openSettings();
function renderAccount() {
  const reader = signer();
  $("#st-account-hint").textContent = reader
    ? extension() ? "Selfhold for Chrome keeps your key and asks you to approve each post, comment, vote and label."
      : "Your key is kept by your passkey, in Selfhold's window. It asks you to approve each post, comment, vote and label; Stoa never sees the key."
    : "Selfhold makes your account with a passkey: your face, fingerprint or screen lock. Nothing to install, and no coins.";
  $("#st-address-row").hidden = !reader;
  $("#st-icon").innerHTML = reader ? accountIcon(reader.address, 20) : "";
  $("#st-address").textContent = reader?.address ?? "";
  $("#st-connect").hidden = Boolean(reader);
  $("#st-disconnect").hidden = !reader;
}
$("#st-connect").onclick = () =>
  connectWallet().then(() => { renderAccount(); render(); }).catch((error) => ($("#st-status").textContent = walletMessage(error)));
async function disconnect() {
  await wallet().disconnect().catch(() => {});
  setConnected(null);
  renderAccount();
  render();
}
$("#st-disconnect").onclick = disconnect;
$("#settings-form").addEventListener("submit", async (event) => {
  if (event.submitter?.value !== "save") return;
  const typed = $("#st-node").value.trim();
  const node = typed && nodeAddress(typed);
  const bad = (field, message) => {
    event.preventDefault();
    $("#st-advanced").open = true;
    $("#st-status").classList.add("bad");
    $("#st-status").textContent = message;
    field.focus();
  };
  if (typed && !node) return bad($("#st-node"), "The node must be an https address, like https://node.example (http only for this computer).");
  const sponsor = $("#st-sponsor").value.trim(), storage = $("#st-storage").value.trim();
  if (sponsor && !sponsorAddress(sponsor)) return bad($("#st-sponsor"), "The fee sponsor must be an https address, or empty to pay fees in coins.");
  if (storage && !sponsorAddress(storage)) return bad($("#st-storage"), "The storage sponsor must be an https address, or empty for none.");
  // Selfhold for Chrome or the window: each keeps its own account.
  const useExtension = $("#st-extension").checked;
  if (useExtension !== settings.extension) {
    settings.extension = useExtension;
    store.set("wallet", useExtension ? "extension" : "web");
    setConnected(await wallet().address().catch(() => null));
    render();
  }
  settings.sponsor = sponsor && sponsorAddress(sponsor);
  settings.storage = storage && sponsorAddress(storage);
  store.set("sponsor", settings.sponsor === DEFAULT_SPONSOR ? null : settings.sponsor);
  store.set("storage", settings.storage === DEFAULT_SPONSOR ? null : settings.storage);
  const home = $("#st-home").value.trim(), monikerChain = $("#st-moniker").value.trim();
  const moved = (node && node !== settings.node) || (home && home !== settings.home) || (monikerChain && monikerChain !== settings.moniker);
  if (!moved) return;
  settings.node = node || settings.node;
  settings.home = home || settings.home;
  settings.moniker = monikerChain || settings.moniker;
  store.set("node", settings.node);
  store.set("home", settings.home);
  store.set("monikerChain", settings.moniker === MONIKER.chain.join("/") ? null : settings.moniker);
  // Names are read again, from the node and chains now chosen.
  names.clear();
  profiles.clear();
  handles.clear();
  lookups = new Map();
  nodes = findNodes();
  moniker = monikerFor();
  $("#main").dataset.view = "";
  boot();
});

// The account menu.
$("#account").addEventListener("toggle", (event) => {
  if (event.newState !== "open") return;
  const reader = signer();
  if (!reader) return $("#account").hidePopover();
  const handle = handles.get(reader.address);
  $("#acc-icon").innerHTML = accountIcon(reader.address, 40);
  $("#acc-name").textContent = monikerNames.displayName(profiles.get(reader.address)?.name) || (handle ? `@${handle}` : "Your account");
  $("#acc-handle").textContent = handle ? `@${handle}` : "No @handle yet";
  $("#acc-handle").hidden = Boolean(handle) && !profiles.get(reader.address)?.name;
  $("#acc-address").textContent = short(reader.address);
  $("#acc-address").title = reader.address;
  $("#acc-wallet").textContent = extension() ? "Kept in Selfhold for Chrome." : "Kept by your passkey, in Selfhold's window.";
  $("#acc-profile").href = profileHref(reader.address);
  $("#acc-copy").textContent = "Copy account ID";
});
$("#acc-profile").onclick = () => $("#account").hidePopover();
$("#acc-edit").onclick = () => {
  $("#account").hidePopover();
  openProfile();
  $("#profile-dialog").dataset.from = "#who #account-btn";
};
$("#acc-copy").onclick = () => copyText($("#acc-copy"), signer()?.address ?? "");
$("#acc-settings").onclick = () => {
  $("#account").hidePopover();
  openSettings();
  // Opened from the account menu: focus returns to its button.
  $("#settings").dataset.from = "#who #account-btn";
};
$("#acc-disconnect").onclick = () => {
  $("#account").hidePopover();
  disconnect();
};

// ------------------------------------------------------------------ boot

async function boot() {
  setConnected(await wallet().address().catch(() => null));
  try {
    const children = (await api("/api/chain/children", homePath())).directories ?? [];
    communities = [ALL, ...children.filter((c) => c !== ALL)];
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
let navigated = false;
// Blurred media is a button to the keyboard too.
document.addEventListener("keydown", (event) => {
  if ((event.key === "Enter" || event.key === " ") && event.target.hasAttribute?.("data-unblur")) {
    event.preventDefault();
    event.target.click();
  }
});
window.addEventListener("hashchange", () => {
  for (const [key, error] of itemErrors) if (error.untilNavigation) itemErrors.delete(key);
  navigated = true;
  render();
});
boot();
