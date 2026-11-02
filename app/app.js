// Stoa in the browser: reads every record from a node by CID, ranks and
// filters here, and asks Selfhold to sign each write: its window over the
// page, whose key a passkey keeps, or Selfhold for Chrome. A sponsor takes
// this device's work for each fee and each file kept, so taking part needs
// no coins. No server of its own.
import * as sdk from "./vendor/lattice-sdk.js";
import { rank } from "../client/rank.mjs";
import * as read from "../client/read.mjs";
import { memberVotes, seedsOf } from "../client/standing.mjs";
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
import { byline, collapsed, commentNode, esc, mediaSlot, nameOf, ordered, parseRoute, pathHTML, pendingNote, plural, postHref, postRow, profileHref, safeLink, short, voteBox, when } from "./lib.mjs";

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
  remove(key) {
    try {
      localStorage.removeItem(`stoa:${key}`);
    } catch {
      /* private window */
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
// Follows, the follow graph every app shares.
const DEFAULT_FOLLOWS = "Nexus/testnet/follows-ade46a";
const savedMoniker = store.get("monikerChain", null);
const savedSponsor = store.get("sponsor", null);
const settings = {
  // A node saved before addresses were checked, or since retired, falls back
  // to the default.
  node: nodeAddress(store.get("node", DEFAULT_NODE)) ?? DEFAULT_NODE,
  home: store.get("home", "Nexus/testnet/stoa-41d5ab"),
  // Kept only when the reader chose a chain other than the SDK's, so a
  // reader on the default follows it when an SDK release moves Moniker.
  moniker: savedMoniker && !RETIRED_MONIKER.test(savedMoniker) ? savedMoniker : MONIKER.chain.join("/"),
  // Kept only when the reader chose another, as the moniker chain is.
  follows: store.get("followsChain", null) ?? DEFAULT_FOLLOWS,
  // Kept only when the reader chose another (or none, ""), as the moniker chain is.
  // The sponsor pays fees and keeps files, each for this device's work.
  sponsor: typeof savedSponsor === "string" ? savedSponsor : DEFAULT_SPONSOR,
  // Selfhold for Chrome only where Settings choose it; else Selfhold's window.
  extension: store.get("wallet", "web") === "extension",
  walletPage: walletPageOf(store.get("walletPage", DEFAULT_WALLET_PAGE)),
};
const homePath = () => settings.home.split("/");
const followsPath = () => settings.follows.split("/");
// s/all: every community's posts at once. It is no chain of its own.
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
    followChoices.clear();
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
      down: "This device's work usually pays the fee, but the sponsor isn't answering right now. Try again in a few minutes.",
      dear: "This device can't do the fee's work in reasonable time right now. Try again in a few minutes.",
      most: "The sponsor pays only so much for one write, and this one costs more than that.",
    }[why] ?? (settings.sponsor ? "The sponsor couldn't pay this fee. Try again in a few minutes." : "No sponsor is set in Settings, so the fee is paid in coins.");
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
function readFailure(error, community, where = community ? `s/${community}` : "Stoa") {
  if (error instanceof sdk.ChainOfflineError) return `No node serves ${where} right now.`;
  if (error?.status === 404 || /HTTP 404/.test(error?.message ?? "")) return `${nodeHost()} doesn't serve ${where}.`;
  if (error instanceof TypeError) return `Couldn't reach ${nodeHost()}.`;
  return `Couldn't read ${where} from ${nodeHost()}: ${error?.message ?? error}`;
}

/**
 * A chain's state at the node's tip, read by CID from the node's Volumes.
 * `ahead`: a read of the first render takes the state boot read ahead for
 * it; a write always reads its own.
 */
async function stateOf(chain, { ahead = false } = {}) {
  const early = ahead && readsAhead.get(chain.join("/"));
  if (early && Date.now() - early.at < AHEAD_FOR) return early.state;
  return nodes.read(chain, async (node) => {
    const volumes = volumesOn(node.url, chain);
    const { hash, generalStateCID } = await tip(sdk, node.url, chain, volumes);
    return { chain, hash, volumes, ...view(volumeLoader(volumes, sdk.decodeDagCbor), generalStateCID) };
  });
}

// Volumes are read through a cache kept across visits (a Volume never
// changes once verified, so only what a new block changed is read again),
// and reads made together, as a walk reads a node's children, go as one
// request.
// One client per node and chain, so a node found without the many-Volumes
// route is read one Volume at a time from then on. Media is not kept across
// visits: large files would push out the state every visit reads, and a
// visit keeps what it showed.
const volumeCache = new sdk.IndexedDBVolumeCache();
const volumeClients = new Map(); // "url chain media?" → VolumeClient
function volumesOn(url, chain, { media = false } = {}) {
  const key = `${url} ${chain.join("/")}${media ? " media" : ""}`;
  if (!volumeClients.has(key)) {
    const http = new sdk.HTTPVolumeTransport(`${url}/volumes`, { chainPath: chain });
    volumeClients.set(key, new sdk.VolumeClient(new sdk.BatchingVolumeTransport(http), undefined, media ? {} : { cache: volumeCache }));
  }
  return volumeClients.get(key);
}

// States read at boot, beside the page's other first reads, for the render
// boot starts (within a few seconds); every other render reads afresh.
const AHEAD_FOR = 10_000;
const readsAhead = new Map(); // "A/B" → { at, state }
let aheadRender = 0; // the id of the render they are for
function readAhead(chain) {
  const key = chain.join("/");
  if (readsAhead.has(key)) return;
  const state = stateOf(chain);
  state.catch(() => readsAhead.get(key)?.state === state && readsAhead.delete(key));
  readsAhead.set(key, { at: Date.now(), state });
}

const communityOf = (chain) => (chain.length > homePath().length ? chain.slice(homePath().length).join("/") : ALL);

/**
 * Sign and send `records` on `chain`, as the connected account. Selfhold's
 * window opens at once, in the click, while the page reads the chain and
 * builds the write; Selfhold shows it, pays its fee (with this device's
 * work, through the sponsor) and sends it. Resolves once it is sent, with
 * a promise of its landing (true once every write reads back; `onSlow`
 * after a minute without it), or of true at once when nothing needed
 * changing. `status(text)` hears where it stands.
 *
 * `beforeWallet()` is asked first: false withdraws it, nothing sent.
 * `fresh`: the key of a draft's record, which this write may create (or
 * rewrite identically) but never change: if it holds something else, an
 * earlier send landed, and Landed is thrown rather than editing it.
 *
 * `records` may be a function of the state it is written against: then the
 * write rewrites the reader's own records (their votes), and it
 * is built only once the reader's last such write on this chain has landed
 * (waiting while the window says it is preparing), so no write undoes
 * another.
 */
async function send(chain, records, status = () => {}, beforeWallet = () => true, fresh) {
  const address = connected;
  if (!address) throw new Said("Connect Selfhold first.");
  if (!beforeWallet()) throw new Withdrawn();
  const community = communityOf(chain);
  // Our own refusal while building, said as is (the window closes, nothing sent).
  let refused = null;
  let sentActions = [];
  const ordered = typeof records === "function";
  // The last such write's landing, waited for a minute at most: one that
  // never lands must not hold every later one (the chain refuses a write
  // built on a state that has since changed, so none is lost unseen).
  const before = ordered ? Promise.race([ownWrites.get(chain.join("/")), new Promise((resolve) => setTimeout(resolve, 60_000))]) : undefined;
  let landingNow;
  const own = new Promise((resolve) => (landingNow = resolve));
  // The next waits for this one and for the one before it, so a write
  // withdrawn early never lets the next build on a state the one before
  // it is still changing.
  if (ordered) ownWrites.set(chain.join("/"), Promise.all([before, own]));
  const request = (async () => {
    await before;
    let state;
    try {
      state = await stateOf(chain);
    } catch (error) {
      throw new Said(readFailure(error, community, chain.join("/") === settings.follows ? "Follows" : undefined));
    }
    const built = ordered ? await records(state) : records;
    // A key already holding its new value is no change: nothing to sign for it.
    const actions = (await write.changes(state, built)).filter((a) => a.oldValue !== a.newValue);
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
    // Not sent: the next write need not wait for it.
    landingNow();
    if (refused) throw refused;
    if (error?.code === "AccountChanged" || error?.code === "NotConnected") {
      setConnected(await wallet().address().catch(() => null));
      render();
    }
    // Sent, though the node did not confirm it: it is on its way, and the
    // landing poll decides. Calling it a failure would invite a second copy.
    if (!/may still land/i.test(String(error?.message ?? error))) throw new Said(walletMessage(error));
  }
  if (sent === null) {
    landingNow();
    return () => Promise.resolve(true);
  }
  const landed = sentActions.map((a) => [a.key, a.newValue]);
  let slow = () => {};
  const done = landing(chain, landed, () => slow());
  // The next write waits for this one to land, or to stop waiting for it.
  done.then(landingNow, landingNow);
  return (onSlow = () => {}) => ((slow = onSlow), done);
}

// The landing of the reader's last write of their own records, by chain.
const ownWrites = new Map(); // "A/B" → promise

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
let mine = { joined: [], follows: new Set() };
const joinedList = () => {
  const local = store.get("joined", null);
  const left = store.get("left", []);
  const list = mine.joined.length ? [...new Set([...mine.joined, ...(local ?? [])])] : local ?? communities;
  return list.filter((c) => !left.includes(c));
};

/** Read the reader's joins from the home chain. */
async function loadMine(home) {
  const reader = signer();
  if (!reader) return (mine = { joined: [], follows: new Set() });
  const [joined, follows] = await Promise.all([read.joined(home, reader.address), followsReader()(reader.address)]);
  mine = { joined, follows: new Set(follows) };
}

// Follows and unfollows sent this visit, shown at once: account → true or false.
const followChoices = new Map();
const following = (address) => followChoices.get(address) ?? mine.follows.has(address);
/** The accounts the reader follows. */
const followed = () => new Set([...mine.follows, ...followChoices.keys()].filter(following));

/**
 * A reader choice: kept in the browser and shown at once, then written to
 * `chain`, the home chain unless said (it lands a block later). The notice
 * says where it stands; if the write fails the choice stays in this browser
 * and the notice says why, or, with `undo`, it is taken back.
 */
// Home-chain keys with a save in flight. A write is made against the state it
// read, so a second change to the same key waits for the first to land.
const savingKeys = new Set();
const saving = (records) => records.some(([key]) => savingKeys.has(key));

function saveChoice(records, keepLocally, what, { about = what, chain = homePath(), undo } = {}) {
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
  send(chain, records)
    .then((land) => {
      shown.update(`Saving ${what}: waiting for a block…`);
      return land(() => shown.update(`Saving ${what}: sent, not in a block yet. It may still land.`));
    })
    .then((landed) => (landed ? shown.close() : shown.update(`${Whats} was sent but hasn't landed yet. It may still land.`)))
    .catch((error) => {
      if (!undo) return shown.update(`${Whats} is kept in this browser only. ${said(error)}`, { bad: true });
      undo();
      shown.update(`${Whats} wasn't saved. ${said(error)}`, { bad: true });
    })
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
// Posts the reader chose to see though members downvoted them, for this visit.
const revealed = new Set();
// Collapsed comments the reader opened.
const expanded = new Set();

// ------------------------------------------------------------- standing

// Votes count from a community's members: the accounts its seeds' standing
// reaches, through upvotes and follows (docs/standing.md). Its seeds are the
// authors of its first posts, which nobody can claim later: a post's time is
// held to its block.

// The account showing each followed handle now, as every app reads it; a
// failed read is tried again next time.
const shownBy = new Map(); // handle → promise of an account or undefined
function accountShowing(handle) {
  if (!shownBy.has(handle)) {
    const found = (async () => {
      const account = await moniker.pointer(handle);
      return account && (await moniker.handleOf(account)) === handle ? account : undefined;
    })();
    shownBy.set(handle, found);
    found.catch(() => shownBy.delete(handle));
  }
  return shownBy.get(handle).catch(() => undefined);
}

/**
 * Whom accounts follow, from one read of Follows (for one standing
 * computation). A Follows the page can't read is no follows, not a failure:
 * votes still count from posts.
 */
function followsReader() {
  const follows = stateOf(followsPath());
  follows.catch(() => {});
  return async (a) => {
    try {
      const state = await follows;
      const prefix = `follows/${a}/`;
      const targets = [];
      for await (const [key] of state.list(prefix)) targets.push(key.slice(prefix.length));
      const accounts = await Promise.all(targets.map((target) => (target.startsWith("@") ? accountShowing(target.slice(1)) : target)));
      return accounts.filter(Boolean);
    } catch {
      return [];
    }
  };
}

// A community's members and their votes, once per state read.
const standings = new Map(); // "A/B hash" → promise of { members, votes }
function standingOf(state, posts) {
  const key = `${state.chain.join("/")} ${state.hash}`;
  if (!standings.has(key)) {
    // One state's at a time is plenty: the last few are kept for a quick back and forth.
    if (standings.size > 8) standings.delete(standings.keys().next().value);
    standings.set(key, (async () => memberVotes(state, seedsOf(posts ?? (await read.posts(state))), { followsOf: followsReader() }))());
    standings.get(key).catch(() => standings.delete(key));
  }
  return standings.get(key);
}

// Whether the reader is a member of a community, as its last read found:
// "<reader> <community>" → true or false.
const memberIn = new Map();

/** The aside's line on whether the reader's votes count in the community shown. */
function drawYou() {
  const line = $("#aside-you");
  const reader = signer()?.address;
  const key = `${reader} ${route.community}`;
  if (!line || !memberIn.has(key)) return;
  line.textContent = memberIn.get(key)
    ? "count: you're one of its members."
    : "are kept, and count once members upvote what you post here or follow you.";
}

/**
 * Votes on a community's items, as `(author, id) => { ups, downs, mine,
 * counted }`: members' votes, and the reader's own (`mine`), which count
 * (`counted`) once they are a member.
 */
async function votesFor(state, posts) {
  const reader = signer()?.address;
  const [{ members: counted, votes }, own] = await Promise.all([
    standingOf(state, posts),
    reader ? read.edgesOf(state, reader).then(read.edgeSets) : null,
  ]);
  if (reader) memberIn.set(`${reader} ${communityOf(state.chain)}`, counted.has(reader));
  return (author, id) => {
    const target = `${author}/${id}`;
    const v = votes.get(target);
    const mine = own?.up.has(target) ? 1 : own?.down.has(target) ? -1 : 0;
    return { ups: v?.ups ?? 0, downs: v?.downs ?? 0, mine, counted: reader !== undefined && counted.has(reader) };
  };
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
  // A vote moves the counts only when it counts: the reader is a member.
  const counts = item.counted ? 1 : 0;
  return {
    ...item, mine: now, error,
    ups: item.ups + counts * (-(was === 1) + (now === 1)), downs: item.downs + counts * (-(was === -1) + (now === -1)),
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
    const voter = signer().address;
    land = await send(chainOf(community), async (state) => write.vote(voter, await read.edgesOf(state, voter), author, id, direction));
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
const SORTS = ["hot", "new", "top"];
let sort = SORTS.includes(store.get("sort")) ? store.get("sort") : "hot";
// What the current view last read, so a vote or reveal redraws without re-reading.
let shown = null;

function renderRail() {
  const joined = joinedList();
  const link = (c) => `<li><a href="#/s/${encodeURIComponent(c)}" data-c="${esc(c)}">s/${esc(c)}</a></li>`;
  const mineList = communities.filter((c) => joined.includes(c));
  const others = communities.filter((c) => !joined.includes(c));
  $("#communities").innerHTML = !communities.length
    ? '<p class="muted" style="padding:5px 8px;margin:0">No communities yet.</p>'
    : `<ul class="tree">${link(ALL)}</ul>` + (mineList.length ? `<h3>Your communities</h3><ul class="tree">${mineList.map(link).join("")}</ul>` : "")
      + (others.length ? `<h3>${mineList.length ? "More communities" : "Communities"}</h3><ul class="tree">${others.map(link).join("")}</ul>` : "");
  document.querySelectorAll(".tree a").forEach((a) => {
    const on = a.dataset.nav ? a.dataset.nav === route.view : a.dataset.c === route.community;
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
  const state = await stateOf(chainOf(community), { ahead: true });
  const posts = await read.posts(state);
  const votesOf = await votesFor(state, posts);
  return Promise.all(
    posts.map(async (post) => {
      let comments = 0;
      for await (const _ of state.list(`index/comment/${post.author}/${post.id}/`)) comments++;
      return { ...post, community, ...votesOf(post.author, post.id), comments };
    }),
  );
}

const sortTabs = () => `<div class="tabs" role="group" aria-label="Sort posts">${SORTS.map((s) => `<button type="button" class="tab" data-sort="${s}" aria-pressed="${s === sort}">${s[0].toUpperCase() + s.slice(1)}</button>`).join("")}</div>`;

function communityActions(c) {
  if (c === ALL) return "";
  return `<button class="btn" type="button" id="join" data-join="${esc(c)}">${joinedList().includes(c) ? "Leave" : "Join"}</button>`;
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

const feedFrame = (title, community) => `<div class="titlebar"><h1>${esc(title)}</h1>${community ? communityActions(community) : ""}</div>
    ${sortTabs()}<div id="feed"><p class="empty">Reading from ${esc(nodeHost())}…</p></div>`;

// A feed as this browser last drew it, shown while the page reads it again:
// dimmed and inert, as nothing in it can be acted on until it is read. Kept
// per node, home chain, account, feed and sort; the last few drawn are kept.
const lastFeedKey = (title) => `last-feed:${settings.node}|${settings.home}|${connected ?? ""}|${title}|${sort}`;
const LAST_FEEDS_KEPT = 4;
const lastFeedsSaved = new Map(); // key → the HTML saved this visit
function saveLastFeed(title, html) {
  const key = lastFeedKey(title);
  if (lastFeedsSaved.get(key) === html) return;
  lastFeedsSaved.set(key, html);
  const kept = [key, ...store.get("last-feeds", []).filter((k) => k !== key)];
  for (const old of kept.splice(LAST_FEEDS_KEPT)) store.remove(old);
  store.set("last-feeds", kept);
  store.set(key, html);
}
function showLastFeed(title) {
  const html = store.get(lastFeedKey(title), null);
  const feed = $("#feed");
  if (!html || !feed) return;
  feed.innerHTML = html;
  feed.inert = true;
  feed.setAttribute("aria-busy", "true");
  feed.classList.add("earlier");
  document.querySelector("#main .tabs")?.toggleAttribute("hidden", feed.querySelectorAll(".post").length < 2);
}
/** At boot, before any read: the feed this route shows, as last drawn here. */
function paintLastFeed() {
  const next = parseRoute(location.hash);
  if (next.view !== "home" && next.view !== "community") return;
  const title = next.view === "home" ? "Home" : `s/${next.community}`;
  if (store.get(lastFeedKey(title), null) === null) return;
  setTitle(title);
  // Without Join, and its sort tabs inert: nothing acts until
  // the reader's own choices are read. The feed's own frame replaces it.
  frame(`early|${title}`, feedFrame(title));
  document.querySelector("#main .tabs").inert = true;
  showLastFeed(title);
}

/** The posts of `list`'s communities, or only those by `authors` (a Set) when given. */
async function showFeed(list, { title, community, authors }, id) {
  setTitle(title);
  if (frame(`feed|${title}`, feedFrame(title, community))) showLastFeed(title);
  if (community && $("#join")) $("#join").textContent = joinedList().includes(community) ? "Leave" : "Join";
  const results = await Promise.all(list.map((c) => loadPosts(c).then((posts) => ({ c, posts }), (error) => ({ c, error }))));
  const posts = results.flatMap((r) => r.posts ?? []).filter((p) => !authors || authors.has(p.author));
  await loadNames(posts.map((p) => p.author)).catch(() => {});
  if (stale(id)) return;
  // A refresh keeps rows where the reader last saw them (a post never moves
  // under the pointer after a vote); a new sort or view ranks afresh.
  const order = shown?.view === "feed" && shown.title === title && shown.sort === sort ? shown.order : null;
  shown = { view: "feed", title, list, community, authors, posts, failures: results.filter((r) => r.error), order, sort };
  if (shown.failures.length) announce(shown.failures.map((f) => readFailure(f.error, f.c)).join(" "), { once: true });
  redraw();
}

function drawFeed() {
  if (!$("#feed")) return;
  const { list, community, authors, posts, failures } = shown;
  const read = new Set(posts.map((q) => keyOf(q.community, q.author, q.id)));
  for (const p of pendingItems.values()) if (p.kind === "post" && read.has(p.key)) pendingItems.delete(p.key);
  const pending = [...pendingItems.values()].filter((p) => p.kind === "post" && list.includes(p.community) && (!authors || authors.has(p.author)))
    .map((p) => ({ ...p.value, media: p.media ?? [], author: p.author, id: p.id, community: p.community, ups: 0, downs: 0, mine: 0, comments: 0, pending: p.slow ? "slow" : "waiting" }));
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
  const rows = [...pending, ...[...fresh, ...kept].map((p) => ({ ...withVote(p, p.community), revealed: revealed.has(`${p.author}/${p.id}`) }))];
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
    } else if (authors) {
      html += authors.size
        ? `<div class="panel"><h2>Nothing yet from the people you follow</h2><p>Their posts in every community show here.</p></div>`
        : `<div class="panel"><h2>You don't follow anyone yet</h2><p>Open someone's name and press Follow: their posts in every community show here, and your follow counts toward their standing.</p></div>`;
    } else if (!list.length) {
      html += `<div class="panel"><h2>Your home feed is empty</h2><p>Join a community to see its posts here.</p><div class="row2">${communities.slice(0, 6).map((c) => `<a class="btn" href="#/s/${encodeURIComponent(c)}">s/${esc(c)}</a>`).join("")}</div></div>`;
    } else {
      html += `<div class="panel"><h2>No posts${community ? ` in s/${esc(community)}` : ""} yet</h2><p>Start the conversation.</p><div class="row2"><button class="btn primary" type="button" data-new-post>Write the first post</button></div></div>`;
    }
  }
  const feed = $("#feed");
  feed.innerHTML = html;
  feed.inert = false;
  feed.removeAttribute("aria-busy");
  feed.classList.remove("earlier");
  document.querySelector("#main .tabs")?.toggleAttribute("hidden", rows.length < 2);
  // Before media fills its slots: their files are read again on the next visit.
  // Not with this visit's own pending rows or posts the reader chose to see.
  const ownOnly = pending.length || rows.some((p) => revealed.has(`${p.author}/${p.id}`));
  if (rows.length && !failures.length && !ownOnly && html.length < 200_000) saveLastFeed(shown.title, html);
  loadMedia();
}

async function showPost({ community, author, id }, renderId) {
  const fresh = frame(`post|${community}|${author}|${id}`, `<a class="back" href="#/s/${encodeURIComponent(community)}">← s/${esc(community)}</a><div id="thread"><p class="empty">Reading from ${esc(nodeHost())}…</p></div>`);
  if (fresh) setTitle(`s/${community}`);
  let tree;
  try {
    const state = await stateOf(chainOf(community), { ahead: true });
    tree = await read.thread(state, author, id);
    if (tree) {
      const votesOf = await votesFor(state);
      const withVotes = (node) => {
        Object.assign(node, votesOf(node.author, node.id));
        node.replies.forEach(withVotes);
      };
      withVotes(tree);
      const authors = [];
      const collect = (node) => { authors.push(node.author); node.replies.forEach(collect); };
      collect(tree);
      await loadNames(authors).catch(() => {});
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
  shown = { view: "post", community, author, id, tree, commentRank };
  redraw();
}

/** The thread as last read, with the reader's pending comments and votes in place. */
function drawThread() {
  if (!$("#thread")) return;
  const { community, author, id } = shown;
  let tree = shown.tree && ordered(structuredClone(shown.tree));
  if (tree) pendingItems.delete(keyOf(community, author, id));
  const pendingPost = pendingItems.get(keyOf(community, author, id));
  if (!tree && pendingPost) tree = { ...pendingPost.value, author, id, media: pendingPost.media ?? [], replies: [], ups: 0, downs: 0, mine: 0, pending: pendingPost.slow ? "slow" : "waiting" };
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
    parent.replies.push({ author: p.author, id: p.id, body: p.value.body ?? "", replies: [], ups: 0, downs: 0, pending: p.slow ? "slow" : "waiting" });
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
      <div class="meta"><a href="#/s/${encodeURIComponent(community)}">s/${esc(community)}</a>${byline(author, names)}${tree.pending ? pendingNote(tree.pending) : when(tree.time)}</div>
      <h1>${esc(tree.title)}</h1>
      ${link ? `<a class="link" href="${esc(link)}" target="_blank" rel="noopener noreferrer nofollow">${esc(link)} ↗</a>` : ""}
      ${tree.media.map((cid) => mediaSlot(cid, community)).join("")}
      ${tree.body ? `<div class="body" style="margin-top:10px">${esc(tree.body)}</div>` : ""}
      ${tree.pending ? "" : `<div class="acts" style="margin-top:10px">${voteBox({ ...tree, community }, { row: true })}<button type="button" data-reply="${esc(author)}/${esc(id)}">Reply</button></div>`}
      ${tree.error ? `<p class="inline-error">${esc(tree.error)}</p>` : ""}
    </article>
    <section class="comments" aria-label="Comments">
      ${count ? `<p class="comments-head">${plural(count, "comment")}</p>${tree.replies.map((c) => commentNode(c, community, names)).join("")}`
        : tree.pending ? "" : `<p class="empty">No comments yet. <button class="linkish" type="button" data-reply="${esc(author)}/${esc(id)}">Write the first one</button></p>`}
    </section>`;
  loadMedia();
}

// A profile page: how an account appears, what it wrote in each community,
// Read from every community chain (one prefix scan each).
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
        const [items, votesOf] = await Promise.all([read.itemsBy(state, address), votesFor(state)]);
        return {
          c,
          items: await Promise.all(items.map(async (item) => {
            let comments = 0, on;
            if (item.on) on = await read.item(state, item.on.author, item.on.id);
            else for await (const _ of state.list(`index/comment/${item.author}/${item.id}/`)) comments++;
            return { ...item, community: c, ...votesOf(item.author, item.id), comments, onTitle: on?.title };
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
  const handleLine = handle
    ? `<a class="handle" href="${esc(`${MONIKER.app}#/@${handle}`)}" target="_blank" rel="noopener" title="This handle points at this account on Moniker">@${esc(handle)}</a>`
    : `<span class="muted">${mine ? "No @handle yet" : "No @handle"}</span>`;
  const link = safeLink(profile.link);
  const list = profileTab === "posts"
    ? [...pending.map((p) => ({ ...p.value, media: p.media ?? [], author: p.author, id: p.id, community: p.community, ups: 0, downs: 0, mine: 0, comments: 0, pending: p.slow ? "slow" : "waiting" })),
      ...rank(posts, "new").map((p) => ({ ...withVote(p, p.community), revealed: revealed.has(`${p.author}/${p.id}`) }))].map((p) => postRow(p, names)).join("")
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
      ${mine ? '<button class="btn" type="button" data-edit-profile>Edit profile</button>' : followButton(address)}
    </section>
    ${profile.bio ? `<p class="bio">${esc(profile.bio)}</p>` : mine && !profile.name ? '<p class="bio muted">Add a name and a few words about yourself, so people know who\'s posting.</p>' : ""}
    ${link ? `<a class="link" href="${esc(link)}" target="_blank" rel="noopener noreferrer nofollow">${esc(link)} ↗</a>` : ""}
    <dl class="stats"><div><dt>Posts</dt><dd>${posts.length}</dd></div><div><dt>Comments</dt><dd>${comments.length}</dd></div></dl>
    ${failures.length ? `<div class="panel bad"><p style="margin:0">${failures.map((f) => esc(readFailure(f.error, f.c))).join(" ")} What they wrote there is missing below.</p></div>` : ""}
    <div class="tabs" role="group" aria-label="Show"><button type="button" class="tab" data-profile-tab="posts" aria-pressed="${profileTab === "posts"}">Posts</button><button type="button" class="tab" data-profile-tab="comments" aria-pressed="${profileTab === "comments"}">Comments</button></div>
    <div id="profile-items">${list || empty}</div>`;
  loadMedia();
}

const followButton = (address) => following(address)
  ? `<button class="btn" type="button" data-follow="${esc(address)}" aria-pressed="true">Following</button>`
  : `<button class="btn primary" type="button" data-follow="${esc(address)}" aria-pressed="false">Follow</button>`;

/** One of an account's comments, on its profile: where, on what, and what it said. */
function commentRow(c) {
  const href = postHref(c.community, c.on.author, c.on.id);
  return `<article class="mini">
    <div class="meta"><a href="#/s/${encodeURIComponent(c.community)}">s/${esc(c.community)}</a><span>on <a href="${href}">${esc(c.onTitle ?? "a post")}</a></span>${when(c.time)}</div>
    ${collapsed(c) ? `<p class="muted" style="margin:2px 0">More members downvoted it than upvoted it. <a href="${href}">See it in the thread</a></p>` : `<div class="body">${esc((c.body ?? "").slice(0, 600))}</div>`}
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
  for (const attr of ["data-reply", "data-reveal", "data-sort", "data-join", "data-cid", "data-profile-tab", "data-edit-profile", "data-follow", "data-copy-id"]) {
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
  drawYou();
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
      const volume = await nodes.read(chainOf(community), (node) => volumesOn(node.url, chainOf(community), { media: true }).get(cid));
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
const mediaTag = ({ kind, url }, cid) => {
  const attrs = `class="media" data-cid="${esc(cid)}" src="${url}"`;
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
    if (file) slot.outerHTML = mediaTag(file, slot.dataset.media);
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
      slot.outerHTML = mediaTag(file, cid);
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
    $("#aside").innerHTML = `<div class="card"><h4>Profiles</h4><p class="muted">A name and a few words, kept on Stoa's chain and changed only by their owner. The @handle comes from Moniker, which every Lattice app shares: it shows only while the handle points at this account.</p>
      <dl class="kv"><dt>Follows</dt><dd>are kept on Follows, which every Lattice app shares. A follow vouches for someone: once members of a community follow an account, its votes there count.</dd></dl></div>${joinCard()}`;
    return;
  }
  if (route.view === "following") {
    $("#aside").innerHTML = `<div class="card"><h4>Following</h4><p class="muted">Posts by the people you follow, from every community. Your follows are kept on Follows, which every Lattice app shares.</p></div>${joinCard()}`;
    return;
  }
  if (!c) {
    $("#aside").innerHTML = `<div class="card"><h4>Home</h4><p class="muted">Posts from the communities you joined, ranked on this page from votes and post times.</p><dl class="kv"><dt>Node</dt><dd>${esc(nodeHost())}</dd></dl></div>${joinCard()}`;
    return;
  }
  const detailsOpen = $("#aside details")?.open ? " open" : "";
  if (c === ALL) {
    $("#aside").innerHTML = `<div class="card"><h4>s/all</h4><p class="muted">Every community's posts at once, each ranked by its own members' votes.</p><dl class="kv"><dt>Node</dt><dd>${esc(nodeHost())}</dd></dl></div>${joinCard()}`;
    return;
  }
  const about = "A community with a chain of its own. Anyone can post here, and anyone can mine it.";
  $("#aside").innerHTML = `<div class="card"><h4>s/${esc(c)}</h4><p class="muted">${about}</p>
    <dl class="kv"><dt>Votes</dt><dd>count from its members: the accounts its first posters' upvotes and follows reach. What members downvote more than upvote is collapsed.</dd>${signer() ? '<dt>Your votes</dt><dd id="aside-you">…</dd>' : ""}</dl>
    <details class="more"${detailsOpen}><summary>Chain details</summary><dl class="kv"><dt>Chain</dt><dd class="mono">${pathHTML(chainOf(c))}</dd><dt>Height</dt><dd class="mono" id="aside-height">…</dd><dt>Node</dt><dd id="aside-node">${esc(nodeHost())}</dd></dl></details></div>${joinCard()}`;
  drawYou();
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
  // Any other render reads afresh: what boot read ahead may still be held up.
  if (id !== aheadRender) readsAhead.clear();
  // The page acts on the route it shows: the new one takes over only when it
  // is drawn, not while its reads run under the old page.
  const next = parseRoute(location.hash);
  const home = await stateOf(homePath(), { ahead: true }).catch(() => null);
  homeState = home;
  if (home) {
    const reader = signer();
    await Promise.all([loadMine(home).catch(() => {}), reader && loadNames([reader.address]).catch(() => {})]);
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
  else if (route.view === "following") await showFeed(communities, { title: "Following", authors: followed() }, id);
  else if (route.view === "community") await showFeed(route.community === ALL ? communities : [route.community], { title: `s/${route.community}`, community: route.community }, id);
  else await showFeed(joinedList().filter((c) => communities.includes(c)), { title: "Home" }, id);
  readsAhead.clear();
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
  } else if (el.dataset.vote) {
    castVote(el);
  } else if (el.dataset.reply) {
    openReply(el.dataset.reply);
  } else if (el.dataset.join) {
    toggleJoin(el.dataset.join);
  } else if (el.dataset.follow) {
    toggleFollow(el.dataset.follow);
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

/**
 * Follow `address`, or stop, on Follows, which every app reads. A follow
 * vouches for them: members' follows make an account a member, so its votes
 * count. Following someone who shows a handle follows the handle, as Follows
 * does; stopping deletes both.
 */
function toggleFollow(address) {
  const reader = signer();
  if (!reader) return needAccount("Follows are signed by your account, so every app can read them.");
  if (reader.address === address) return;
  const on = !following(address);
  const handle = handles.get(address);
  const records = on
    ? write.follow(reader.address, handle ? `@${handle}` : address)
    : [...write.follow(reader.address, address, false), ...(handle ? write.follow(reader.address, `@${handle}`, false) : [])];
  const before = followChoices.get(address);
  const put = (value) => {
    if (value === undefined) followChoices.delete(address);
    else followChoices.set(address, value);
    redraw();
  };
  saveChoice(records, () => put(on), on ? "your follow" : "your unfollow", { about: "this follow", chain: followsPath(), undo: () => put(before) });
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
function openReply(target) {
  const [author, id] = target.split("/");
  // What is answered is fixed now, whatever the route does while the dialog is open.
  opened($("#reply"));
  replyTarget = { author, id, key: `reply:${target}`, community: route.community, post: { author: route.author, id: route.id } };
  const onPost = route.author === author && route.id === id;
  const findNode = (node) => (node.author === author && node.id === id ? node : node.replies.map(findNode).find(Boolean));
  const node = shown?.tree && findNode(shown.tree);
  const quoted = node ? (onPost ? node.title : node.body) : "";
  $("#reply-title").textContent = `Reply to ${nameOf(author, names)}`;
  $("#rp-quote").innerHTML = `<strong>${esc(nameOf(author, names))}</strong>: ${esc((quoted ?? "").slice(0, 400))}`;
  $("#rp-b").value = drafts.get(replyTarget.key) ?? "";
  $("#rp-status").textContent = "";
  $("#reply").showModal();
  $("#rp-b").focus();
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
  const body = $("#rp-b").value.trim();
  if (!body) return ($("#rp-status").textContent = "Write something first.");
  const value = { body };
  await sendFromDialog({
    status, button: $("#rp-send"),
    build: (author) => {
      const newId = draftId(draftKey);
      return {
        chain: chainOf(community),
        records: write.comment(author, newId, on, { body }, target ? { parent: target } : {}),
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
  const value = { title, ...(link && { link }), ...($("#np-b").value.trim() && { body: $("#np-b").value.trim() }) };
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

// A post's image or video is kept for good by the sponsor, paid with
// this device's work: no coins, and no node of the poster's own.
const MOST_MEDIA = (1 << 20) - 256; // one Volume of at most 1 MiB, its block's framing included
const UPLOADS = /^(image\/(png|jpeg|gif|webp|avif)|video\/(mp4|webm))$/;
let attachment = null; // { cid, file: { kind, url }, state: "storing" | "kept" | "failed", stop, chain }
const storageChains = new Map(); // "<sponsor> <community>" → Promise<chain | null>
const storageOn = (community) => {
  if (!settings.sponsor) return Promise.resolve(null);
  const key = `${settings.sponsor} ${community}`;
  if (!storageChains.has(key)) {
    const asked = storageChain(settings.sponsor, [chainOf(community).join("/"), homePath().join("/")]);
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
  $("#np-media-off").textContent = settings.sponsor
    ? "Images and video can't be added right now: the sponsor in Settings isn't keeping files."
    : "Images and video need a sponsor, set in Settings.";
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

/** Keeps the chosen file through the sponsor, saying how far along it is. */
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
    if (!chain) throw new StorageRefused("The sponsor isn't keeping files right now.");
    await storeFile(settings.sponsor, mine.volume, {
      chain, hash: hasher, signal: stop.signal,
      progress: ({ stage, done }) => say({
        upload: "Sending it to the sponsor…",
        work: `Keeping it for good: this device's ${device} is paying with work…`,
        busy: "The sponsor is busy: waiting a moment…",
        grind: `Keeping it for good: this device's ${device} is paying with work… ${Math.round((done ?? 0) * 100)}%`,
        pin: "Paid. The sponsor is keeping it…",
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
  $("#st-follows").value = settings.follows;
  $("#st-sponsor").value = settings.sponsor;
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
    ? extension() ? "Selfhold for Chrome keeps your key and asks you to approve each post, comment and vote."
      : "Your key is kept by your passkey, in Selfhold's window. It asks you to approve each post, comment and vote; Stoa never sees the key."
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
  const sponsor = $("#st-sponsor").value.trim();
  if (sponsor && !sponsorAddress(sponsor)) return bad($("#st-sponsor"), "The sponsor must be an https address, or empty to pay fees in coins and add no files.");
  // Selfhold for Chrome or the window: each keeps its own account.
  const useExtension = $("#st-extension").checked;
  if (useExtension !== settings.extension) {
    settings.extension = useExtension;
    store.set("wallet", useExtension ? "extension" : "web");
    setConnected(await wallet().address().catch(() => null));
    render();
  }
  settings.sponsor = sponsor && sponsorAddress(sponsor);
  store.set("sponsor", settings.sponsor === DEFAULT_SPONSOR ? null : settings.sponsor);
  const home = $("#st-home").value.trim(), monikerChain = $("#st-moniker").value.trim(), followsChain = $("#st-follows").value.trim();
  const moved = (node && node !== settings.node) || (home && home !== settings.home) || (monikerChain && monikerChain !== settings.moniker) || (followsChain && followsChain !== settings.follows);
  if (!moved) return;
  settings.node = node || settings.node;
  settings.home = home || settings.home;
  settings.moniker = monikerChain || settings.moniker;
  settings.follows = followsChain || settings.follows;
  store.set("node", settings.node);
  store.set("home", settings.home);
  store.set("monikerChain", settings.moniker === MONIKER.chain.join("/") ? null : settings.moniker);
  store.set("followsChain", settings.follows === DEFAULT_FOLLOWS ? null : settings.follows);
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
  // The first reads side by side: the community list, the home chain's state
  // and, as soon as the list is in, the states of the chains this page shows.
  // A boot again (Try again, Settings) reads them anew.
  readsAhead.clear();
  aheadRender = renderId + 1;
  readAhead(homePath());
  const listed = api("/api/chain/children", homePath());
  listed.catch(() => {});
  setConnected(await wallet().address().catch(() => null));
  paintLastFeed();
  try {
    const children = (await listed).directories ?? [];
    // s/all is every community at once, not a chain: no child may take its name.
    communities = children.filter((c) => c !== ALL);
    for (const c of likelyShown()) readAhead(chainOf(c));
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
/** The communities this route most likely reads, before the reader's joins are read. */
function likelyShown() {
  const next = parseRoute(location.hash);
  if (next.view === "post" || next.view === "community") {
    if (next.community === ALL) return next.view === "post" ? [] : communities;
    return communities.includes(next.community) ? [next.community] : [];
  }
  if (next.view === "profile") return [];
  // A reader's joins are on the chain, not read yet: nothing to guess from.
  if (signer() && store.get("joined", null) === null) return [];
  return joinedList().filter((c) => communities.includes(c));
}
let navigated = false;
window.addEventListener("hashchange", () => {
  for (const [key, error] of itemErrors) if (error.untilNavigation) itemErrors.delete(key);
  navigated = true;
  render();
});
boot();
