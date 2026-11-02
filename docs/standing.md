# Standing: Reddit without the company

Status: a proposal. `client/standing.mjs` (the computation) and
`sim/standing.mjs` (the simulation below) exist; nothing in the app uses them
yet.

## What we keep from Reddit, and what replaces the company

Reddit works because it is **topic first** (join a community and it works,
no friends needed), **strangers are judged on content** (a new account's post
can reach the top), **pseudonymous** (throwaways can speak candidly),
**cheap to curate** (lurkers upvote with one click) and **tended** (each
community has someone keeping it on topic).

What holds that together at Reddit is a company: it finds and bans vote
manipulation, and it can override any community. Stoa has no company, and
accounts cost nothing, so a raw vote count is anyone's to buy with fresh
accounts. Standing replaces the company: votes count only from accounts the
community has engaged with, as each reader's own client computes it.

## Communities and views

- A community is a chain, as now. Nobody owns it.
- A **view** is how a client reads a community: its **seeds** (the accounts
  standing starts from) and its parameters. A view is a record anyone can
  publish:

  | Key | Value |
  |---|---|
  | `user/<a>/view/<name>` | `{ seeds: [account], restart?, epsilon?, gate? }` |

- A community's **default view** is named by its listing on the home chain:
  `index/community/<community>/<a>` gains `view: "<a>/<name>"`. A new
  community's founder seeds it, as a subreddit's creator does.
- **Anyone can fork a view**: publish another with other seeds, and share it
  (`…/app/?view=<a>/<name>`). Readers switch with one click and keep every
  post and reply, since a view decides only what counts, never what exists.
  Seeds cannot delete anything; the only power a view has is being chosen.
- Moderators are gone as a role: `follow-mod` records are dropped. A view's
  seeds are regular accounts; their labels count because they have
  standing, like anyone's.

## Records

| Key | Value | Change |
|---|---|---|
| `user/<a>/edges/<n>` | `{ up: ["<author>/<id>"], down: [...], reply: [...] }`: the account's votes and replies, a bucket of at most 64 entries; taking a vote back removes it | replaces `index/vote/<author>/<id>/<a>` |
| `user/<a>/post/<id>` | a post or reply, as now | a reply with `labels` is a label, not a vouch |
| `user/<a>/view/<name>` | a view | new |

`follow-mod` and `index/vote/` go. These changes are in the policy, which a
chain's spec fixes at genesis, so they ship together in one relaunch of the
home and community chains (see Relaunch).

Downvotes stay: a label says what an item is and changes how it is shown;
a downvote says it adds little and only moves it down. Votes move under the
voter, in a few records rather than one key each, so that "everything this
account vouched for" is one or two Volumes, which is what the standing
computation reads (see Read cost); each edge names the author, so a reader
never reads the post to follow its edge to its author.

## Standing

Personalized PageRank over a graph of accounts and posts, from the view's
seeds:

