// What a reader's client does with the marks of the moderators it follows.
// A mark removes nothing from the chain; it only asks this client to treat
// an item a certain way, and the reader decides what each label does.

/** The treatments, weakest first; an item gets the strongest its labels ask for. */
export const treatments = ["show", "badge", "blur", "collapse", "hide"];

/**
 * A judge for items: `judge({ author, id })` is `{ treatment, labels }`,
 * `labels` being every `{ mod, label }` that applies (item marks and marks
 * on the author's account). `markSets` maps each followed moderator to its
 * marks as `read.marks` returns them; `actions` maps a label to a treatment,
 * and a label it does not name gets `otherwise`.
 */
export function judge(markSets, actions, { otherwise = "badge" } = {}) {
  return ({ author, id }) => {
    const labels = [];
    for (const [mod, { items, accounts }] of markSets) {
      for (const label of items.get(`${author}/${id}`) ?? []) labels.push({ mod, label });
      for (const label of accounts.get(author) ?? []) labels.push({ mod, label });
    }
    let strongest = 0;
    for (const { label } of labels) {
      const treatment = actions[label] ?? otherwise;
      strongest = Math.max(strongest, treatments.indexOf(treatment));
    }
    return { treatment: treatments[strongest], labels };
  };
}
