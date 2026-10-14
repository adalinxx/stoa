// Stoa end to end on real nodes. A private host mines Nexus, the home chain
// Nexus/stoa and the community Nexus/stoa/bitcoin, all from chain/spec.json
// and the built policy. People write through the public submit route; every
// result is read back by descending the state trie by CID. A second node,
// the reader's, joins the community from the first as its only peer and
// reads the community from its own state: the posts ranked by block time and
// votes, a thread as a tree, a picture fetched from peers, and the feed as a
// reader who follows one moderator sees it.
//
//   LATTICE=<lattice-node>/.build/debug/lattice \
//   LATTICE_SDK=<lattice-sdk>/packages/sdk/dist/index.js node e2e/run.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { mediaVolume, operator, readMedia } from "../client/media.mjs";
import { judge } from "../client/moderation.mjs";
import { karma, rank } from "../client/rank.mjs";
import * as read from "../client/read.mjs";
import { tip, view, volumeLoader } from "../client/state.mjs";
import { blockTimes } from "../client/time.mjs";
import * as write from "../client/write.mjs";

const sdk = await import(process.env.LATTICE_SDK);
const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const HOME = ["Nexus", "stoa"];
const BITCOIN = ["Nexus", "stoa", "bitcoin"];
const author = { listen: 25001, rpc: 29080, publicRead: 29081 };
const reader = { listen: 25011, rpc: 29090, publicRead: 29091 };
const authorNode = `http://127.0.0.1:${author.publicRead}`;
const readerNode = `http://127.0.0.1:${reader.publicRead}`;
const policy = here("../policy/target/wasm32-unknown-unknown/release/stoa_policy.wasm");

const host = (root) => ({
  root,
  lattice: (...args) => execFileSync(process.env.LATTICE, [...args, "--root", root], { encoding: "utf8" }),
  configure(edit) {
    const file = `${root}/lattice.json`;
    const topology = JSON.parse(readFileSync(file, "utf8"));
    edit(topology);
    writeFileSync(file, JSON.stringify(topology, null, 2));
  },
  /** The node's loopback operator routes, with the cookie it wrote at start. */
  operator: (rpc) => operator(`http://127.0.0.1:${rpc}`, readFileSync(`${root}/chains/Nexus/.cookie`, "utf8")),
});
const authors = host(mkdtempSync(`${tmpdir()}/stoa-e2e-`));
const readers = host(mkdtempSync(`${tmpdir()}/stoa-e2e-reader-`));

const account = () => sdk.accountFromPrivateKey(sdk.generatePrivateKey());
const [alice, bob, carol, mod] = [account(), account(), account(), account()];

