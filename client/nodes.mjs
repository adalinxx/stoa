// Which node to read a chain from. The reader's chosen node when it serves
// the chain; else one found for the chain from it, walking the chain
// directory down from Nexus (nodes their operators declared). A chain is
// offline only when no node is found.
//
// The reader chose their node, and its word on a chain's tip is taken. A
// found node was chosen by no one: its tip is taken only when it descends
// from the block the parent chain committed (as the chosen node reports it),
// so it cannot make up a chain of its own.

/** No node serves the chain, as far as the chosen node's directory says. */
export class Offline extends Error {
  constructor(chain) {
    super(`No node serves ${chain.join("/")}`);
    this.chain = chain;
  }
}

/**
 * `nodeFor(chain)`: a promise of `{ url, anchor? }`, the node to read `chain`
 * from; `anchor` (a found node only) is the latest block known to be on the
 * committed chain. Kept for the visit; a failed search is dropped so a later
 * read searches again, and `nodeFor.forget(chain)` drops one that stopped
 * working.
 *   start            the chosen node's URL
 *   serves(url, c)   true when the node answers for chain `c`, false when it
 *                    says it has no such chain; throws when it fails otherwise
 *   find(c, start)   `[{ url, committedBlock }]` declared for `c`, found from `start`
 */
export function nodeFinder({ start, serves, find }) {
  const found = new Map();
  const nodeFor = (chain) => {
    const key = chain.join("/");
    if (!found.has(key)) {
      const search = (async () => {
        if (await serves(start, chain)) return { url: start };
        for (const { url, committedBlock } of await find(chain, start)) {
          if (url !== start && (await serves(url, chain).catch(() => false))) return { url, anchor: committedBlock };
        }
        throw new Offline(chain);
      })();
      found.set(key, search);
      search.catch(() => found.get(key) === search && found.delete(key));
    }
    return found.get(key);
  };
  nodeFor.forget = (chain) => found.delete(chain.join("/"));
  return nodeFor;
}

/**
 * Whether block `hash` is `anchor` or descends from it, walking back by
 * `parentCID` no lower than the anchor's height. `blockAt(cid)` reads a block.
 */
export async function descends(blockAt, hash, anchor) {
  const floor = BigInt((await blockAt(anchor)).height);
  for (let at = hash; at; ) {
    if (at === anchor) return true;
    const block = await blockAt(at);
    if (BigInt(block.height) <= floor) return false;
    at = block.parentCID;
  }
  return false;
}
