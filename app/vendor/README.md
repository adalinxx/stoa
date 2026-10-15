`lattice-sdk.js` is `@adalinxx/lattice-sdk` bundled for the browser (ESM, its
`@noble` dependencies included):

```sh
printf 'export * from "<lattice-sdk>/packages/sdk/dist/index.js";\n' > entry.mjs
npx esbuild@0.24.0 entry.mjs --bundle --format=esm --platform=browser --minify --outfile=lattice-sdk.js
```
