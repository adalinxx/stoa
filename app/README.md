# Stoa web app

A static page: open `app/index.html` from any static host (it imports `../client/`, and the Moniker SDK from the submodule `vendor/moniker-sdk` for names). It reads every record by CID from the node in Settings (by default the shared testnet apps node, `https://lattice-testnet-apps-iad.fly.dev`), ranks and filters in the page, and signs with Selfhold (`vendor/selfhold.mjs`, `@selfhold/web` built from selfhold-wallet; MIT, see `vendor/selfhold.LICENSE`): Sign in opens Selfhold's window, where a passkey makes or opens the reader's account, and each post, comment, vote, label and profile change is approved there. Settings can switch to Selfhold for Chrome when it is installed. Reading needs no account.

Taking part needs no coins. Each fee is paid by the fee sponsor (Moniker's, by default) for a moment of this device's work, which Selfhold's window does; a post's image or video is kept for good by the storage sponsor for work this page does on the device's GPU (else its CPU). Both sponsors are under Settings › Advanced. The reader's profile (name, about, link) is kept on Stoa's chain; their @handle is claimed and shown on Moniker from the same dialog, approved in Selfhold's window. Every byline links to the author's profile page: their posts, comments and karma.

What a write takes is said before it is made. Once the wallet has sent it, a post, comment or vote shows at once as waiting for its block, and settles when the block lands; a failure is said beside what failed and stays until dismissed. A refresh never reorders the feed under the reader: rows keep their places until the sort or the view changes. When the node cannot serve a community, the page says so, with Try again and Choose another node, instead of showing an empty feed. The fonts ship in `app/fonts/` (SIL Open Font License), so no font host sees who reads.

```sh
python3 -m http.server 8765   # from the repository root, then open http://127.0.0.1:8765/app/
```
