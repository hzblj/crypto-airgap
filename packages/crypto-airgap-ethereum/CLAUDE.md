# @hzblj/crypto-airgap-ethereum

Ethereum's air-gap types and adapter: ERC-4527 `eth-sign-request` and `eth-signature`, for every data type: legacy
transactions (1), EIP-712 typed data as JSON (2), personal messages (3), typed transactions of types 1, 2 and 4 (4).
Parity: `@keystonehq/bc-ur-registry-eth`, Keystone 3's firmware (signing vectors), MetaMask's QR keyring, viem.

TypeScript over `@hzblj/crypto-airgap` (a dependency) and the chain client of `@hzblj/crypto-ethereum` (a dependency for
its types: the client itself is passed to `ethereumAirgap(chain)`). `@hzblj/nitro-crypto` is a peer, as everywhere: one
native module per app. A dependency rather than a peer so that a minor release of the chain package does not force a
major one here (changesets' rule for peers). It imports no native code and no other chain: decoding, signing and
verification are the chain's and the engine's; this package packages, correlates and checks.

| Path | What it is |
| --- | --- |
| `src/types.ts` | The UR types, `defineURType` over the core's schema readers. `fromCbor` checks every field. |
| `src/airgap.ts` | `ethereumAirgap(chain)`: the requester side (`encodeSignRequest`, `decodeSignResponse`), the responder side (`decodeSignRequest` for one account or every address of one, `signRequest`, `encodeSignResponse`), `watchAccount` (single keys and account keys), `pairingKey`, `accountKey`. Each answer's v: EIP-155's for a legacy transaction (as many bytes as it takes), the parity for a typed one, 27 or 28 for typed data and messages, as Keystone's firmware writes them. |
| `src/json.ts` | `readJson`: strict RFC 8259 for payloads from outside (depth limit, no duplicate keys, no NUL, no fractions, exact integers, `__proto__` as an own key). Internal. |
| `src/typed-data.ts` | `parseTypedData` (JSON or UTF-8 bytes to the adapter's `TypedDataDefinition`, a stringified payload once), `typedDataJson` (what a request carries, bigints as decimal text), and the review form (`reviewTypedData`: declared members only, bigint integers, EIP-55), which must hash to the same digest. |
| `src/version.ts` | `VERSION`, synced from package.json by `scripts/sync-versions.mjs`; a test holds them equal. |
| `test/` | Parity with the independent registry, both sides of a signing round trip through lossy multipart, and every mismatch (`ethereum.test.ts`); every data type, MetaMask's request form, Keystone's signing vectors and the JSON reader (`data-types.test.ts`). `vectors/hardware.json`: Keystone's and OneKey's own payloads, with their sources. |

## Rules

- **A response is checked against its request, never trusted for arriving:** the request id, then the signer recovered
  by the engine and compared with the account. Anything else is `REQUEST_MISMATCH`.
- **A request is checked against the signer's account** (path, fingerprint, address, chain id) before anything is shown,
  and decoding is never consent.
- **Chain errors become protocol errors:** a `CryptoError` from the chain on scanned bytes is rethrown as
  `INVALID_PROTOCOL_DATA`, with the original as its `cause`; its `CHAIN_MISMATCH` (a transaction or typed data domain
  for another chain id) as `REQUEST_MISMATCH`.
- **What is shown is what is hashed.** Typed data is hashed by the chain before it is shown, and its review form must
  hash to the same digest, or nothing is returned. Members the types do not declare are left out of it.
- **Chain ids:** a transaction request's must be the adapter's (1 when absent). Typed data and messages may leave it out
  (MetaMask's and Keystone's keyrings do); when present it must match too. A domain without a chain id is `NO_CHAIN_ID`.

Docs copy has no em dashes.
