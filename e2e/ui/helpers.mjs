// What the UI tests do outside the page: read the stack, make and fund keys,
// and write records the way another client would.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { operator } from "../../client/media.mjs";
import { tip, view, volumeLoader } from "../../client/state.mjs";
import * as write from "../../client/write.mjs";
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
  const r = await fetch(`${stack.node}/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sdk.transactionPayload({ [publicKey]: signature }, body)),
  });
  if (!r.ok) throw new Error(`submit: ${r.status} ${await r.text()}`);
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

/** The node's operator routes (pinning media), with its loopback cookie. */
export const nodeOperator = () => operator(stack.rpc, readFileSync(`${stack.root}/chains/Nexus/.cookie`, "utf8"));

const walletsSetUp = new WeakSet();
/** The browser's Lattice Wallet holds `who`'s key, as if they imported it. */
async function walletHolds(context, who) {
  if (walletsSetUp.has(context)) return;
  const page = await context.newPage();
  // A message from the wallet's own page wakes its worker.
  await page.goto(`${context.walletOrigin}/popup/index.html`);
  const created = await page.evaluate((privHex) => chrome.runtime.sendMessage({ type: "createWallet", password: "stoa-test", privHex }), who.keyHex);
  // Their node is the stack's: chosen for Nexus, as in the wallet's Connection settings.
  await page.evaluate(async (url) => {
    const { settings } = await chrome.storage.local.get("settings");
    const endpoints = { ...(settings?.endpoints ?? {}), Nexus: { url, acceptsSubmit: true, source: "user" } };
    await chrome.storage.local.set({ settings: { ...settings, nodeMode: "custom", endpoints } });
  }, stack.node);
  if (!created?.ok) throw new Error(`wallet setup: ${created?.error}`);
  await page.close();
  walletsSetUp.add(context);
}

/**
 * Open the app pointed at the stack: as `who`, connected through the
 * browser's wallet (clicking Connect wallet, as a person would), or as a
 * visitor (null).
 */
export async function openApp(page, who, hash = "#/") {
  await page.addInitScript(({ node, home, moniker }) => {
    if (sessionStorage.getItem("stoa-test-seeded")) return;
    sessionStorage.setItem("stoa-test-seeded", "1");
    localStorage.clear();
    localStorage.setItem("stoa:node", JSON.stringify(node));
    localStorage.setItem("stoa:home", JSON.stringify(home));
    localStorage.setItem("stoa:monikerChain", JSON.stringify(moniker));
  }, { node: stack.node, home: stack.home, moniker: MONIKER.join("/") });
  if (who) await walletHolds(page.context(), who);
  await page.goto(stack.app + hash);
  if (!who) return;
  // Already connected from an earlier visit in this browser: nothing to click.
  await page.locator("#who > *").first().waitFor({ timeout: 60_000 });
  const connect = page.locator("#connect");
  if (await connect.count()) {
    await connect.click();
    await connect.waitFor({ state: "detached", timeout: 60_000 });
  }
}
