// A private Stoa stack for the UI tests: one Lattice host mining Nexus, the
// home chain and one community (Stoa's policy), and Moniker (its own policy,
// the module Nexus/moniker launched with), all from a fast test spec, with
// public reads and submits; a sponsor (lattice-sponsor) that pays fees and
// keeps files for work; Selfhold's window, served on localhost; and a static
// server for the repository, so the real app/ page runs against it.
//
//   LATTICE=<lattice-node>/.build/debug/lattice
//   LATTICE_SPONSOR=<lattice-sponsor>/.build/debug/lattice-sponsor   (default: beside lattice)
//   LATTICE_SDK=<lattice-sdk>/packages/sdk/dist/index.js
//   LATTICE_WALLET_WEB=<selfhold-wallet>/dist-web                      (Selfhold's window)
import { execFileSync, spawn } from "node:child_process";
import { createReadStream, existsSync, mkdtempSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

export const HOME = ["Nexus", "stoa"];
export const COMMUNITY = "bitcoin";
export const CHAIN = [...HOME, COMMUNITY];
// Where @handles come from, on Moniker's own policy.
export const MONIKER = ["Nexus", "moniker"];
const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const repo = here("../../");
const ports = { listen: 26001, rpc: 26080, publicRead: 26081, web: 26090, sponsor: 26091, wallet: 26092 };

const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".md": "text/plain", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png", ".wasm": "application/wasm" };

/** Serves `root`, the repository's by default, as GitHub Pages does. */
function serve(port, root = repo) {
  const server = createServer((request, response) => {
    const path = normalize(decodeURIComponent(new URL(request.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
    let file = join(root, path);
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!file.startsWith(join(root, "/")) || !existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    createReadStream(file).pipe(response);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

async function until(label, condition, seconds = 300) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const value = await condition().catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

export async function start() {
  const sdk = await import(process.env.LATTICE_SDK);
  const root = mkdtempSync(`${tmpdir()}/stoa-ui-`);
  const lattice = (...args) => execFileSync(process.env.LATTICE, [...args, "--root", root], { encoding: "utf8" });
  const configure = (edit) => {
    const file = `${root}/lattice.json`;
    const topology = JSON.parse(readFileSync(file, "utf8"));
    edit(topology);
    writeFileSync(file, JSON.stringify(topology, null, 2));
  };
  const minerKey = sdk.generatePrivateKey();
  const miner = sdk.accountFromPrivateKey(minerKey);
  lattice("init");
  configure((t) => {
    Object.assign(t, { listen: ports.listen, rpc: ports.rpc, publicRead: ports.publicRead, webSocket: 0, publicSubmit: true });
    // As the testnet hosts of Stoa's chains: a fee of 1, which an account
    // with no coins pays in work, through the sponsor.
    t.minRelayFee = 1;
    // Reads are many (one per trie node): no rate ceilings in the way.
    t.publicReadExpensiveRate = 10000;
    t.publicReadRate = 10000;
    t.publicReadMaxRate = 100000;
    t.peers = [];
    t.mine = { worker: "cpu", workers: 1, batchSize: 100000 };
  });
  lattice("up");
  // The built module chain/spec.json names by CID (rebuild it with the policy).
  const policy = here("../../chain/stoa_policy.wasm");
  for (const chain of [HOME, CHAIN]) {
    lattice("child", "create", chain.join("/"), "--spec", here("./spec.json"), "--policy-module", policy);
  }
  lattice("child", "create", MONIKER.join("/"), "--spec", here("./moniker/spec.json"), "--policy-module", here("./moniker/moniker_policy.wasm"));
  configure((t) => {
    t.mine.recipients = { [HOME.join("/")]: miner.address, [CHAIN.join("/")]: miner.address, [MONIKER.join("/")]: miner.address };
  });
  lattice("mine", "start");
  const node = `http://127.0.0.1:${ports.publicRead}`;
  const balance = async (chain) => {
    const r = await fetch(`${node}/api/state/account/${miner.address}?chainPath=${chain.join("/")}`);
    return r.ok ? BigInt((await r.json()).balance ?? 0) : 0n;
  };
  await until("the home chain, the community and Moniker fund the miner", async () =>
    (await balance(HOME)) > 1000n && (await balance(CHAIN)) > 1000n && (await balance(MONIKER)) > 1000n);
  const web = await serve(ports.web);
  // Selfhold's window, on localhost, where passkeys work and the app (on 127.0.0.1) is another site.
  const walletWeb = process.env.LATTICE_WALLET_WEB && resolvePath(process.env.LATTICE_WALLET_WEB);
  if (!walletWeb) throw new Error("LATTICE_WALLET_WEB: Selfhold's window, built (selfhold-wallet's dist-web/)");
  const wallet = await serve(ports.wallet, walletWeb);

  // The sponsor: it pays a fee of 1 on every chain for small shares of work,
  // and keeps files for work on the home chain. Its account is funded on
  // each chain it pays fees on.
  const sponsorKey = `${root}/sponsor-key.json`;
  execFileSync(process.env.LATTICE, ["key", "generate", "--out", sponsorKey]);
  const sponsorAddress = JSON.parse(readFileSync(sponsorKey, "utf8")).address;
  for (const chain of [HOME, CHAIN, MONIKER]) await transfer(sdk, node, miner, minerKey, sponsorAddress, 5000n, chain);
  const log = openSync(`${root}/sponsor.log`, "a");
  const sponsor = spawn(process.env.LATTICE_SPONSOR || join(dirname(process.env.LATTICE), "lattice-sponsor"), [
    "--node", `http://127.0.0.1:${ports.rpc}`, "--cookie-file", `${root}/chains/Nexus/.cookie`, "--key", sponsorKey,
    "--share-work", "2^12", "--fee", "1", "--most-pay", "0", "--port", String(ports.sponsor),
    "--sell-storage", "--storage-rate", `${HOME.join("/")}=1000000`, "--storage-file", `${root}/sponsor-storage.json`,
  ], { stdio: ["ignore", log, log] });
  const sponsorURL = `http://127.0.0.1:${ports.sponsor}`;
  await until("the sponsor prices Stoa's chains and Moniker", async () => {
    for (const chain of [HOME, CHAIN, MONIKER]) {
      const r = await fetch(`${sponsorURL}/work`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chain: chain.join("/") }) });
      if (!r.ok) return false;
    }
    return true;
  }, 180);

  const info = {
    root, node, rpc: `http://127.0.0.1:${ports.rpc}`, app: `http://127.0.0.1:${ports.web}/app/`,
    home: HOME.join("/"), community: COMMUNITY, moniker: MONIKER.join("/"), minerKey: Buffer.from(minerKey).toString("hex"), miner: miner.address,
    sponsor: sponsorURL, sponsorAddress, walletPage: `http://localhost:${ports.wallet}/`,
  };
  return {
    info,
    stop: async () => {
      sponsor.kill();
      wallet.close();
      web.close();
      try { lattice("mine", "stop"); } catch {}
      try { lattice("down"); } catch {}
    },
  };
}

/** The miner sends `amount` to `to` on `chain`, and it lands. */
async function transfer(sdk, node, miner, minerKey, to, amount, chain) {
  const read = async (address) => {
    const r = await fetch(`${node}/api/state/account/${address}?chainPath=${chain.join("/")}`);
    return r.ok ? r.json() : {};
  };
  const nonce = BigInt((await read(miner.address)).nonce ?? 0);
  const body = sdk.buildTransfer({ from: miner.address, to, amount, fee: 1n, nonce, chainPath: chain });
  const { publicKey, signature } = sdk.signTransactionBody(body, minerKey);
  const r = await fetch(`${node}/transactions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sdk.transactionPayload({ [publicKey]: signature }, body)) });
  if (!r.ok) throw new Error(`fund the sponsor: ${r.status} ${await r.text()}`);
  await until(`the sponsor's funds on ${chain.join("/")}`, async () => BigInt((await read(to)).balance ?? 0) >= amount);
}
