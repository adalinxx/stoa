// Which node to read a chain from. The reader's chosen node when it serves
// the chain; else one found for the chain, from the deepest ancestor the
// chosen node serves, through the chain directory (nodes their operators
// declared). A chain is offline only when no node is found.
//
// The reader chose their node, and its word on a chain's tip is taken. A
// found node was chosen by no one, so it is read only at the block the parent
// chain committed (as the chosen node reports it): it can withhold, not make
// up. The search runs again after `ttl` ms, to follow newer commitments.

/** No node serves the chain, as far as the chosen node's directory says. */
export class Offline extends Error {
  constructor(chain) {
    super(`No node serves ${chain.join("/")}`);
    this.chain = chain;
  }
}

/**
 * `nodeFor(chain)`: a promise of `{ url, block? }`, where to read `chain`;
 * `block` (a found node only) is the committed block to read it at. A failed
 * search is dropped so a later read searches again, and
 * `nodeFor.forget(chain, node)` drops a node that stopped working.
 *   start               the chosen node's URL
 *   serves(url, c)      true when the node answers for chain `c`, false when
 *                       it has no such chain; throws when it fails otherwise
 *   find(c, start, at)  `[{ url, committedBlock }]` declared for `c`, found
 *                       through `start` from its ancestor chain `at`
 */
export function nodeFinder({ start, serves, find, ttl = 30_000, now = Date.now }) {
  const found = new Map(); // chain → { search, until }
  const nodeFor = (chain) => {
    const key = chain.join("/");
    const kept = found.get(key);
    if (kept && now() < kept.until) return kept.search;
    const entry = { until: Infinity };
    entry.search = (async () => {
      if (await serves(start, chain)) return { url: start };
      // The commitment is read from the chosen node: from the deepest
      // ancestor it serves.
      let at = chain.slice(0, -1);
      while (at.length > 1 && !(await serves(start, at))) at = at.slice(0, -1);
      for (const { url, committedBlock } of await find(chain, start, at)) {
        if (url !== start && committedBlock && (await serves(url, chain).catch(() => false))) {
          entry.until = now() + ttl;
          return { url, block: committedBlock };
        }
      }
      throw new Offline(chain);
    })();
    found.set(key, entry);
    entry.search.catch(() => found.get(key) === entry && found.delete(key));
    return entry.search;
  };
  nodeFor.forget = async (chain, node) => {
    const key = chain.join("/");
    const kept = found.get(key);
    if (kept && (await kept.search.catch(() => null)) === node) found.delete(key);
  };
  return nodeFor;
}
