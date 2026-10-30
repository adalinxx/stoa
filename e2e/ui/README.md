# UI tests

The real page (`app/`) in headless Chromium, driven through Playwright,
against a private Lattice stack (`stack.mjs`): one host mining Nexus, a Stoa
home chain and one community (Stoa's policy) and Moniker (its own policy, the
module `Nexus/moniker` launched with, in `moniker/`), all from a 2-second test
spec with a fee of 1; a sponsor (lattice-sponsor) that pays fees and keeps
files on the home chain for work; and Selfhold's window, built from
selfhold-wallet and served on localhost.

Each test is one person in a fresh browser context: Chromium's virtual
authenticator gives them a passkey in Selfhold's window, where they create an
account, connect it, and approve (or decline) each write. Nobody the page
signs for holds coins: every fee is paid by the sponsor for work, and a test
checks the account still holds nothing. Pop-ups are blocked as for anyone, so
a window not opened in a click fails a test. Accounts of other clients write
with keys the tests hold.

Covered: the community list, and what taking part takes; signing in from a
write (the draft kept, sent on the next press) and from a vote; posting,
nested comments, voting and taking a vote back, all coinless; a profile
(name, bio) on Stoa and an @handle claimed on Moniker, refused when it is
someone else's, on bylines and the profile page; an image kept for good by
the storage sponsor for this device's work, and shown; a write declined in
Selfhold's window not sent; s/all; labels hiding a post only for a reader who
follows the labeller, at once, with Show and unfollow; media nobody serves;
Top and New ordering; an earlier render finishing after a newer one without
writing over it; and a community the node does not serve shown as such.

```sh
cd e2e/ui && npm ci && npx playwright install chromium
LATTICE=<lattice-node>/.build/debug/lattice \
LATTICE_SPONSOR=<lattice-sponsor>/.build/debug/lattice-sponsor \
LATTICE_SDK=$PWD/../../app/vendor/lattice-sdk.js \
LATTICE_WALLET_WEB=<selfhold-wallet>/dist-web npm test
```

`LATTICE_SPONSOR` defaults to `lattice-sponsor` beside `lattice`. Without a
GPU (Linux CI), Chromium's SwiftShader does the work in software.

The suite runs under `node --test` with the Playwright library: Playwright
Test's runner hangs while collecting tests under Node 26 (1.48.2).
