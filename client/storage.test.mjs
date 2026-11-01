import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { StorageRefused, StorageStopped, store, storageChain } from "./storage.mjs";
import { compress, prepare } from "./work/sha256.mjs";

const TIMES = { call: 2000, busy: 1, longest: 5000, pinned: 2000, look: 1 };
const PREFIX = "ab".repeat(80);
// About one hash in sixteen is a share.
const TARGET = `0f${"ff".repeat(31)}`;
const isShare = (nonce) => {
  const hash = createHash("sha256").update(Buffer.from(PREFIX, "hex")).update(Buffer.from(BigInt(nonce).toString(16).padStart(16, "0"), "hex")).digest("hex");
  return BigInt(`0x${hash}`) <= BigInt(`0x${TARGET}`);
};

/** Grinds in-process with the page's SHA-256, as the workers do. */
function hash(work, found, hashed) {
  let stopped = false;
  const done = (async () => {
    const { midstate, last, tail, blocks, target } = prepare(work.prefixHex, work.shareTarget);
    const view = new DataView(last.buffer);
    const state = new Uint32Array(8);
    for (let n = BigInt(work.startNonce), end = n + BigInt(work.count); n < end && !stopped; n++) {
      view.setUint32(tail, Number(n >> 32n));
      view.setUint32(tail + 4, Number(n & 0xffffffffn));
      state.set(midstate);
      for (let b = 0; b < blocks; b++) compress(state, view, b * 64);
      for (let i = 0; i < 8; i++) {
        if (state[i] === target[i] && i < 7) continue;
        if (state[i] <= target[i]) found(n);
        break;
      }
      if (n % 64n === 0n) await new Promise((resolve) => setImmediate(resolve));
    }
    hashed(Number(work.count));
  })();
  return { done, stop: () => (stopped = true) };
}

/** A sponsor selling storage at `perShare` bytes a share, as lattice-sponsor answers. */
function sponsor({ perShare = 100, busyFirst = 0, budget = Infinity, rates = { "Nexus/stoa": 10 } } = {}) {
  const uploads = new Map();
  const seen = new Set();
  const asked = [];
  let busy = busyFirst;
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const refuse = (status, message) => json(status, { error: { message } });
  const fetch = async (url, { method = "GET", body } = {}) => {
    const path = new URL(url).pathname.replace(/^\/sponsor\//, "");
    const input = body && JSON.parse(body);
    asked.push(`${method} ${path}`);
    const status = (root) => {
      const u = uploads.get(root);
      return { root, bytes: String(u.bytes), needed: {}, credit: String(u.credit), stored: u.stored };
    };
    if (path === "terms") return json(200, { payTo: null, depth: "6", storageRates: rates, servingRates: {} });
    if (path === "store" && method === "POST") {
      if (uploads.has(input.root)) return refuse(400, "draft(\"root already uploaded\")");
      const bytes = Object.values(input.volumes[0].entries).reduce((sum, b64) => sum + Buffer.from(b64, "base64").length, 0);
      if (bytes > budget) return refuse(400, "overBudget");
      uploads.set(input.root, { bytes, credit: 0, stored: false });
      return json(200, status(input.root));
    }
    if (path.startsWith("store/")) {
      const root = path.slice("store/".length);
      const u = uploads.get(root);
      if (!u) return refuse(404, "unknownUpload");
      // Pinned once paid, on the next look, as pinIfPaid does.
      if (u.credit >= u.bytes) u.stored = true;
      return json(200, status(root));
    }
    if (path === "work") {
      if (busy-- > 0) return refuse(503, "busy");
      if (!rates[input.chain]) return refuse(400, "noStorageRate");
      if (!uploads.has(input.store)) return refuse(400, "unknownUpload");
      return json(200, { client: input.client ?? "token", assignment: input.store, prefixHex: PREFIX, shareTarget: TARGET, startNonce: "0", count: "100000", fee: "0", pay: "0", sharesForFee: "0", expiresInMilliseconds: "60000" });
    }
    if (path === "shares") {
      if (!isShare(input.nonce)) return refuse(400, "missesShareTarget");
      if (seen.has(input.nonce)) return refuse(400, "duplicateShare");
      seen.add(input.nonce);
      uploads.get(input.assignment).credit += perShare;
      return json(200, { credit: "0" });
    }
    return refuse(404, "no route");
  };
  return { fetch, asked, uploads };
}

const volume = (bytes) => ({ cid: "bafyreitest", entries: { bafyreitest: Buffer.alloc(bytes, 7).toString("base64") } });
const URL_ = "https://sponsor.example/sponsor";

test("work pays for the file, and it resolves once the sponsor has pinned it", async () => {
  const s = sponsor({ busyFirst: 1 });
  const stages = [];
  const done = await store(URL_, volume(350), { chain: "Nexus/stoa", hash, fetch: s.fetch, times: TIMES, progress: (p) => stages.push(p) });
  assert.equal(done.stored, true);
  assert.ok(s.uploads.get("bafyreitest").credit >= 350);
  // Four shares at 100 bytes each, and none sent after it was paid.
  assert.equal(s.asked.filter((a) => a === "POST shares").length, 4);
  assert.deepEqual([...new Set(stages.map((p) => p.stage))], ["upload", "work", "busy", "grind", "pin"]);
  const grinding = stages.filter((p) => p.stage === "grind").map((p) => p.done);
  assert.deepEqual(grinding, [...grinding].sort((a, b) => a - b));
  assert.equal(grinding.at(-1), 1);
});

test("a file the sponsor already keeps needs no work", async () => {
  const s = sponsor();
  s.uploads.set("bafyreitest", { bytes: 10, credit: 10, stored: true });
  const done = await store(URL_, volume(10), { chain: "Nexus/stoa", hash, fetch: s.fetch, times: TIMES });
  assert.equal(done.stored, true);
  assert.ok(!s.asked.includes("POST work"));
});

test("a full sponsor is said as such", async () => {
  const s = sponsor({ budget: 5 });
  await assert.rejects(store(URL_, volume(10), { chain: "Nexus/stoa", hash, fetch: s.fetch, times: TIMES }), (error) =>
    error instanceof StorageRefused && /full/.test(error.message));
});

test("stopping ends the work", async () => {
  const s = sponsor({ perShare: 1 });
  const stop = new AbortController();
  const running = store(URL_, volume(10_000), { chain: "Nexus/stoa", hash, fetch: s.fetch, times: TIMES, signal: stop.signal, progress: (p) => p.stage === "grind" && stop.abort() });
  await assert.rejects(running, StorageStopped);
});

test("the chain to work on: the first preferred with a rate, else any, else none", async () => {
  const s = sponsor({ rates: { Nexus: 1, "Nexus/stoa": 10 } });
  assert.equal(await storageChain(URL_, ["Nexus/stoa/bitcoin", "Nexus/stoa"], { fetch: s.fetch }), "Nexus/stoa");
  assert.equal(await storageChain(URL_, ["Nexus/other"], { fetch: s.fetch }), "Nexus");
  assert.equal(await storageChain(URL_, [], { fetch: sponsor({ rates: {} }).fetch }), null);
  assert.equal(await storageChain(URL_, [], { fetch: async () => { throw new TypeError("offline"); } }), null);
});
