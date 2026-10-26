# Compatibility

| | Version | Notes |
| --- | --- | --- |
| `@hzblj/nitro-crypto` | 0.1.2 or later | A peer dependency: the engine that signs and verifies. 0.1.2 has extended public keys and public derivation. |
| `@hzblj/crypto-bitcoin`, `-ethereum`, `-solana` | 0.2.0 or later | Dependencies of the chain packages: PSBTs, transaction parsing, message decoding. |
| React Native, Expo | As `@hzblj/nitro-crypto` | The packages are TypeScript without native code; the engine sets the floor ([its compatibility](https://github.com/hzblj/nitro-crypto/blob/main/docs/compatibility.md)). `@hzblj/crypto-airgap` alone runs in any JavaScript engine. |
| Node.js | 22 | For the tooling and the tests (on the engine as WebAssembly, `@hzblj/nitro-crypto/testing`). |

## What was tested

What `@hzblj/crypto-airgap` and its chain packages were tested against, and what they were not. A row says
"fixture" when the evidence is an independent implementation's output, and "device" only for a physical device.

| Type | Evidence | Kind |
| --- | --- | --- |
| UR, Bytewords, multipart (fountain codes) | Blockchain Commons' bc-ur (C++) test vectors: CRC-32, Bytewords, Xoshiro256**, sampler, shuffle, degrees, fragments, parts, single-part and multipart URs. `@ngraveio/bc-ur` 1.1.13: the same part strings, both ways, on random payloads, with lost parts. | Fixture |
| `crypto-hdkey`, `crypto-keypath`, `crypto-coin-info`, `crypto-eckey`, `crypto-multi-accounts` | `@keystonehq/bc-ur-registry` 0.8.1: the same CBOR both ways; its master and private keys refused. | Fixture |
| `crypto-account`, `crypto-output` | BCR-2020-015's example (seven descriptors) decodes key for key and re-encodes to the same UR. Keystone's form (descriptors without `#6.308`) reads; Keystone's registry reads neither the specification's form nor `tr` and `cosigner`. | Fixture |
| `crypto-psbt` | `@keystonehq/bc-ur-registry`'s `CryptoPSBT`: the same CBOR and UR. The PSBTs: `@scure/btc-signer` 2.4.1 reads ours, finalizes what we sign, and its signatures finalize here. | Fixture |
| `eth-sign-request`, `eth-signature` (ERC-4527) | `@keystonehq/bc-ur-registry-eth` 0.22.1: the same CBOR and URs both ways; a request it writes is answered here. viem 2.57.11 recovers the signers and reads the transactions. | Fixture |
| `sol-sign-request`, `sol-signature` | `@keystonehq/bc-ur-registry-sol` 0.9.5: the same CBOR and URs both ways, for transactions and messages. `@solana/kit` 8.5.0 decodes the messages the same way. | Fixture |
| Extended public keys | BIP-32's published xpubs at every depth, and `@scure/bip32` 2.4.0 on random paths: the engine's account keys and public derivation. Keystone's registry reads our `crypto-account` and `crypto-hdkey` as the same xpubs; viem's `mnemonicToAccount` agrees on MetaMask's. | Fixture |
| Keystone 3 (firmware codec) | `keystone-sdk-rust`'s own test payloads: `crypto-hdkey` (and the xpub it reads it as), `crypto-account` with single keys and a multisig written without `#6.308`, `crypto-multi-accounts` with an Ethereum account key and Solana keys, `eth-sign-request` (legacy and EIP-1559), `eth-signature`, a 0.1 SOL `sol-sign-request`, `sol-signature`. Each reads, writes back byte for byte where the codec does, and the keys are watched at the addresses `@scure/bip32` derives. | Fixture |
| Keystone (device) | Its developer documentation's `crypto-hdkey` for MetaMask decodes to the xpub it documents, and its `eth-signature` reads. | Fixture |
| OneKey | Its QR wallet gallery's EVM account key is watched; its master key, whole and in two parts, is refused (`PRIVATE_KEY_MATERIAL`). | Fixture |
| Sparrow | The `crypto-account` it imports (BCR-2020-015's form, with `#6.308`), and PSBTs it would send: three inputs at different addresses of the account with change, signed and finalized against `@scure/btc-signer`. | Fixture |
| MetaMask | The `crypto-hdkey` its QR keyring reads (children `0/*`, the note `account.standard`, read through Keystone's registry as its keyring does), and requests for any address below it. | Fixture |
| Any of these on a physical device or app | Not tested: no hardware wallet, Sparrow or MetaMask was paired while building this. | None |

The example pairs and signs with itself (two phones, or one in its Loopback tab), and shows pairing codes for Sparrow
and MetaMask. Fixtures are the formats these wallets write, taken from their own sources and test suites (each
`test/vectors` file says where); a device or app may still differ from its own fixtures, and that is what the rows
marked "None" leave open.
