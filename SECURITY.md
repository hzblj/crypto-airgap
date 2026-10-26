# Security

> [!WARNING]
> **Not security audited. Do not use with real funds.** crypto-airgap is a foundation and a demonstration: its
> payloads are the standard ones and its checks are real, but no independent party has reviewed this code, and no
> hardware wallet was paired with it while it was built.

## Reporting a vulnerability

Please report privately, through GitHub's [private vulnerability reporting](https://github.com/hzblj/crypto-airgap/security/advisories/new)
on this repository, not in a public issue. Include what you found, how to reproduce it, and which version. You will get
an acknowledgement, and a fix or an explanation, as soon as it can be worked out; a confirmed issue is disclosed in the
changelog and a GitHub advisory once a fixed version is published.

Keys, signatures and their verification are [`@hzblj/nitro-crypto`](https://github.com/hzblj/nitro-crypto)'s engine:
report anything about them there.

## What the packages protect

`@hzblj/crypto-airgap` and its chain packages move signing requests, public accounts and signatures between a
watch-only wallet and an offline signer as QR codes ([ADR 0001](docs/adr/0001-air-gap-as-data.md)). They hold no
key and sign nothing; what they add is a channel, and these are its rules:

- **Everything scanned is hostile.** Decoders take an allowlist of types and bounds on message size, fragments, parts
  per message, pending parts, CBOR depth and items; lengths are checked against the bytes present before anything is
  allocated, and CBOR is read strictly. Parsers of what is to be signed (PSBTs, RLP, Solana messages) are the chain
  adapters', strict too, and fuzzed with random mutations.
- **No secrets travel.** Seed and private key UR types are refused whatever an allowlist says, as are master and
  private `crypto-hdkey`s, private `crypto-eckey`s, and key data that is a private key's. What a wallet shares to
  pair is public keys with their paths, or an account's extended public key (never the master's, never a private
  one): enough to watch every address of that account, which is why the example says so where it shows one.
- **A checksum is not a signature.** Bytewords' CRC-32 and the fountain code's checksum catch misreads; they say
  nothing about who made a payload. Authenticity comes from the chain: a response is accepted only when it answers
  its request (the same request id, the same unsigned transaction and coins) and its signature, verified by the
  engine, is by the account asked.
- **Decoding is not consent.** A signer checks a request against its own account (path, master fingerprint,
  address, chain id) and shows what it does (recipients and amounts, change, the fee, ERC-20 transfers, Solana
  instruction summaries) before the app asks the user. Warnings say what a signer cannot check: Bitcoin coin values
  without their previous transactions (the fee a coordinator could misstate), inputs or instructions it does not
  recognize, other signers. A "message" that is a Solana transaction is refused.
- **Nothing is logged.** Errors carry codes and messages that never quote a payload.

Not covered: what the camera, the screen and the person do. A QR code can be photographed, a screen recorded, and a
request shown on a compromised watch-only device can lie about where its funds go; the signer's own review is the
only one that counts. Interoperability claims are limited to what [compatibility](docs/compatibility.md) lists.

## The example app

The example keeps its recovery phrase in the Keychain (Keystore on Android) behind Face ID or the device passcode,
derives keys in the engine only while unlocked, and wipes them after a minute in the background. That is the least a
signer should do, not an audited design; it talks to Sepolia, Bitcoin testnet4 and Solana devnet only, and its Signer
tab talks to no network at all.