async function until(label, condition, seconds = Number(process.env.E2E_SECONDS ?? 300)) {
  const deadline = Date.now() + seconds * 1000;
  let failure;
  for (;;) {
    const value = await condition().catch((error) => void (failure = error));
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`, { cause: failure });
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function api(path, chain, at = authorNode) {
  const url = new URL(path, at);
  url.searchParams.set("chainPath", chain.join("/"));
  const response = await fetch(url);
  return response.ok ? response.json() : undefined;
}

const volumesAt = (at, chain) => new sdk.VolumeClient(new sdk.HTTPVolumeTransport(`${at}/volumes`, { chainPath: chain }));

/** The state of `chain` at a node's tip, as a view, with the tip's hash. */
async function state(chain, at = authorNode) {
  const volumes = volumesAt(at, chain);
  const { hash, generalStateCID } = await tip(sdk, at, chain, volumes);
  return { hash, volumes, ...view(volumeLoader(volumes, sdk.decodeDagCbor), generalStateCID) };
}

/** Signs and submits record writes on `chain`; resolves to the node's response. */
async function submit(chain, who, records, fee = 0n) {
  const actions = await write.changes(await state(chain), records);
  const nonce = BigInt((await api(`/api/state/account/${who.address}`, chain))?.nonce ?? 0);
  const body = write.transaction({ owner: who.address, actions, fee, nonce, chainPath: chain });
  const { publicKey, signature } = sdk.signTransactionBody(body, who.privateKey);
  return fetch(new URL("/transactions", authorNode), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sdk.transactionPayload({ [publicKey]: signature }, body)),
  });
}

/** Submits until accepted, then waits until every write reads back. */
async function writes(label, chain, who, records) {
  await until(label, async () => {
    const response = await submit(chain, who, records);
    if (!response.ok) console.log(`  ${label}: ${response.status} ${await response.text()}`);
    return response.ok;
  });
  await until(`${label} is mined`, async () => {
    const now = await state(chain);
    for (const [key, value] of records) if ((await now.get(key)) !== value) return false;
    return true;
  });
  console.log(label);
}

const startedAt = Date.now();
try {
  authors.lattice("init");
  authors.configure((topology) => {
    Object.assign(topology, { ...author, webSocket: 0, publicSubmit: true });
    // Each trie node is one Volume read, and a node bills those to its
    // expensive budget (1/s per client unless the operator says otherwise).
    topology.publicReadExpensiveRate = 1000;
    // Explicitly none: this host seeds itself and must not join the public network.
    topology.peers = [];
    topology.mine = { worker: "cpu", workers: 1, batchSize: 100000 };
  });
  authors.lattice("up");
  for (const chain of [HOME, BITCOIN]) {
    authors.lattice("child", "create", chain.join("/"), "--spec", here("../chain/spec.json"), "--policy-module", policy);
  }
  authors.configure((topology) => {
    topology.mine.recipients = { [HOME.join("/")]: alice.address, [BITCOIN.join("/")]: alice.address };
  });
  authors.lattice("mine", "start");
  await until("both chains are mined", async () =>
    (await Promise.all([HOME, BITCOIN].map((chain) => api("/api/block/latest", chain)))).every(Boolean),
  );
  console.log("Nexus, Nexus/stoa and Nexus/stoa/bitcoin are mined");

  // The home chain: who Alice is and what she reads.
  await writes("profile and join on the home chain", HOME, alice, [
    ...write.profile(alice.address, { name: "Alice", about: "bitcoin and pictures" }),
    ...write.join(alice.address, "bitcoin"),
    ...write.advertise(alice.address, "bitcoin", { about: "Bitcoin talk" }),
  ]);

  // A link post with a picture: the picture's Volume is pinned on Alice's
  // node, and the post names its CID.
  const picture = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4500000000049454e44ae426082",
    "hex",
  );
  const volume = mediaVolume(sdk, "image/png", picture);
  assert.ok((await authors.operator(author.rpc).pin(volume)).pins.includes(volume.cid));
  const linkPost = { author: alice.address, id: write.newId() };
  await writes(
    "link post with a picture",
    BITCOIN,
    alice,
    write.post(
      linkPost.author,
      linkPost.id,
      { title: "The whitepaper", body: "Worth a reread.", link: "https://bitcoin.org/bitcoin.pdf", tags: ["oc"] },
      [volume.cid],
    ),
  );

  const textPost = { author: bob.address, id: write.newId() };
  await writes("text post", BITCOIN, bob, write.post(textPost.author, textPost.id, { title: "Buy my coin", body: "!!!" }));

  const c1 = { author: bob.address, id: write.newId() };
  await writes("comment", BITCOIN, bob, write.comment(c1.author, c1.id, linkPost, { body: "Section 11 still holds." }));
  const c2 = { author: carol.address, id: write.newId() };
  await writes(
    "reply to the comment",
    BITCOIN,
    carol,
    write.comment(c2.author, c2.id, linkPost, { body: "And section 6.", link: "https://example.com/s6" }, { parent: c1 }),
  );

  await writes("votes", BITCOIN, carol, [
    ...write.vote(carol.address, linkPost.author, linkPost.id, 1),
    ...write.vote(carol.address, textPost.author, textPost.id, -1),
    ...write.vote(carol.address, c1.author, c1.id, 1),
  ]);
  await writes("more votes", BITCOIN, mod, [
    ...write.vote(mod.address, linkPost.author, linkPost.id, 1),
    ...write.vote(mod.address, textPost.author, textPost.id, -1),
  ]);
  await writes("a vote changed", BITCOIN, carol, write.vote(carol.address, textPost.author, textPost.id, 1));

  // Moderation is a labelled comment; a report is one from an account no
  // reader follows as a moderator.
  await writes("moderator's labelled comment", BITCOIN, mod,
    write.label(mod.address, write.newId(), textPost, ["spam"], { body: "Shilling." }));
  await writes("report", BITCOIN, carol, write.label(carol.address, write.newId(), textPost, ["report: spam"]));

  // Bob writes into Alice's records: the policy refuses it.
  const forged = await submit(BITCOIN, bob, [[`user/${alice.address}/post/${linkPost.id}`, '{"title":"forged"}']]);
  assert.ok(!forged.ok, "writing another author's record is refused");
  console.log(`forgery refused: ${forged.status} ${await forged.text()}`);

  // The reader's node knows only Alice's node, and finds the chains through Nexus.
  readers.lattice("init");
  readers.configure((topology) => {
    Object.assign(topology, { ...reader, webSocket: 0, hostedChains: [HOME.join("/"), BITCOIN.join("/")] });
    topology.publicReadExpensiveRate = 1000;
    const identity = authors.lattice("identity").match(/([0-9a-f]{64})@/)[1];
    topology.peers = [`${identity}@127.0.0.1:${author.listen}`];
  });
  readers.lattice("up");
  const community = await until("the reader's node has the community", async () => {
    const now = await state(BITCOIN, readerNode);
    return (await read.labelsBy(now, carol.address)).size === 1 && now;
  });
  const home = await state(HOME, readerNode);
  assert.deepEqual(await read.profile(home, alice.address), { name: "Alice", about: "bitcoin and pictures" });
  assert.deepEqual(await read.joined(home, alice.address), ["bitcoin"]);
  assert.deepEqual([...(await read.communities(home)).keys()], ["bitcoin"]);
  console.log("reader: profile, joins and communities from the home chain");

  // Posts with their votes and block times, ranked.
  const times = blockTimes(sdk, community.volumes);
  await times.follow(community.hash);
  const when = times.times(community.hash);
  const listed = await Promise.all(
    (await read.posts(community)).map(async (post) => ({
      ...post,
      ...(await read.votes(community, post.author, post.id)),
      time: when.get(`${post.author}/${post.id}`),
    })),
  );
  for (const post of listed) {
    assert.ok(post.time >= startedAt - 60_000 && post.time <= Date.now() + 60_000, `block time ${post.time}`);
  }
  const [first, second] = rank(listed, "hot");
  assert.equal(first.id, linkPost.id);
  assert.deepEqual([first.ups, first.downs, second.ups, second.downs], [2, 0, 1, 1]);
  assert.equal(first.link, "https://bitcoin.org/bitcoin.pdf");
  assert.deepEqual(first.media, [volume.cid]);
  assert.ok(second.time >= first.time, "the text post's block is not earlier than the link post's");
  assert.deepEqual(rank(listed, "new").map((p) => p.id), [textPost.id, linkPost.id]);
  assert.equal(rank(listed, "controversial")[0].id, textPost.id);
  console.log("reader: posts ranked by votes and block time");

  const tree = await read.thread(community, linkPost.author, linkPost.id);
  assert.deepEqual(tree.replies.map((c) => c.id), [c1.id]);
  assert.deepEqual(tree.replies[0].replies.map((c) => c.id), [c2.id]);
  assert.equal(tree.replies[0].replies[0].link, "https://example.com/s6");
  const bobsItems = await Promise.all(
    (await read.itemsBy(community, bob.address)).map((i) => read.votes(community, i.author, i.id)),
  );
  assert.equal(karma(bobsItems), 1);
  console.log("reader: the thread as a tree; Bob's karma is 1");

  // Moderation as a reader chooses it.
  const followingMod = judge(new Map([[mod.address, await read.labelsBy(community, mod.address)]]), { spam: "hide" });
  const followingNoOne = judge(new Map(), { spam: "hide" });
  assert.equal(followingMod(textPost).treatment, "hide");
  assert.equal(followingMod(linkPost).treatment, "show");
  assert.equal(followingNoOne(textPost).treatment, "show");
  const reports = (await read.thread(community, textPost.author, textPost.id)).replies.filter((c) => c.labels.length > 0);
  assert.deepEqual(reports.map((c) => c.labels).sort(), [["report: spam"], ["spam"]]);
  console.log("reader: the moderator's labelled comment hides the post for a reader who follows them, and only for them");

  // The picture, from peers through the reader's own node.
  const readersNode = readers.operator(reader.rpc);
  const served = await until("the picture is served to the reader's node", () => readersNode.fetch(volume.cid));
  const file = readMedia(sdk, served, { accept: (type) => type.startsWith("image/"), maxBytes: 1 << 20 });
  assert.equal(file?.type, "image/png");
  assert.deepEqual(Buffer.from(file.bytes), picture);
  console.log("reader: the picture fetched from peers and checked");

  // Each author edits or deletes their own post.
  await writes(
    "edit",
    BITCOIN,
    alice,
    write.post(linkPost.author, linkPost.id, { title: "The whitepaper (2008)", link: "https://bitcoin.org/bitcoin.pdf" }),
  );
  await writes("delete", BITCOIN, bob, write.post(textPost.author, textPost.id, undefined));
  assert.deepEqual((await read.posts(await state(BITCOIN))).map((p) => p.title), ["The whitepaper (2008)"]);
  console.log("edit and delete read back");
} finally {
  try { readers.lattice("down"); } catch {}
  try { authors.lattice("mine", "stop"); } catch {}
  try { authors.lattice("down"); } catch {}
}
