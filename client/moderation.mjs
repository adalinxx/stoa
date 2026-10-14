// What a reader's client does with the labels of the accounts it follows as
// moderators. A label is a comment: it removes nothing from the chain, it
// only asks this client to treat an item a certain way, and the reader
// decides what each label does.

/** The treatments, weakest first; an item gets the strongest its labels ask for. */
export const treatments = ["show", "badge", "blur", "collapse", "hide"];

/**
 * A judge for items: `judge({ author, id })` is `{ treatment, labels }`,
 * `labels` being every `{ by, label }` that applies. `labelSets` maps each
 * account the reader follows as a moderator to its labels as
 * `read.labelsBy` returns them; `actions` maps a label to a treatment, and a
 * label it does not name gets `otherwise`.
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
