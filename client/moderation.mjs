// What a reader's client does with labels. A label removes nothing from the
// chain: it says what an item is, and the reader decides what each label
// does. Labels count from a community's members, as votes do
// (docs/standing.md), and the reader's own always apply for them.

/** The treatments, weakest first; an item gets the strongest its labels ask for. */
export const treatments = ["show", "badge", "blur", "collapse", "hide"];

/**
 * The labels that apply, as `judge` takes them: a Map from account to its
 * applying labels by item. A label applies once more members gave it than
 * upvoted the item, so one member can label what no member stands behind,
 * and an item members like takes as many to label it. `setsBy` maps each
 * account read to its edges as sets (`read.edgeSets`); `counts` admits the
 * members; `votes` is their tally (`read.tally`). The reader's own labels
 * (`own`, a Map from item to labels) apply for them whatever others say.
 */
export function memberLabels(setsBy, counts, votes, { reader, own } = {}) {
  const givers = new Map(); // item → label → members
  for (const [a, { label }] of setsBy) {
    if (!counts(a) || a === reader) continue;
    for (const [item, labels] of label) {
      const byLabel = givers.get(item) ?? givers.set(item, new Map()).get(item);
      for (const l of labels) (byLabel.get(l) ?? byLabel.set(l, []).get(l)).push(a);
    }
  }
  const applied = new Map();
  const give = (a, item, l) => {
    const byItem = applied.get(a) ?? applied.set(a, new Map()).get(a);
    byItem.set(item, [...(byItem.get(item) ?? []), l]);
  };
  for (const [item, byLabel] of givers) {
    const ups = votes.get(item)?.ups ?? 0;
    for (const [l, accounts] of byLabel) if (accounts.length > ups) for (const a of accounts) give(a, item, l);
  }
  if (reader !== undefined) for (const [item, labels] of own ?? []) for (const l of labels) give(reader, item, l);
  return applied;
}

/**
 * A judge for items: `judge({ author, id })` is `{ treatment, labels }`,
 * `labels` being every `{ by, label }` that applies. `labelSets` maps each
 * account whose labels apply to them by item, as `memberLabels` makes them;
 * `actions` maps a label to a treatment, and a label it does not name gets
 * `otherwise`.
 */
export function judge(labelSets, actions, { otherwise = "badge" } = {}) {
  return ({ author, id }) => {
    const labels = [];
    for (const [by, labelled] of labelSets) {
      for (const label of labelled.get(`${author}/${id}`) ?? []) labels.push({ by, label });
    }
    let strongest = 0;
    for (const { label } of labels) {
      const treatment = actions[label] ?? otherwise;
      strongest = Math.max(strongest, treatments.indexOf(treatment));
    }
    return { treatment: treatments[strongest], labels };
  };
}
