# UI tests

The real page (`app/`) in headless Chromium, driven through Playwright,
against a private Lattice stack (`stack.mjs`): one host mining Nexus, a Stoa
home chain and one community from a 2-second test spec, charging a fee of 1
like the Stoa node. Each test opens its own browser with the real Lattice
Wallet extension loaded (Chrome's `--headless=new`, which runs extensions);
an account's key is imported into that wallet, whose node is set to the
stack's (the copy loaded is allowed to reach 127.0.0.1, as the wallet's
Allow button would grant), the test connects by clicking
Connect wallet, and every approval window the wallet opens is answered
(Connect or Sign, or Decline where a test says so) and counted.

Covered: the community list; a visitor without the wallet told to install
it (keeping their draft, and when they vote); the no-coins message before
writing (no faucet); a write declined in the wallet not sent; a community the
node does not serve shown as such, not as empty; writes shown at once as
pending and settling when their block lands; posting a
link post and reading it back in its thread and the feed; nested comments;
voting and taking a vote back; a display name written to the home chain and
seen by another reader; labels hiding a post only for a reader who follows
the labeller, at once, with Show and unfollow; media a node serves and media
nobody serves; Top and New ordering; and an earlier render finishing after a
newer one without writing over it.

```sh
cd e2e/ui && npm ci && npx playwright install chromium
LATTICE=<lattice-node>/.build/debug/lattice \
LATTICE_SDK=$PWD/../../app/vendor/lattice-sdk.js \
LATTICE_WALLET=<lattice-wallet>/dist npm test
```

The suite runs under `node --test` with the Playwright library: Playwright
Test's runner hangs while collecting tests under Node 26 (1.48.2).
