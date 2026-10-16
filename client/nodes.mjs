// Which node to read a chain from. The reader's chosen node when it serves
// the chain; else one found through its hosts' rendezvous (nodes their
// operators declared), walking down from the nearest ancestor the chosen node
// serves: each level's found hosts are asked about the level below. What a
// parent commits never decides: a found node serves the chain at that path,
// on this network, and is read at its own tip. A chain is offline only when
// no node is found. The search runs again after `ttl` ms, to follow the hosts
// as they come and go.

/** No node serves the chain, as far as the chosen node's directory says. */
export class Offline extends Error {
  constructor(chain) {
    super(`No node serves ${chain.join("/")}`);
    this.chain = chain;
  }
}

/**
 * `nodeFor(chain)`: a promise of `{ url, found? }`, where to read `chain`;
 * `found` is true for a node the reader did not choose. A failed
 * search is dropped so a later read searches again, and
 * `nodeFor.forget(chain, node)` drops a node that stopped working.
 *   start               the chosen node's URL
 *   serves(url, c)      true when the node answers for chain `c`, false when
 *                       it has no such chain; throws when it fails otherwise
 *   find(c, start, at)  `[{ url }]` serving `c`, in declared order, found
 *                       through `start` from `c`'s ancestor chain `at`
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
      let at = chain.slice(0, -1);
      while (at.length > 0 && !(await serves(start, at))) at = at.slice(0, -1);
      if (at.length === 0) throw new Offline(chain);
      const host = (await find(chain, start, at)).find(({ url }) => url !== start);
      if (!host) throw new Offline(chain);
      entry.until = now() + ttl;
      return { url: host.url, found: true };
    })();
    found.set(key, entry);
    entry.search.catch(() => found.get(key) === entry && found.delete(key));
    return entry.search;
  };
  nodeFor.forget = async (chain, node) => {
    const key = chain.join("/");
    const kept = found.get(key);
    if (kept && (await kept.search.catch(() => null)) === node && found.get(key) === kept) found.delete(key);
  };
  return nodeFor;
}
