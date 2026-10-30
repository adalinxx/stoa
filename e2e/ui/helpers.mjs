// What the UI tests do outside the page: read the stack, make and fund keys,
// and write records the way another client would.
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { operator } from "../../client/media.mjs";
import { tip, view, volumeLoader } from "../../client/state.mjs";
import * as write from "../../client/write.mjs";
import * as names from "../../app/vendor/moniker-sdk/src/records/names.mjs";
import { transaction as namesTransaction } from "../../app/vendor/moniker-sdk/src/records/wallet.mjs";
import { MONIKER } from "./stack.mjs";

export const sdk = await import(process.env.LATTICE_SDK);
export const stack = JSON.parse(readFileSync(fileURLToPath(new URL("./.stack.json", import.meta.url)), "utf8"));
export const homePath = stack.home.split("/");
export const chainPath = [...homePath, stack.community];

const hex = (bytes) => Buffer.from(bytes).toString("hex");

/** A new account: its address and private key (hex, as the page stores it). */
export function newAccount() {
  const key = sdk.generatePrivateKey();
  return { address: sdk.accountFromPrivateKey(key).address, keyHex: hex(key) };
}
export const minerAccount = { address: stack.miner, keyHex: stack.minerKey };
const accountOf = (who) => sdk.accountFromPrivateKey(Uint8Array.from(Buffer.from(who.keyHex, "hex")));

async function api(path, chain) {
  const r = await fetch(`${stack.node}${path}?chainPath=${chain.join("/")}`);
  return r.ok ? r.json() : undefined;
}
export const balance = async (address, chain) => BigInt((await api(`/api/state/account/${address}`, chain))?.balance ?? 0);

async function until(label, condition, seconds = 120) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    if (await condition().catch(() => false)) return;
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function sign(from, body) {
  const { publicKey, signature } = sdk.signTransactionBody(body, accountOf(from).privateKey);
  // The node may be busy (429), or its tip may move under the check (503
  // contextChanged): try again; once it was answered so, a later refusal may
  // be the first attempt having landed, and the caller waits for it either way.
  let moved = false;
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${stack.node}/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sdk.transactionPayload({ [publicKey]: signature }, body)),
    });
    if (r.ok) return;
    const text = await r.text();
    moved ||= /contextChanged/.test(text);
    if ((r.status === 429 || r.status === 503) && attempt < 30) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }
    if (moved) return;
    throw new Error(`submit: ${r.status} ${text}`);
  }
}

/** The miner sends `amount` to `to` on each chain, and it lands. */
export async function fund(to, amount = 100n, chains = [homePath, chainPath]) {
  for (const chain of chains) {
    const before = await balance(to, chain);
    const nonce = BigInt((await api(`/api/state/account/${stack.miner}`, chain))?.nonce ?? 0);
    await sign(minerAccount, sdk.buildTransfer({ from: stack.miner, to, amount, fee: 1n, nonce, chainPath: chain }));
    await until(`funds on ${chain.join("/")}`, async () => (await balance(to, chain)) >= before + amount);
  }
}

/** Write records on a chain as `who`, as another client would, and wait for them. */
export async function writeAs(who, chain, records) {
  const volumes = new sdk.VolumeClient(new sdk.HTTPVolumeTransport(`${stack.node}/volumes`, { chainPath: chain }));
  const state = async () => {
    const { generalStateCID } = await tip(sdk, stack.node, chain, volumes);
    return view(volumeLoader(volumes, sdk.decodeDagCbor), generalStateCID);
  };
  const actions = await write.changes(await state(), records);
  const nonce = BigInt((await api(`/api/state/account/${who.address}`, chain))?.nonce ?? 0);
  await sign(who, write.transaction({ owner: who.address, actions, fee: 1n, nonce, chainPath: chain }));
  await until("records land", async () => {
    const now = await state();
    for (const { key, newValue } of actions) if ((await now.get(key)) !== newValue) return false;
    return true;
  });
}

/** A chain's state at the node's tip, read and checked by CID. */
export async function stateOf(chain) {
  const volumes = new sdk.VolumeClient(new sdk.HTTPVolumeTransport(`${stack.node}/volumes`, { chainPath: chain }));
  const { generalStateCID } = await tip(sdk, stack.node, chain, volumes);
  return view(volumeLoader(volumes, sdk.decodeDagCbor), generalStateCID);
}

/** `who` claims `handle` on Moniker as another client would, and shows it. */
export async function claimAs(who, handle) {
  await fund(who.address, 20n, [MONIKER]);
  const made = await names.claim(await stateOf(MONIKER), who.address, handle, { show: true });
  const nonce = BigInt((await api(`/api/state/account/${who.address}`, MONIKER))?.nonce ?? 0);
  await sign(who, namesTransaction({ owner: who.address, ...made, fee: 1n, nonce, chainPath: MONIKER }));
  await until(`@${handle}`, async () => (await names.handleOf(await stateOf(MONIKER), who.address)) === handle);
}

/** The node's operator routes (pinning media), with its loopback cookie. */
export const nodeOperator = () => operator(stack.rpc, readFileSync(`${stack.root}/chains/Nexus/.cookie`, "utf8"));

// ------------------------------------------------- Selfhold's window, with a passkey

const REQUESTS = "stoa-test-selfhold"; // sessionStorage: the page's requests to Selfhold's window so far
export const walletOrigin = new URL(stack.walletPage).origin;


