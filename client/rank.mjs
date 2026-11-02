// Orderings over votes and post time. The formulas are Reddit's, from its
// open-source ranking code (r2/lib/db/_sorts.pyx); a client may use others.
// Times are post times in milliseconds.

export const score = ({ ups, downs }) => ups - downs;

/** Reddit's hot: the order of magnitude of the score plus 1 per 12.5 hours of age. */
export function hot({ ups, downs, time }) {
  const s = ups - downs;
  const order = Math.log10(Math.max(Math.abs(s), 1));
  const sign = Math.sign(s);
  const seconds = time / 1000 - 1134028003;
  return Math.round((sign * order + seconds / 45000) * 1e7) / 1e7;
}

const orders = {
  hot: (a, b) => hot(b) - hot(a),
  new: (a, b) => b.time - a.time,
  top: (a, b) => score(b) - score(a),
};

/**
 * `items` (each with `ups`, `downs`, and `time` for hot and new) in the
 * order `by`, ties to the newer. `since` keeps only items at or after it,
 * as Top does for a period.
 */
export function rank(items, by, { since } = {}) {
  const order = orders[by];
  if (!order) throw new RangeError(`no ordering ${by}`);
  const kept = since === undefined ? [...items] : items.filter((item) => item.time >= since);
  return kept.sort((a, b) => order(a, b) || (b.time ?? 0) - (a.time ?? 0));
}
