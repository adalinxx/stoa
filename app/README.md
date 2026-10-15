# Stoa web app

A static page: open `app/index.html` from any static host (it imports `../client/`). It reads every record by CID from the node in Settings (by default the Stoa trial node, `https://lattice-testnet-stoa.fly.dev`), ranks and filters in the page, and asks the Lattice Wallet extension to sign: the reader connects it once, and approves each post, comment, vote and label in the wallet. Reading needs no wallet. Media is shown when some node serves it; attaching media needs your own node.

```sh
python3 -m http.server 8765   # from the repository root, then open http://127.0.0.1:8765/app/
```
