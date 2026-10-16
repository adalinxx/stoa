// Which node to read a chain from. The reader's chosen node when it serves
// the chain; else one found for the chain from it, walking the chain
// directory down from Nexus (nodes their operators declared). A chain is
// offline only when no node is found. Everything read is checked by CID, so
// a found node needs no more trust than the chosen one.

/** No node serves the chain, as far as the chosen node's directory says. */
export class Offline extends Error {
  constructor(chain) {
    super(`No node serves ${chain.join("/")}`);
    this.chain = chain;
  }
}

/**
 * `nodeFor(chain)`: a promise of the node to read `chain` from, kept for the
 * visit; a failed search is dropped so a later read searches again.
 *   start            the chosen node's URL
 *   serves(url, c)   whether the node at `url` answers for chain `c` (false when it doesn't)
 *   find(c)          URLs declared for `c`, found from the chosen node
 * When the chosen node can't be reached at all, that error is thrown, not Offline.
 */
export function nodeFinder({ start, serves, find }) {
  const found = new Map();
  return function nodeFor(chain) {
    const key = chain.join("/");
    if (!found.has(key)) {
      const search = (async () => {
        if (await serves(start, chain)) return start;
        for (const url of await find(chain)) {
          if (url !== start && (await serves(url, chain).catch(() => false))) return url;
        }
        throw new Offline(chain);
      })();
      found.set(key, search);
      search.catch(() => found.get(key) === search && found.delete(key));
    }
    return found.get(key);
  };
}
