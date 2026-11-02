# Standing: Reddit without the company

Votes count only from a community's **members**, as each reader's own client
computes them. `client/standing.mjs` is the computation; `sim/` holds the
simulations below.

## Why

Reddit works because it is **topic first** (join a community and it works,
no friends needed), **strangers are judged on content** (a new account's post
can reach the top), **pseudonymous** and **cheap to curate** (one click to
upvote). What holds that together at Reddit is a company: it finds and bans
vote manipulation. Stoa has no company, and accounts cost nothing, so a raw
vote count is anyone's to buy with fresh accounts. Standing replaces the
company: a vote counts once the community has vouched for the voter.

Stoa has few mechanisms, and each does many jobs:

1. **Communities**: a chain each; what you follow is your home feed.
2. **Posts and comments.**
3. **Votes**: an upvote vouches; a downvote ranks an item down and, past the
   upvotes, collapses it. Neither is weighted.
4. **Follows**: an account following another vouches for it.
5. **Standing**: members are the accounts the first posters' upvotes and
   follows reach.

Ranking, spam resistance, collapsing what doesn't belong, newcomers and
lurkers all come from these. There are no moderators, labels or tags.

## Records

| Key | Value |
|---|---|
| `user/<a>/edges/<n>` | `{ up: ["<author>/<id>"], down: [...] }`: the account's votes, a bucket of at most 64 entries; taking a vote back removes it |
| `follows/<a>/<t>` on [Follows](https://github.com/adalinxx/follows) | `<a>` follows `<t>`, an account or `@handle` |

Votes are kept under the voter, in a few records rather than one key each,
so that "everything this account vouched for" is one or two Volumes, which is
what the standing computation reads (see Read cost). Each entry names the
item's author, so a reader never reads the post to follow its edge to its
author. The records are under the voter's own key, which the policy already
allows: no policy change.

## Standing

Personalized PageRank over a graph of accounts and posts, from the
community's **seeds**, the authors of its first five posts (a post's time is
held to its block, so nobody can claim to have come earlier later):

- An account points at each post it upvoted and each account it follows,
  every edge alike. A follow is the plainest vouch there is, and it is how an
  account that only reads and upvotes becomes a member: members follow it.
- A post points at its author.
- Upvoting or following oneself passes nothing: it would only feed an
  account's standing back to it.
- Replying vouches for nothing: an argument would feed whoever started it.
- Downvotes are not edges. They rank items and never cost anyone standing; if
  they did, a group of members could vote someone out of the community.
- A walker starts at a seed, follows an edge, and with probability 0.15
  starts again at a seed. Standing is the share of time it spends at each
  account or post.

Fresh accounts get standing only through edges from accounts that have it:
however many of them there are, and however they vote for each other, a farm
holds no more than what members' own edges lead into it.

`client/standing.mjs` computes it by local push (Andersen, Chung and Lang): it
reads an account's edges only while that account's undistributed share is
over epsilon (1e-4), so it reads at most about 1 / (0.15 × epsilon) nodes
however large the community grows, in rounds, each round's accounts at once.
At most 64 records of 64 entries are read per account, past what an honest
writer keeps.

## Members, scores and collapsing

An account is a **member** when it is among the accounts that together hold
98% of all accounts' standing, largest first (ties at the cut kept). The
rule scales with the community, and a farm cannot move it: its accounts each
hold almost nothing and sit in the 2% tail (see The gate rule).

- An item's score is members' upvotes less members' downvotes. Hot, new and
  top use Reddit's formulas (`client/rank.mjs`) over it.
- What members downvoted more than upvoted is **collapsed**, for every
  reader, to one line with Show; a reader who voted on it sees it as is.
- Standing is a gate, not a weight: every member's vote counts the same, as
  on Reddit. As a weight it concentrates the ranking on the seeds' own taste.
- A non-member's posts and comments show like anyone's, ranked by the
  members who upvote them; their votes count once members upvote what they
  write or follow them. Speaking is free; influence is earned.

## Simulation

`node sim/standing.mjs`: 500 honest accounts (5 seeds, 40 newcomers with one
good post and 3 upvotes each), 2000 posts with a quality in [0, 1]; honest
accounts upvote with odds rising with quality. A farm of fresh accounts
upvotes 5 spam posts and each other's posts; a few careless honest accounts
upvote spam too, the farm's only way in. Each cell: raw votes /
standing-weighted votes / members' votes (gate 1e-4).

| Farm | Careless upvotes into it | Spam in top 25 | Top-25 mean quality | Farm accounts through the gate |
|---|---|---|---|---|
| none | – | 0 / 0 / 0 | 0.97 / 0.90 / 0.97 | – |
| 100 | 50 | 5 / 0 / 0 | 0.78 / 0.90 / 0.97 | 5 of 100 |
| 1000 | 50 | 5 / 0 / 0 | 0.78 / 0.90 / 0.97 | 5 of 1000 |
| 10000 | 0 | 8 / 0 / 0 | 0.66 / 0.90 / 0.97 | 0 of 10000 |
| 10000 | 50 | 8 / 0 / 0 | 0.66 / 0.90 / 0.97 | 5 of 10000 |

