# @hzblj/crypto-airgap-bitcoin

Bitcoin's air-gap types and adapter: `crypto-psbt` both ways (P2WPKH and Taproot, BIP-371), `crypto-output` and
`crypto-account` for accounts (`wpkh` for BIP-84, `tr` for BIP-86). Parity: BCR-2020-015's example,
`@keystonehq/bc-ur-registry`, Keystone 3's firmware `crypto-account`, `@scure/btc-signer` through crypto-bitcoin.

TypeScript over `@hzblj/crypto-airgap` (a dependency) and the chain client of `@hzblj/crypto-bitcoin` (a dependency for
its types: the client itself is passed to `bitcoinAirgap(chain)`). `@hzblj/nitro-crypto` is a peer, as everywhere: one
native module per app. A dependency rather than a peer so that a minor release of the chain package does not force a
major one here (changesets' rule for peers). It imports no native code and no other chain: decoding, signing and
verification are the chain's and the engine's; this package packages, correlates and checks.

| Path | What it is |
| --- | --- |
| `src/types.ts` | The UR types, `defineURType` over the core's schema readers. `fromCbor` checks every field. |
| `src/airgap.ts` | `bitcoinAirgap(chain)`: the requester side (`encodeSignRequest`, `decodeSignResponse`), the responder side (`decodeSignRequest` for one account or every address of one, `signRequest`, `encodeSignResponse`), `watchAccount` (single keys and account keys, its type by its purpose), `pairingKey`, `accountKey`, `encodeAccount`, `encodeOutput`, `decodeAccount` (`crypto-account` or `crypto-output`). A Taproot coin is the signer's by its Taproot derivation and BIP-86 address; `signRequest` derives each key as its type. |
| `src/version.ts` | `VERSION`, synced from package.json by `scripts/sync-versions.mjs`; a test holds them equal. |
| `test/` | Parity with the independent registry, both sides of a signing round trip through lossy multipart, and every mismatch (`bitcoin.test.ts`); Taproot accounts and PSBTs, mixed with P2WPKH (`taproot.test.ts`). `vectors/`: BCR-2020-015's example, Keystone's firmware codec and its `crypto-account` for Sparrow. |

## Rules

- **A response is checked against its request, never trusted for arriving:** the same unsigned transaction and coins
  (else `REQUEST_MISMATCH`), then every signature verified by the engine as the chain finalizes (else
  `INVALID_PROTOCOL_DATA`).
- **A request is checked against the signer's account** (path, fingerprint, address, coins) before anything is shown,
  and decoding is never consent. A key the PSBT names counts only when it pays the coin: BIP-84's hash for P2WPKH,
  BIP-86's tweak for Taproot.
- **No message signing over UR** until there is a common type: Keystone's `btc-sign-request` is one vendor's, legacy
  only (README, "Not in this version").
- **Chain errors become protocol errors:** a `CryptoError` from the chain on scanned bytes is rethrown as
  `INVALID_PROTOCOL_DATA`, with the original as its `cause`.

Docs copy has no em dashes.
