// Which standing makes an account a member, as the community grows: a fixed
// gate, a cut at a share of all accounts' standing, or a gate scaled by the
// community's effective size (1 / Σ p², which a farm of accounts with almost
// no standing each barely moves).
//
//   node sim/gate.mjs
import { standing } from "../client/standing.mjs";
import { community, edgesOf, measure, ranked } from "./community.mjs";

const isAccount = (id) => /^(h|sy)\d/.test(id);

const rules = {
  "fixed 1e-4": () => 1e-4,
  ...Object.fromEntries(
    [0.02, 0.05].map((delta) => [
      `mass cut δ=${delta}`,
      (accounts) => {
        // The members hold 1 − δ of all account standing; the gate is the
        // last one's standing.
        const sorted = accounts.map(([, p]) => p).sort((a, b) => b - a);
        const total = sorted.reduce((sum, p) => sum + p, 0);
        let held = 0;
        for (const p of sorted) if ((held += p) >= (1 - delta) * total) return p;
        return 0;
      },
    ]),
  ),
  ...Object.fromEntries(
    [0.05, 0.1, 0.2].map((c) => [
      `c/N_eff c=${c}`,
      (accounts) => {
        const total = accounts.reduce((sum, [, p]) => sum + p, 0);
        const effective = total ** 2 / accounts.reduce((sum, [, p]) => sum + p * p, 0);
        return (c * total) / effective;
      },
    ]),
  ),
};

console.log("| honest | farm | rule | spam in top 25 | top-25 quality | honest members | newcomer members | farm members |");
console.log("|---|---|---|---|---|---|---|---|");
for (const honest of [250, 500, 1000, 2000]) {
  for (const sybils of [1000, 10000]) {
    const careless = Math.round(honest / 10);
    const { posts, graph, voters, seeds, newcomers } = community({ honest, sybils, careless });
    const { standing: s } = await standing(seeds, edgesOf(graph), { epsilon: 1e-6 });
    const accounts = [...s].filter(([id]) => isAccount(id));
    for (const [name, rule] of Object.entries(rules)) {
      const gate = rule(accounts);
      const member = (id) => (s.get(id) ?? 0) >= gate && gate > 0;
      const m = measure(posts, ranked(posts, (id) => voters.get(id).filter(member).length));
      const honestIn = [...Array(honest).keys()].filter((i) => member(`h${i}`)).length;
      const newIn = [...Array(newcomers).keys()].filter((i) => member(`h${honest - newcomers + i}`)).length;
      const farmIn = [...Array(sybils).keys()].filter((i) => member(`sy${i}`)).length;
      console.log(
        `| ${honest} | ${sybils} | ${name} | ${m.spamInTop} | ${m.topQuality.toFixed(2)} | ${Math.round((100 * honestIn) / honest)}% | ${newIn}/${newcomers} | ${farmIn} |`,
      );
    }
  }
}
