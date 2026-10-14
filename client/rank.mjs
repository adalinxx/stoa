// Orderings over votes and block time. The formulas are Reddit's, from its
// open-source ranking code (r2/lib/db/_sorts.pyx); a client may use others.
// Times are block timestamps in milliseconds.

export const score = ({ ups, downs }) => ups - downs;

/** Reddit's hot: the order of magnitude of the score plus 1 per 12.5 hours of age. */
export function hot({ ups, downs, time }) {
  const s = ups - downs;
  const order = Math.log10(Math.max(Math.abs(s), 1));
  const sign = Math.sign(s);
  const seconds = time / 1000 - 1134028003;
  return Math.round((sign * order + seconds / 45000) * 1e7) / 1e7;
}

/** Reddit's best: the lower bound of the Wilson interval on the up ratio, at 80% confidence. */
export function best({ ups, downs }) {
  const n = ups + downs;
  if (n === 0) return 0;
  const z = 1.281551565545;
  const p = ups / n;
  const left = p + (z * z) / (2 * n);
  const right = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return (left - right) / (1 + (z * z) / n);
}

/** Reddit's controversial: many votes, evenly split. */
export function controversial({ ups, downs }) {
  if (ups <= 0 || downs <= 0) return 0;
  const balance = ups > downs ? downs / ups : ups / downs;
  return (ups + downs) ** balance;
}

const orders = {
  hot: (a, b) => hot(b) - hot(a),
  new: (a, b) => b.time - a.time,
  top: (a, b) => score(b) - score(a),
  best: (a, b) => best(b) - best(a),
  controversial: (a, b) => controversial(b) - controversial(a),
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

/** Karma: the summed score of an account's items. */
export const karma = (items) => items.reduce((total, item) => total + score(item), 0);
