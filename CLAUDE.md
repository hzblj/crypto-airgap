# crypto-airgap

Turborepo + Yarn 4 workspaces for **`@hzblj/crypto-airgap`** and its chain packages: air-gapped signing as data (BC-UR
v2, typed and bounded decoding, answers checked against their questions) for React Native and Expo. The engine, the
keys and the chain adapters are [`@hzblj/nitro-crypto`](https://github.com/hzblj/nitro-crypto)'s, taken from npm.

Every package has its own `CLAUDE.md`: read that one before touching it.

| Path | Package | What lives there |
| --- | --- | --- |
| `packages/crypto-airgap/` | `@hzblj/crypto-airgap` | The protocol: Bytewords, CBOR, fountain multipart, the typed registry, public key types. Headless, no native code, no dependencies. ADR 0001. |
| `packages/crypto-airgap-bitcoin/`, `-ethereum/`, `-solana/` | `@hzblj/crypto-airgap-*` | Each chain's UR types and air-gap adapter, bound to that chain's client from npm: requests out, answers checked, signer-side review, account keys for pairing, signing for any address of an account. |
| `apps/example/` | `crypto-airgap-example` (private) | Expo Router app built with `@hzblj/kara-ui`: Signer (the offline side), Watch-only (the online side), Loopback (both on one phone). Runs the packages from **source**. Maestro flows in `e2e/`. See its `CLAUDE.md`. |
| `scripts/` | | `pack-check.mjs`, `sync-versions.mjs`. |
| `docs/` | | Compatibility and the decisions (`adr/`). `SECURITY.md` is at the root. |

Dependencies point down: example → `@hzblj/crypto-airgap-<chain>` → (`@hzblj/crypto-airgap`, that chain's adapter from
npm) → `@hzblj/nitro-crypto` (a peer, from npm). The core imports nothing; QR codes, the camera and animation timers are
the app's, never the packages'. A package here never imports another chain's package.

## Commands

```bash
yarn test                    # every workspace's tests, on @hzblj/nitro-crypto/testing (the engine as WebAssembly)
yarn typecheck / yarn lint   # tsc, Biome
yarn pack:check              # what npm receives, and a consumer type-check
yarn ios / yarn android      # the example (dev client), Metro included
yarn example e2e ios|android # Maestro on the booted simulator or the emulator, Metro running
yarn changeset               # describe a change for the next release
```

## Conventions that bite

**The engine comes from npm.** `@hzblj/nitro-crypto` and `@hzblj/crypto-<chain>` are ordinary dependencies at the
versions in each `package.json`. A change the packages need there is a release of nitro-crypto first, then a version
bump here. Their published `exports` have no `source` condition; the tests here run with `--conditions=source` and
reach only this repository's sources.

**The example runs the packages' source; the world runs `build/`.** Every package's `exports` names a `source` entry,
which the example's `metro.config.js` maps and its `tsconfig.json` mirrors with `paths`. `publishConfig.exports` is the
published map without it, and the pack check refuses a tarball that names it.

**Native views need a native parent.** Kara's native atoms (`LabeledContent`, `Button`, `TextField`) live in an
`Island`, and inside a native stack only native children or Fragments.

**What a registry does not have, a package does not invent.** A request type, a data type or a field travels only
when an independent wallet's registry has it (Keystone's, ERC-4527, BCR's): Solana off-chain messages go as messages,
Bitcoin message signing waits for a common type, lookup tables stay off the signer. Each package's README says what
was left out and why.

**Chain packages depend on their chain's adapter, not peer on it,** so that a minor release of the adapter does not
force a major one here (changesets' rule for peers). `@hzblj/nitro-crypto` stays a peer: one native module per app.

**Publish through Yarn, tag through changesets.** `yarn release` builds, runs `yarn npm publish` in every public
workspace and then `changeset tag`. Never `changeset publish`: its npm call would ship `workspace:` ranges verbatim.
`changeset:version` also syncs each package's `src/version.ts`.

**Docs copy has no em dashes.** Not in the READMEs, the JSDoc in `src/` (it is the API reference), changesets or the
example's captions. Rewrite with a comma, a colon, parentheses or a second sentence. Code comments are exempt.

**Commits are Jan's alone.** Author `Jan Blazej <hello@janblazej.dev>` (set locally in this repo), no co-author or
generated-by lines.

Code style is Biome-enforced (`@hzblj/biome-config`): 2 spaces, 120 cols, single quotes, no semicolons, sorted imports
and object keys. Named exports and `const` arrow functions; `type` over `interface`.