- Raw votes: a farm of 100 takes first place; 10,000 take 8 of the top 25.
- Members' votes: no spam in the top 25 in any case, and the same quality as
  raw votes with no farm at all. 412 of 500 honest accounts are members.
- The farm accounts that get through are the five authors of the spam posts,
  once careless members upvoted them, as the rule intends.
- Newcomers' posts land at the same percentile among honest posts (about the
  42nd) under every rule: standing costs them nothing over raw votes.

Read cost (farm of 1000, 5 careless upvotes):

| Community | epsilon | Accounts read | Rounds | Top 25 as exact |
|---|---|---|---|---|
| 500 accounts, 3045 posts | 1e-3 | 189 | 9 | 23 / 25 |
| 500 accounts, 3045 posts | 1e-4 | 469 | 15 | 25 / 25 |
| 2000 accounts, 12180 posts | 1e-4 | 1534 | 18 | 22 / 25 |

## The gate rule

`node sim/gate.mjs`: communities of 250 to 2000 honest accounts, farms of
1000 and 10,000, careless upvotes into the farm from 10% of honest accounts.
Three rules: a fixed gate (1e-4), the mass cut, and a gate scaled by the
community's effective size (c / N_eff, N_eff = 1 / Σ p²).

| Honest accounts | Honest members: fixed 1e-4 | mass cut δ=0.02 | c/N_eff, c=0.05 |
|---|---|---|---|
| 250 | 88% | 75% | 71% |
| 500 | 83% | 76% | 56% |
| 1000 | 74% | 73% | 30% |
| 2000 | 58% | 72% | 10% |

- Only the mass cut holds steady as the community grows.
- No rule lets the farm's own accounts in beyond the spam posts' authors.
- At 2000 honest accounts with 200 of them upvoting spam (40 real member
  votes on each spam post), spam reaches the top 25 under every rule. That
  is members liking spam, which no vote count can stop; members' downvotes
  collapse it once more of them downvote than upvote.

## Newcomers and lurkers

`node sim/newcomers.mjs`, under the mass cut:

| Honest accounts | Member upvotes on a newcomer's post | Newcomers who become members | Lurkers who become members |
|---|---|---|---|
| 500 | 3 / 10 / 30 / 100 | 1 / 9 / 39 / 40 of 40 | 0 of 100 |
| 2000 | 3 / 10 / 30 / 100 | 2 / 41 / 157 / 160 of 160 | 0 of 100 |

- A newcomer's posts count like anyone's from the start (a post is ranked by
  the members who upvote it, whoever wrote it). Their **votes** count once
  they are a member: about one post 30 members upvoted, or the same across
  several posts.
- **Lurkers become members only through follows** (the simulation has
  none): an account that only upvotes has no edges into it until members
  follow it. Most of Reddit's votes are lurkers'; here the ranking is made by
  those who take part or whom members follow.

## Read cost

Measured against the live trie layout (each trie node is its own Volume;
a synthetic community rebuilt in that exact layout, since the live chains
hold too few accounts), with the live node's latency (about 45 ms per
request):

| Read | Volumes | Requests | Time |
|---|---|---|---|
| standing, cold, votes as one key each, batched | 16,979 | 610 | 2.7–5.7 s |
| standing, cold, one edges record per account, batched | 1,200 | 63 | 1.5 s |
| a return visit: Merkle diff since the last visit (5% of accounts wrote) | 73 | 7 | 0.4 s |
| a return visit, 30% wrote | 305 | 15 | 0.4 s |

- **A key costs a Volume.** Accounts share only the top few trie nodes, so
  reading 460 accounts' votes key by key is about 17,000 Volumes, and a burst
  that size meets the node's rate limit (HTTP 429, seen live).
- **So an account's votes are a few records**, in buckets of 64 so a vote
  rewrites a bounded record (about 3 KB at 40 votes). That cuts a cold
  computation 14 times in Volumes and 10 times in requests. The cost is that
  a vote rewrites a record: the page waits for the reader's last vote on a
  chain to land before building the next.
- **A return visit could read only what changed** (not built): comparing
  the last visit's state root with the tip, a client walks only subtrees
  whose CIDs differ, finds exactly which accounts wrote, applies their edges
  and resumes the push: dynamic forward push (Zhang, Lofgren and Goel, KDD
  2016).
- **The IndexedDB cache is slower than the network at this scale**: about
  0.8 ms per cached Volume (a transaction and a "used" write per lookup).
  Its lookups should be batched into one transaction.

## Costs and open questions

- **Reads are the price**; see Read cost.
- **Lurkers' votes** count only once members follow them.
- **A new community** starts from its first five posters' standing, which
  matters until members engage.
- **Every write is approved in Selfhold's window**, votes included: the page
  never holds a key.
- The simulation's honest users vote on quality alone and its farm is
  simple; real voting is noisier, and a patient attacker would post good
  content to earn membership first. That is what any reputation system
  trades: membership costs real contribution, which is the point.
