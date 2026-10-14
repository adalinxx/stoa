// A post's time is the timestamp of the block whose transaction created it;
// authors never state one. State does not say which block wrote a key, so
// this index reads it from the blocks themselves, walking back from a tip by
// each block's parent and verifying every block, transaction list and
// transaction against its CID (the VolumeClient's loads do).
//
// Blocks are kept by hash with their parent, so a reorg needs no undo: the
// times are read off whichever chain the current tip names.
import { list, volumeLoader } from "./state.mjs";

const POST = /^user\/([^/]+)\/post\/([^/]+)$/;

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

  return {
    /**
     * Reads the blocks from `tip` back to the first one already read,
     * genesis, or the first older than `since` (milliseconds), which is left
     * unread.
     */
    async follow(tip, { since = -Infinity } = {}) {
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
