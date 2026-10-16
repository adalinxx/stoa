# Stoa

A forum no one can censor: communities, posts with links and media, threaded
comments, votes and moderation. Stoa keeps its data on Lattice chains and has
no server of its own. Each reader's client reads the data, checks it, and
decides what to show.

- A community is a chain: `Nexus/stoa/<name>`, a child of the home chain
  `Nexus/stoa`. Anyone can create one, and communities can nest
  (`Nexus/stoa/bitcoin/lightning`).
- The home chain is a community too, `s/all`, like Reddit's r/all: anyone
  can post on it, and its page shows its own posts with every community's.
- Every record belongs to its author. Only the author can edit or delete it.
- Moderation is comments: a moderator labels a post by replying to it with
  labels. Nothing is deleted. Each reader chooses whose labels to follow and
  what each label does.
- Ranking, feeds, karma and filters are computed by the client.

## Web app

`app/` is Stoa in the browser: a static page that reads every record by CID
from a node, ranks and filters in the page, and asks the reader's Lattice
Wallet to sign each write.
It is published at https://adalinxx.github.io/stoa/app/ and reads the Stoa
trial chains (`Nexus/testnet/stoa-3dc425`) by default; see `app/README.md`.

## Records

Every key belongs to the account named in it, and that account must sign the
transaction that writes it. There are two shapes:

| Key | Owner |
|---|---|
| `user/<owner>/...` | `<owner>`: their own records |
| `index/<topic...>/<owner>` | `<owner>`: their entry under a shared topic, listed by prefix |

That rule is the chain's only rule (`policy/`). Everything below is a
convention clients share; values are JSON strings.

Stoa keeps no profile. An author's name is the `name` on their card on
Moniker, the profile chain every Lattice app shares (now the testnet trial,
`Nexus/testnet/moniker-da6f57`), else their `@handle` there; without either,
they are shown by address. The page reads cards with the
[Moniker SDK](https://github.com/adalinxx/moniker-sdk), a submodule at
`app/vendor/moniker-sdk` pinned to a release: clone with
`--recurse-submodules`, and review an upgrade like any dependency.

Home chain `Nexus/stoa`:

| Key | Value |
|---|---|
| `user/<a>/join/<community>` | `"1"`: `<a>` reads this community |
| `user/<a>/feed/<name>` | `["bitcoin", "rust"]`: a custom feed |
| `user/<a>/follow-mod/<community>/<mod>` | `"1"`: `<a>` follows an account's labels in a community |
| `index/community/<community>/<a>` | `{ about }`: `<a>` lists a community so clients can find it |

A community chain (and the home chain, as `s/all`):

| Key | Value |
|---|---|
| `user/<a>/post/<id>` | a post `{ title, body?, link?, tags? }`, or a comment `{ body, link?, labels?, on, parent? }` |
| `user/<a>/post/<id>/media/<n>` | the CID of its `<n>`th image or video |
| `index/post/<id>/<a>` | `"1"`: lists the post in the community |
| `index/comment/<author>/<id>/<commentId>/<a>` | `"1"`: lists a comment under the post it belongs to |
| `index/vote/<author>/<id>/<a>` | `"1"` or `"-1"`: one vote per voter; deleting it takes it back |
| `user/<a>/flair` | text |

A comment is a post without a title that names its post (`on`) and, when it
answers a comment, that comment (`parent`), both as `<author>/<id>`. Votes,
labels, media and edits work the same on posts and comments. Ids are random
and carry no meaning.

A listing is a claim by whoever wrote it, so a reader checks it against the
record it lists. Anything that does not parse is skipped.

## Time

A post's time is the timestamp of the block whose transaction created it.
Authors never give a time. State does not say which block wrote a key, so
`client/time.mjs` reads it from the blocks: it walks back from a tip by each
block's parent, verifying every block and transaction by CID, and records
which posts each block created. Blocks are kept by hash, so after a reorg
the times are simply those of the new tip's chain. A node keeps every block
by default; one that has dropped old blocks cannot give old times.

## Ranking

`client/rank.mjs` has Reddit's orderings from its open-source code: hot
(score magnitude plus age, a tenfold score per 12.5 hours), new, top, best
(the Wilson lower bound, for comments) and controversial; and karma, the
summed score of an account's items. A client may use others.

## Moderation

Moderation is a comment with labels: `{ body, labels: ["spam"], on, parent? }`.
It labels the comment it answers, or the post when it answers the post, and a
reason can go in its body. Nothing is removed: everyone else just sees a
comment, and the author of the label takes it back by deleting or editing it.
A report is the same thing from an account nobody follows as a moderator.

`read.labelsBy(state, account)` gathers one account's labels in a community
(one prefix scan of its items). `client/moderation.mjs` judges each item for
one reader: from the labels of the accounts they follow and the treatment
they chose per label (show, badge, blur, collapse, hide), it returns the
strongest treatment those labels ask for. A reader who follows no one sees
everything.

## Media

A post names its media by CID; the bytes stay off the chain. One file is one
Volume of one block: DAG-CBOR `{ type, bytes }`. `client/media.mjs` works
through a node's loopback operator routes, authorized by the cookie the node
writes at each start:

- The author's client pins the file's Volume on the author's node
  (`POST /pins`), which holds, serves and announces it.
- A reader's client reads it through its own node (`GET /fetch/:cid`), which
  asks peers and checks the CID; `readMedia` accepts it only if it is a type
  and size the client takes. A file it keeps it pins, and its node serves it
  too.

## Reading and writing

`client/state.mjs` reads a chain's state without trusting the node that
serves it: it takes the state root from the tip block and descends the trie,
each node checked against its CID. `view(load, root)` is the
`{ get, list }` interface the reads in `client/read.mjs` take.

`client/write.mjs` gives the `[key, value]` writes for each act (`post`,
`comment`, `vote`, `label`, …). `changes(state, writes)` turns them into
actions against the state they were read from, and `transaction(...)` is the
body to sign and send to `POST /transactions`.

## Chains

`chain/spec.json` is the spec every Stoa chain is created from; it names the
policy module by CID, and `chain/stoa_policy.wasm` is that module, built from
`policy/` (rebuild and replace both when the policy changes). A node hosts the home chain and a community with:

```sh
lattice child create Nexus/stoa --spec chain/spec.json \
  --policy-module chain/stoa_policy.wasm
lattice child create Nexus/stoa/bitcoin --spec chain/spec.json \
  --policy-module chain/stoa_policy.wasm
```

## Tests

```sh
node --test client/*.test.mjs

cd policy
cargo build --release --target wasm32-unknown-unknown
CONTEXT_DIR=target/contexts LATTICE_SDK_CORE=<lattice-sdk>/packages/core/dist/index.js \
  node --test test/policy.test.mjs
cd host-check && swift run host-check \
  ../target/wasm32-unknown-unknown/release/stoa_policy.wasm ../target/contexts
```

`host-check` replays every policy test through Lattice's own evaluator and
prints the module CID.

`e2e/ui/` drives the real page in headless Chromium against a private stack;
see `e2e/ui/README.md`.

`e2e/run.mjs` runs Stoa on two real nodes: the author's host mines the home
chain and a community, people post, comment, vote, label and report through
the public submit route, and a forged write is refused. The reader's node
joins from the author's node alone and reads the community back: posts ranked
by block time and votes, a thread as a tree, a picture fetched from peers,
and a moderator's labelled comment hiding a post for the reader who follows them.

```sh
LATTICE=<lattice-node>/.build/debug/lattice \
LATTICE_SDK=<lattice-sdk>/packages/sdk/dist/index.js node e2e/run.mjs
```
