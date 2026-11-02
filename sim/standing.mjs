// A community and a sybil farm, ranked by raw upvotes (Reddit's count) and
// by standing (client/standing.mjs), to see what each lets a farm do and
// what standing costs to read.
//
//   node sim/standing.mjs
//
// Honest accounts join over time; the first few are the community view's
// seeds. Each honest post has a quality in [0, 1]; honest accounts upvote
// posts with odds rising with quality. The last accounts to join
// are newcomers with one good post and a few upvotes. A farm of fresh
// accounts upvotes its own spam posts and each other's; a few careless
// honest accounts upvote a spam post too (the farm's only edges in).
import { standing } from "../client/standing.mjs";
import { community, edgesOf, measure, ranked, SEEDS, TOP } from "./community.mjs";

const HONEST = 500;
const NEWCOMERS = 40;
const POSTS = 2000;
/** The standing over which a vote counts in full, for the gated count. */
const GATE = Number(process.env.GATE ?? 1e-4);

const rows = [];
for (const sybils of [0, 100, 1000, 10000]) {
  for (const careless of sybils === 0 ? [0] : [0, 5, 50]) {
    const { posts, graph, upvotes, voters, seeds } = community({ sybils, careless });
    const raw = measure(posts, ranked(posts, (id) => upvotes.get(id)));
    const { standing: s } = await standing(seeds, edgesOf(graph), { epsilon: 1e-5 });
    const byStanding = measure(posts, ranked(posts, (id) => s.get(id)));
    // Each upvote counted by its voter's standing.
    const weighted = measure(posts, ranked(posts, (id) => voters.get(id).reduce((sum, v) => sum + (s.get(v) ?? 0), 0)));
    // Standing as a gate: one full vote for each voter over GATE, none under.
    const counts = (v) => (s.get(v) ?? 0) >= GATE;
    const gated = measure(posts, ranked(posts, (id) => voters.get(id).filter(counts).length));
    const honestIn = [...Array(HONEST).keys()].filter((i) => counts(`h${i}`)).length;
    const farmIn = [...Array(sybils).keys()].filter((i) => counts(`sy${i}`)).length;
    const sybilShare = [...s].filter(([id]) => id.startsWith("sy") || id.startsWith("spam")).reduce((sum, [, v]) => sum + v, 0);
    rows.push({ sybils, careless, raw, byStanding, weighted, gated, honestIn, farmIn, sybilShare });
  }
}

console.log(`${HONEST} honest accounts (${SEEDS} seeds, ${NEWCOMERS} newcomers), ${POSTS} posts; top ${TOP}.\n`);
console.log(`Each cell: raw votes / post standing / standing-weighted votes / votes gated at standing ≥ ${GATE}.\n`);
console.log("| sybils | careless upvotes in | spam in top 25 | first spam at | top-25 mean quality | newcomer median percentile (honest posts) | accounts through the gate: honest, farm |");
console.log("|---|---|---|---|---|---|---|");
for (const { sybils, careless, raw, byStanding, weighted, gated, honestIn, farmIn } of rows) {
  const four = (f) => [raw, byStanding, weighted, gated].map(f).join(" / ");
  console.log(
    `| ${sybils} | ${careless} | ${four((m) => m.spamInTop)} | ${four((m) => (m.firstSpam === 0 ? "–" : m.firstSpam))} | ${four((m) => m.topQuality.toFixed(2))} | ${four((m) => m.newcomerPercentile)} | ${honestIn}/${HONEST}, ${farmIn}/${sybils} |`,
  );
}

// Read cost: nodes whose edges a reader fetches, against how close the top
// stays to the exact ranking, as the community grows.
console.log("\n| community | epsilon | nodes read | accounts read | rounds (batches) | top 25 same as exact |");
console.log("|---|---|---|---|---|");
for (const scale of [1, 4]) {
  const { posts, graph, seeds } = (() => {
    if (scale === 1) return community({ sybils: 1000, careless: 5 });
    // A bigger community: the same shape, four of them joined through the seeds.
    const parts = [1, 2, 3, 4].map((seed) => community({ sybils: 1000, careless: 5, seed }));
    const posts = new Map(), graph = new Map();
    parts.forEach((part, n) => {
      const rename = (id) => `${n}:${id}`;
      for (const [id, post] of part.posts) posts.set(rename(id), { ...post, author: rename(post.author) });
      for (const [id, out] of part.graph) graph.set(rename(id), out.map(([t, w]) => [rename(t), w]));
    });
    return { posts, graph, seeds: parts.flatMap((part, n) => part.seeds.map((s) => `${n}:${s}`)) };
  })();
  const exactStanding = (await standing(seeds, edgesOf(graph), { epsilon: 1e-8 })).standing;
  const exactTop = new Set(ranked(posts, (id) => exactStanding.get(id)).slice(0, TOP));
  for (const epsilon of [1e-3, 1e-4, 1e-5]) {
    let rounds = 0;
    const counted = async (ids) => (rounds++, edgesOf(graph)(ids));
    const { standing: s, read } = await standing(seeds, counted, { epsilon });
    const same = ranked(posts, (id) => s.get(id)).slice(0, TOP).filter((id) => exactTop.has(id)).length;
    const accounts = [...s.keys()].filter((id) => /(^|:)(h|sy)\d/.test(id)).length;
    console.log(`| ${posts.size} posts, ${graph.size} nodes | ${epsilon} | ${read} | ${accounts} | ${rounds} | ${same} / ${TOP} |`);
  }
}
