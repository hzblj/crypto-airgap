# @hzblj/crypto-airgap-solana

Solana's air-gap types and adapter: Keystone's `sol-sign-request` and `sol-signature`, for transactions (legacy and
v0, the account's own or several signers'), messages and off-chain messages (as messages, by their header: the
registry has no other sign type). Parity: `@keystonehq/bc-ur-registry-sol`, Keystone 3's firmware payloads,
`@solana/kit` through crypto-solana.

TypeScript over `@hzblj/crypto-airgap` (a dependency) and the chain client of `@hzblj/crypto-solana` (a dependency for
its types: the client itself is passed to `solanaAirgap(chain)`). `@hzblj/nitro-crypto` is a peer, as everywhere: one
native module per app. A dependency rather than a peer so that a minor release of the chain package does not force a
major one here (changesets' rule for peers). It imports no native code and no other chain: decoding, signing and
verification are the chain's and the engine's; this package packages, correlates and checks.

| Path | What it is |
| --- | --- |
| `src/types.ts` | The UR types, `defineURType` over the core's schema readers. `fromCbor` checks every field. |
| `src/airgap.ts` | `solanaAirgap(chain)`: the requester side (`encodeSignRequest` for a transaction built here, a wire transaction made elsewhere, a message or an off-chain message; `decodeSignResponse`, which fills a wire transaction's slot), the responder side (`decodeSignRequest`, `signRequest`, `encodeSignResponse`), `watchAccount`, `pairingKey`. The CLI's older off-chain format is read for its text only. |
| `src/version.ts` | `VERSION`, synced from package.json by `scripts/sync-versions.mjs`; a test holds them equal. |
| `test/` | Parity with the independent registry, both sides of a signing round trip through lossy multipart, and every mismatch (`solana.test.ts`); v0, partly signed transactions, off-chain messages and Keystone's firmware payloads (`versions.test.ts`). `vectors/keystone.json`: Keystone's firmware codec and app. |

## Rules

- **A response is checked against its request, never trusted for arriving:** the request id, then the signature verified
  by the engine as the chain assembles the transaction. Anything else is `REQUEST_MISMATCH`.
- **A request is checked against the signer's account** (path, fingerprint, address) before anything is shown, and
  decoding is never consent.
- **Nothing that could be a transaction is signed as a message:** a transaction this account signs, or anything that
  starts as a versioned transaction this does not read (first byte 0x81 to 0xbf), is refused as a message.
- **Unresolved is said, never guessed:** a v0 message's looked-up accounts stay `undefined` on the signer, with
  `UNRESOLVED_LOOKUPS`.
- **Chain errors become protocol errors:** a `CryptoError` from the chain on scanned bytes is rethrown as
  `INVALID_PROTOCOL_DATA`, with the original as its `cause`.

Docs copy has no em dashes.
