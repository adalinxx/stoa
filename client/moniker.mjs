// Names come from Moniker, the profile chain every Lattice app shares: an
// account's card is `user/<a>/profile` there. Stoa keeps no profile of its
// own. Cards are written by anyone, so a value that does not parse is left
// out, never fatal.

/** Where Moniker lives, unless the reader chose another chain in Settings. */
export const MONIKER_CHAIN = "Nexus/moniker";

/** The display name on `a`'s Moniker card (trimmed, at most 40 characters), or undefined. */
export async function cardName(state, a) {
  let card;
  try {
    card = JSON.parse(await state.get(`user/${a}/profile`));
  } catch {
    return undefined;
  }
  const name = typeof card?.name === "string" ? card.name.trim().slice(0, 40) : "";
  return name || undefined;
}
