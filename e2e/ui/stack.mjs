// A private Stoa stack for the UI tests: one Lattice host mining Nexus, the
// home chain, one community and a Moniker chain (where names come from) from
// a fast test spec, with public reads and
// submits, and a static server for the repository so the real app/ page runs
// against it.
//
//   LATTICE=<lattice-node>/.build/debug/lattice
//   LATTICE_SDK=<lattice-sdk>/packages/sdk/dist/index.js
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

export const HOME = ["Nexus", "stoa"];
export const COMMUNITY = "bitcoin";
export const CHAIN = [...HOME, COMMUNITY];
// Names: a card at user/<a>/profile. Stoa's owner-only policy stands in for
// Moniker's own here; the page only reads the card.
export const MONIKER = ["Nexus", "moniker"];
const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const repo = here("../../");
const ports = { listen: 26001, rpc: 26080, publicRead: 26081, web: 26090 };

const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".md": "text/plain" };

/** Serves the repository root, as GitHub Pages does. */
function serve(port) {
  const server = createServer((request, response) => {
    const path = normalize(decodeURIComponent(new URL(request.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
    let file = join(repo, path);
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!file.startsWith(repo) || !existsSync(file)) {
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
    // As the Stoa node: a fee of 1 per transaction, so posting costs coins.
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
  for (const chain of [HOME, CHAIN, MONIKER]) {
    lattice("child", "create", chain.join("/"), "--spec", here("./spec.json"), "--policy-module", policy);
  }
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
  const info = {
    root, node, rpc: `http://127.0.0.1:${ports.rpc}`, app: `http://127.0.0.1:${ports.web}/app/`,
    home: HOME.join("/"), community: COMMUNITY, minerKey: Buffer.from(minerKey).toString("hex"), miner: miner.address,
  };
  return {
    info,
    stop: async () => {
      web.close();
      try { lattice("mine", "stop"); } catch {}
      try { lattice("down"); } catch {}
    },
  };
}