/**
 * Opens the app pointed at the stack, at `hash`: its wallet Selfhold's
 * window, served on localhost, with a platform passkey provider there.
 * Chromium's virtual authenticator belongs to one page, and a passkey made in
 * one window derives no key in another, so every window the page opens is
 * one window, kept open: each request navigates it, `?n=` counting them.
 * Each browser context is one person, with their own passkey.
 */
export async function openApp(page, hash = "#/", { settings = {} } = {}) {
  const context = page.context();
  if (!context.selfholdReady) {
    context.selfholdReady = true;
    await context.addInitScript((origin) => {
      if (location.origin === origin) window.close = () => {};
    }, walletOrigin);
    await context.addInitScript(({ key, seed }) => {
      if (location.port !== new URL(seed.app).port) return;
      const open = window.open.bind(window);
      window.open = (url, _name, features) => {
        const to = new URL(url);
        const n = Number(sessionStorage.getItem(key) ?? 0) + 1;
        sessionStorage.setItem(key, String(n));
        to.searchParams.set("n", String(n));
        return open(to.href, "selfhold-test", features);
      };
      if (localStorage.getItem("stoa:node")) return;
      for (const [name, value] of Object.entries(seed.values)) localStorage.setItem(`stoa:${name}`, JSON.stringify(value));
    }, { key: REQUESTS, seed: { app: stack.app, values: { node: stack.node, home: stack.home, monikerChain: stack.moniker, sponsor: stack.sponsor, storage: stack.sponsor, walletPage: stack.walletPage, ...settings } } });
    const arm = () => (context.selfhold = new Promise((resolve) => {
      const opened = async (popup) => {
        if (!(await popup.opener().catch(() => null))) return;
        context.off("page", opened);
        const cdp = await context.newCDPSession(popup);
        await cdp.send("WebAuthn.enable");
        await cdp.send("WebAuthn.addVirtualAuthenticator", {
          options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
        });
        // Closed by the page (a write with nothing to send, or one it couldn't build): the next request opens another.
        popup.on("close", () => arm());
        resolve(popup);
      };
      context.on("page", opened);
    }));
    arm();
  }
  await page.goto(stack.app + hash);
  // Read the communities, as a person would wait to see them, before anything is pressed.
  await page.locator("#communities").getByText(`s/${stack.community}`).waitFor({ timeout: 60_000 });
}

/**
 * With SHOTS set (a directory), a screenshot of `page` named `name`, for
 * reviewing what each step looks like; without it, nothing.
 */
let shots = 0;
export async function shot(page, name) {
  if (!process.env.SHOTS) return;
  mkdirSync(process.env.SHOTS, { recursive: true });
  await page.waitForTimeout(400); // let a dialog or status settle
  await page.screenshot({ path: `${process.env.SHOTS}/${String(++shots).padStart(3, "0")}-${name}.png` }).catch(() => {});
}

/** Presses `button` on `page`, and resolves with Selfhold's window once it shows this request. */
export async function inSelfhold(page, button) {
  const n = Number(await page.evaluate((key) => sessionStorage.getItem(key) ?? 0, REQUESTS)) + 1;
  await button.click();
  const opened = await page.context().selfhold;
  await until(`Selfhold's window, request ${n}`, async () => new URL(opened.url()).searchParams.get("n") === String(n), 30);
  // Its approving button wakes only in a focused window.
  await opened.bringToFront();
  await opened.locator("button").first().waitFor({ timeout: 30_000 }).catch(() => {});
  await shot(opened, `selfhold-window-${n}`);
  return opened;
}

/** How many times the page has opened Selfhold's window. */
export const selfholdRequests = (page) => page.evaluate((key) => Number(sessionStorage.getItem(key) ?? 0), REQUESTS);

/** The account Selfhold's window gave this site, as the page remembers it, or null. */
export const selfholdAccount = (page) => page.evaluate((origin) => localStorage.getItem(`selfhold.web.address ${origin}`), walletOrigin);

/**
 * Presses `button` (Continue with Selfhold, or a write's button while signed
 * out), and in Selfhold's window makes a new account with a passkey and
 * connects it here. Its address.
 */
export async function newSelfholdAccount(page, button) {
  const opened = await inSelfhold(page, button);
  await opened.getByRole("button", { name: "Create an account" }).click();
  await opened.getByRole("button", { name: "Connect", exact: true }).click();
  await until("Selfhold's account, here", async () => Boolean(await selfholdAccount(page)), 30);
  return selfholdAccount(page);
}

/** Signs in from the header, as a new person: Sign in, then Continue with Selfhold. Their address. */
export async function signIn(page) {
  await page.locator("#who").getByRole("button", { name: "Sign in" }).click();
  return newSelfholdAccount(page, page.locator("#signin").getByRole("button", { name: "Continue with Selfhold" }));
}

/** Presses `button`, then approves the write in Selfhold's window, with the passkey. */
export async function approveInSelfhold(page, button) {
  const opened = await inSelfhold(page, button);
  await opened.getByRole("button", { name: "Approve with your passkey" }).click();
  return opened;
}

/** Presses `button`, then declines the write in Selfhold's window. */
export async function declineInSelfhold(page, button) {
  const opened = await inSelfhold(page, button);
  await opened.getByRole("button", { name: "Decline" }).click();
  return opened;
}

/** Every transaction sent to the node, from any page of the context. */
export function sends(context) {
  const sent = [];
  context.on("request", (request) => request.method() === "POST" && new URL(request.url()).pathname === "/transactions" && sent.push(request));
  return sent;
}
