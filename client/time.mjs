// A post's time is the timestamp of the block whose transaction created it;
// authors never state one. State does not say which block wrote a key, so
// this index reads it from the blocks themselves, walking back from a tip by
// each block's parent and verifying every block, transaction list and
// transaction against its CID (the VolumeClient's loads do).
//
// Blocks are kept by hash with their parent, so a reorg needs no undo: the
// times are read off whichever chain the current tip names.
//
// Most blocks carry no transactions. Given the node's block list (`pages`,
// newest first), only blocks it lists with transactions are read; the rest,
// and which block each follows, are taken on the node's word, as its tip is.
// So a lying node can misdate a post (give it another block's time, or none)
// but not invent one: every post and every time comes from content read by
// CID. A list that does not hold the tip, does not link up or descend, or
// disagrees with a block read is set aside, and the blocks are read one by
// one instead.
import { list, volumeLoader } from "./state.mjs";

const POST = /^user\/([^/]+)\/post\/([^/]+)$/;
// The node's block list: rows per page, and pages asked for at once.
const PAGE = 25;
const LIST_AT_ONCE = 8;

/** The index over one chain's blocks, read through `volumes` (a VolumeClient). */
export function blockTimes(sdk, volumes) {
  const load = volumeLoader(volumes, sdk.decodeDagCbor);
  // hash → { parent?, timestamp, created: ["<author>/<id>", …] }
  const blocks = new Map();

  // A block's transaction list travels inside the block's own Volume; each
  // entry names a transaction's Volume, which holds its body.
  async function created(transactionsCID, blockVolume) {
    const found = [];
    const inBlock = (cid, within) => load(cid, within ?? blockVolume);
    for await (const [, reference] of list(inBlock, transactionsCID)) {
      const volume = await volumes.get(reference.rawCID);
      const signed = sdk.decodeCanonicalSignedTransaction(volume.rootBytes());
      const bodyBytes = volume.bytes(signed.bodyCID) ?? (await volumes.get(signed.bodyCID)).rootBytes();
      for (const action of sdk.decodeDagCbor(bodyBytes).actions ?? []) {
        const match = POST.exec(action.key);
        if (match && action.oldValue === undefined && action.newValue !== undefined) {
          found.push(`${match[1]}/${match[2]}`);
        }
      }
    }
    return found;
  }

  /**
   * The node's list from its newest block back to one already read, genesis,
   * or `since`: kept only if every row links to the next and each block with
   * transactions, read by CID, matches its row. Pages after the first are
   * asked for several at a time.
   */
  async function listed(pages, since, tip) {
    const first = await pages(undefined);
    const rows = [...first.blocks];
    const top = rows[0]?.height;
    let before = first.nextBefore;
    const done = () =>
      before === undefined || rows.some((row) => blocks.has(row.hash) || Number(row.timestamp) < since);
    while (!done()) {
      const starts = [];
      for (let at = BigInt(before); at > 0n && starts.length < LIST_AT_ONCE; at -= BigInt(PAGE)) starts.push(at);
      const more = await Promise.all(starts.map((at) => pages(at)));
      for (const page of more) rows.push(...page.blocks);
      const next = more.at(-1).nextBefore;
      // Each round must reach lower blocks, or the list is set aside.
      if (next !== undefined && BigInt(next) >= BigInt(before)) throw new Error("block list does not descend");
      before = next;
    }
    // The list must hold the tip this page read, so it describes that chain.
    if (top === undefined || !rows.some((row) => row.hash === tip)) return;
    const kept = [];
    for (const [n, row] of rows.entries()) {
      if (Number(row.timestamp) < since || blocks.has(row.hash)) break;
      const below = rows[n + 1];
      if (below && row.previousBlock !== below.hash) return;
      if (row.height !== top - BigInt(n)) return;
      kept.push(row);
    }
    const read = await Promise.all(
      kept.map(async (row) => {
        const entry = { ...(row.previousBlock && { parent: row.previousBlock }), timestamp: Number(row.timestamp), created: [] };
        if (row.transactionCount === 0) return [row.hash, entry];
        const volume = await volumes.get(row.hash);
        const block = sdk.decodeCanonicalBlock(volume.rootBytes());
        if (Number(block.timestamp) !== entry.timestamp || block.parentCID !== row.previousBlock) throw new Error("block list disagrees");
        return [row.hash, { ...entry, created: await created(block.transactionsCID, volume) }];
      }),
    );
    for (const [hash, entry] of read) blocks.set(hash, entry);
  }

  return {
    /**
     * Reads the blocks from `tip` back to the first one already read,
     * genesis, or the first older than `since` (milliseconds), which is left
     * unread. `pages(before)`, when given, answers the node's block list
     * below height `before` (the newest when undefined), as
     * `{ blocks: [{ height, hash, previousBlock?, timestamp, transactionCount }], nextBefore? }`.
     */
    async follow(tip, { since = -Infinity, pages } = {}) {
      if (pages && !blocks.has(tip)) await listed(pages, since, tip).catch(() => {});
      for (let hash = tip; hash !== undefined && !blocks.has(hash); ) {
        const volume = await volumes.get(hash);
        const block = sdk.decodeCanonicalBlock(volume.rootBytes());
        const timestamp = Number(block.timestamp);
        if (timestamp < since) break;
        blocks.set(hash, {
          ...(block.parentCID && { parent: block.parentCID }),
          timestamp,
          created: await created(block.transactionsCID, volume),
        });
        hash = block.parentCID;
      }
    },

    /**
     * `"<author>/<id>"` → the creation time of every post or comment created
     * in a block read on the chain ending at `tip`. Items created earlier
     * than what was read are absent: they are older than the window.
     */
    times(tip) {
      const found = new Map();
      for (let hash = tip; blocks.has(hash); hash = blocks.get(hash).parent) {
        const { timestamp, created } = blocks.get(hash);
        // From the tip back: the latest creation of a key wins, which is the
        // one that made the record now in state.
        for (const key of created) if (!found.has(key)) found.set(key, timestamp);
      }
      return found;
    },
  };
}
