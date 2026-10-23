# Stoa web app

A static page: open `app/index.html` from any static host (it imports `../client/`, and the Moniker SDK from the submodule `vendor/moniker-sdk` for names). It reads every record by CID from the node in Settings (by default the shared testnet apps node, `https://lattice-testnet-apps-iad.fly.dev`), ranks and filters in the page, and asks the Lattice Wallet extension to sign: the reader connects it once, and approves each post, comment, vote and label in the wallet. Reading needs no wallet. Media is shown when some node serves it; attaching media needs your own node.

What a write costs is shown before it is made. Once the wallet has sent it, a post, comment or vote shows at once as waiting for its block, and settles when the block lands; a failure is said beside what failed and stays until dismissed. A refresh never reorders the feed under the reader: rows keep their places until the sort or the view changes. When the node cannot serve a community, the page says so, with Try again and Choose another node, instead of showing an empty feed. The fonts ship in `app/fonts/` (SIL Open Font License), so no font host sees who reads.

```sh
python3 -m http.server 8765   # from the repository root, then open http://127.0.0.1:8765/app/
```
