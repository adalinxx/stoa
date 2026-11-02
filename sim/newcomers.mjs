// How much engagement from members makes a newcomer a member, and what
// becomes of lurkers (accounts that only upvote), under the mass-cut gate.
//
//   node sim/newcomers.mjs
import { standing } from "../client/standing.mjs";
import { community, edgesOf } from "./community.mjs";

const DELTA = 0.02;
const isAccount = (id) => /^(h|sy|l)\d/.test(id);

/** The mass-cut gate: members hold 1 − δ of all account standing. */
function gateOf(s) {
  const sorted = [...s].filter(([id]) => isAccount(id)).map(([, p]) => p).sort((a, b) => b - a);
  const total = sorted.reduce((sum, p) => sum + p, 0);
  let held = 0;
  for (const p of sorted) if ((held += p) >= (1 - DELTA) * total) return p;
  return 0;
}

console.log("| honest | upvotes on a newcomer's one post | newcomer members | lurker members |");
console.log("|---|---|---|---|");
for (const honest of [500, 2000]) {
  for (const newcomerUpvotes of [3, 10, 30, 100]) {
    const { graph, seeds, newcomers } = community({ honest, newcomerUpvotes, lurkers: 100 });
    const { standing: s } = await standing(seeds, edgesOf(graph), { epsilon: 1e-6 });
    const gate = gateOf(s);
    const member = (id) => (s.get(id) ?? 0) >= gate;
    const newIn = [...Array(newcomers).keys()].filter((i) => member(`h${honest - newcomers + i}`)).length;
    const lurkIn = [...Array(100).keys()].filter((i) => member(`l${i}`)).length;
    console.log(`| ${honest} | ${newcomerUpvotes} | ${newIn}/${newcomers} | ${lurkIn}/100 |`);
  }
}