- An account points at each post it upvoted (weight 1), each post it
  replied to without labels (weight 2), and each account it follows on
  [Follows](https://github.com/adalinxx/follows), the follow graph every app
  shares (`follows/<a>/<t>`, weight 4). A follow is the plainest vouch
  there is, and it is how an account that only reads and upvotes becomes a
  member: when members follow it.
- A post points at its author.
- A walker starts at a seed, follows an edge in proportion to its weight, and
  with probability `restart` (0.15) starts again at a seed. Standing is the
  share of time it spends at each account or post.

Fresh accounts get standing only through edges from accounts that have it:
however many of them there are, and however they vote for each other, a farm
holds no more than what honest accounts' own edges lead into it.

`client/standing.mjs` computes it by local push (Andersen, Chung and Lang): it
reads an account's edges only while that account's undistributed share is
over `epsilon`, so it reads at most about 1 / (restart × epsilon) accounts
however large the community grows, and it reads them in rounds, each round's
accounts at once (one `/volumes?cids=` batch per round).

## Ranking: standing as a gate, not a weight

An account is a **member** when it is among the accounts that together hold
1 − δ (δ = 0.02) of all accounts' standing: sort accounts by standing, keep
them until they hold 98% of it. The rule scales with the community, and a
farm cannot move it, since its accounts each hold almost nothing and sit in
the tail it cuts (see The gate rule). A post's score
is members' upvotes less members' downvotes. Hot, top, best, controversial
and new keep Reddit's formulas from `client/rank.mjs` over members' votes.

Downvotes rank items; they never cost an author standing. If they did, a
group of members could vote someone out of the community; standing is made
only of what people vouch for.

Using standing as a weight instead concentrates the ranking on the seeds'
own taste (see below); as a gate, every member's vote counts the same, as on
Reddit, and non-members' count for nothing.

What a non-member gets: their posts and replies show in **new**, and one
upvote or reply from a member lifts them like any other post; their upvotes
count once members engage with what they post. Speaking is free; influence
is earned in the community.

Labels: an item's labels apply when members gave them, each reader choosing
what each label does, as now.

## Simulation

`node sim/standing.mjs`: 500 honest accounts (5 seeds, 40 newcomers with one
good post and 3 upvotes each), 2000 posts with a quality in [0, 1]; honest
accounts upvote and reply with odds rising with quality. A farm of fresh
accounts upvotes 5 spam posts and each other's posts; a few careless honest
accounts upvote spam too, the farm's only way in. Each cell: raw votes /
standing-weighted votes / members' votes (gate 1e-4).

| Farm | Careless upvotes into it | Spam in top 25 | Top-25 mean quality | Farm accounts through the gate |
|---|---|---|---|---|
| none | – | 0 / 0 / 0 | 0.97 / 0.89 / 0.97 | – |
| 100 | 50 | 5 / 0 / 0 | 0.77 / 0.89 / 0.97 | 5 of 100 |
| 1000 | 50 | 5 / 0 / 0 | 0.77 / 0.89 / 0.97 | 3 of 1000 |
| 10000 | 0 | 9 / 0 / 0 | 0.62 / 0.89 / 0.97 | 0 of 10000 |
| 10000 | 50 | 9 / 0 / 0 | 0.62 / 0.89 / 0.97 | 5 of 10000 |

- Raw votes: a farm of 100 takes first place; 10,000 take 9 of the top 25.
- Members' votes: no spam in the top 25 in any case, and the same quality as
  raw votes with no farm at all. 414 of 500 honest accounts are members.
- A gate of 1e-5 is too low: with 50 careless upvotes, 32 of a farm of 100
  got through and took 5 places.
- Newcomers' posts land at the same percentile among honest posts (about the
  42nd) under every rule: standing costs them nothing over raw votes.

Read cost (farm of 1000, 5 careless upvotes):

| Community | epsilon | Accounts read | Rounds | Top 25 as exact |
|---|---|---|---|---|
| 500 accounts, 3045 posts | 1e-3 | 204 | 11 | 23 / 25 |
| 500 accounts, 3045 posts | 1e-4 | 462 | 19 | 25 / 25 |
| 2000 accounts, 12180 posts | 1e-4 | 1537 | 18 | 25 / 25 |

## The gate rule

`node sim/gate.mjs`: communities of 250 to 2000 honest accounts, farms of
1000 and 10,000, careless upvotes into the farm from 10% of honest accounts.
Three rules: a fixed gate (1e-4), the mass cut, and a gate scaled by the
community's effective size (c / N_eff, N_eff = 1 / Σ p²).

| Honest accounts | Honest members: fixed 1e-4 | mass cut δ=0.02 | c/N_eff, c=0.05 |
|---|---|---|---|
| 250 | 86% | 74% | 71% |
| 500 | 83% | 75% | 57% |
| 1000 | 73% | 72% | 31% |
| 2000 | 58% | 71% | 12% |

- Only the mass cut holds steady as the community grows.
- No rule lets the farm's own accounts in, but the five authors of the spam
  posts get in under the fixed gate and the mass cut once real members have
  upvoted their posts, as the rule intends.
- At 2000 honest accounts with 200 of them upvoting spam (40 real member
  votes on each spam post), spam reaches the top 25 under every rule. That
  is members liking spam, which no vote count can stop; labels are for that.
  The farm's own votes count for nothing.

## Newcomers and lurkers

`node sim/newcomers.mjs`, under the mass cut:

| Honest accounts | Member upvotes on a newcomer's post | Newcomers who become members | Lurkers who become members |
|---|---|---|---|
| 500 | 3 / 10 / 30 / 100 | 1 / 4 / 38 / 40 of 40 | 0 of 100 |
| 2000 | 3 / 10 / 30 / 100 | 2 / 9 / 138 / 160 of 160 | 0 of 100 |

- A newcomer's posts and replies count like anyone's from the start (a post
  is ranked by the members who upvote it, whoever wrote it). Their **votes**
  count once they are a member: about one post 30 members upvoted, or the
  same engagement across several posts and replies.
- **Lurkers never become members through posts** (the simulation has no
  follows). With follows as edges, a lurker becomes a member when members
  follow them; an account upvoting, answering or following itself passes
  nothing (it would only feed its standing back to it); a farm following itself gains nothing, and a member following
  a farm account is a careless edge like a careless upvote.
