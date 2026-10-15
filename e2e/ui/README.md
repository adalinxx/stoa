# UI tests

The real page (`app/`) in headless Chromium, driven through Playwright,
against a private Lattice stack (`stack.mjs`): one host mining Nexus, a Stoa
home chain and one community from a 2-second test spec, charging a fee of 1
like the Stoa node. Each test opens its own browser context.

Covered: the community list; the no-coins message (no faucet); posting a
link post and reading it back in its thread and the feed; nested comments;
voting and taking a vote back; a display name written to the home chain and
seen by another reader; labels hiding a post only for a reader who follows
the labeller, at once, with Show and unfollow; media a node serves and media
nobody serves; Top and New ordering; and an earlier render finishing after a
newer one without writing over it.

```sh
cd e2e/ui && npm ci && npx playwright install chromium
LATTICE=<lattice-node>/.build/debug/lattice \
LATTICE_SDK=$PWD/../../app/vendor/lattice-sdk.js npm test
```

The suite runs under `node --test` with the Playwright library: Playwright
Test's runner hangs while collecting tests under Node 26 (1.48.2).