- Without follows, **lurkers never become members.** An account that only upvotes has no
  edges into it, so its votes never count. This is the price of resisting
  farms: standing reaches an account only through what members do with what
  it wrote, and a lurker writes nothing. Most of Reddit's votes are
  lurkers'; here the ranking is made by those who take part.
- What would let lurkers count, and what it costs:
  - **Credit to early upvoters** (a post passes some standing back to those
    who upvoted it before members did): rewards good curation, but a few
    accounts upvoting everything early collect it; bounded in total, not
    per account, so a small farm can concentrate it. Needs a simulation of
    that attack before it is worth considering.
  - **Non-members' votes, capped per post** (say at two members' worth):
    lurkers' votes break ties and lift rising posts; a farm gets the same
    cap on its spam, which is little. Simple, and the farm's gain is bounded
    by the cap whatever its size.
  - **A vouch**: a member vouches for an account they know. Not Reddit-like.

## Relaunch

Testnet only, so the posts on today's Stoa chains are let go rather than
migrated. One relaunch carries every policy change: votes under the voter
(upvotes only), views, and dropping `follow-mod` and `index/vote/`. New genesis gives the chains new paths (`stoa-<hash>`), so
everything naming them moves together: the chain specs on the Mac node, the
fleet's hosted chains in lattice-ops, the sponsors' terms, and Stoa's
defaults.

## Read cost

Measured against the live trie layout (each trie node is its own Volume;
a synthetic community rebuilt in that exact layout, since the live chains
hold too few accounts), with the live node's latency (about 45 ms per
request):

| Read | Volumes | Requests | Time |
|---|---|---|---|
| standing, cold, votes as one key each (`user/<a>/vote/…`), batched | 16,979 | 610 | 2.7–5.7 s |
| standing, cold, one edges record per account, batched | 1,200 | 63 | 1.5 s |
| a return visit: Merkle diff since the last visit (5% of accounts wrote) | 73 | 7 | 0.4 s |
| a return visit, 30% wrote | 305 | 15 | 0.4 s |

- **A key costs a Volume.** Accounts share only the top few trie nodes, so
  reading 460 accounts' votes key by key is about 17,000 Volumes. Batching
  turns that into about 600 requests but not fewer round trips, and a burst
  that size meets the node's rate limit (HTTP 429, seen live).
- **So an account's edges are one record**, not one key per vote:
  `user/<a>/edges/<n>` → its upvotes and replies, in buckets so a vote
  rewrites a bounded record (about 3 KB at 40 votes). That cuts a cold
  computation 14 times in Volumes and 10 times in requests. The vote itself
  is the edge: an upvote is a write to the voter's current bucket, and a
  reply is listed there as well as being its own post.
- **A return visit reads what changed.** Comparing the last visit's state
  root with the tip, a client walks only subtrees whose CIDs differ, and so
  finds exactly which accounts wrote (checked exact against a full
  comparison on live chains). The page keeps each account's decoded edges
  and the push state (estimates and residuals), applies the changed
  accounts' edges, and resumes the push from there: dynamic forward push
  (Zhang, Lofgren and Goel, KDD 2016), which reads only changed and newly
  due accounts.
- **A first visit** still pays the cold read: about 1.5 s with edges
  records, behind the saved or raw-vote feed shown at once.
- **Node-side, not yet measured**: serving each `user/<a>/` subtree as one
  Volume would give edges-record costs while keeping one key per record,
  and raising the 32-root cap toward the 4 MiB body bound would cut
  requests further.
- **The IndexedDB cache is slower than the network at this scale**: about
  0.8 ms per cached Volume (a transaction and a "used" write per lookup),
  so re-walking 17,000 cached Volumes takes about 14 s. Caching decoded
  edges rather than trie nodes avoids it, and the cache's lookups should be
  batched into one transaction.

## Costs and open questions

- **Reads are the price**; see Read cost.
- **Lurkers' votes** don't count (see Newcomers and lurkers); a choice
  between the options there is open.
- **A new community** has only its founder's standing to start from, which
  matters until members engage; anyone can fork its view from the start.
- **Every write is approved in Selfhold's window**, votes included, as
  now: the page never holds a key.
- **Storage** stays one small record per vote, now without a second copy of
  the author's CID in an index.
- The simulation's honest users vote on quality alone and its farm is
  simple; real voting is noisier, and a patient attacker would post good
  content to earn membership first. That is what any reputation system
  trades: membership costs real contribution, which is the point.
