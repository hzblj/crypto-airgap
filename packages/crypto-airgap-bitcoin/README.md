# @hzblj/crypto-airgap-bitcoin

[![npm](https://img.shields.io/npm/v/@hzblj/crypto-airgap-bitcoin.svg)](https://www.npmjs.com/package/@hzblj/crypto-airgap-bitcoin)
[![license](https://img.shields.io/npm/l/@hzblj/crypto-airgap-bitcoin.svg)](https://github.com/hzblj/crypto-airgap/blob/main/LICENSE)

Bitcoin air-gapped signing for [`@hzblj/crypto-airgap`](https://www.npmjs.com/package/@hzblj/crypto-airgap): PSBTs
(BIP-174, with BIP-371's Taproot fields) travel as `crypto-psbt` both ways, and accounts as `crypto-account` or
`crypto-output`, native SegWit (`wpkh`) and Taproot (`tr`, BIP-86) alike. It packages and checks;
[`@hzblj/crypto-bitcoin`](https://www.npmjs.com/package/@hzblj/crypto-bitcoin) builds, signs and finalizes, and the
engine verifies every signature.

```sh
npx expo install @hzblj/crypto-airgap @hzblj/crypto-airgap-bitcoin @hzblj/crypto-bitcoin @hzblj/nitro-crypto react-native-nitro-modules
```

## The watch-only wallet (online)

```ts
import {bitcoinAirgap} from '@hzblj/crypto-airgap-bitcoin'
import {createMultipartDecoder, createMultipartEncoder} from '@hzblj/crypto-airgap'

const airgap = bitcoinAirgap(crypto.chains.bitcoin)

// The signer's account, from the key it shared (crypto-multi-accounts, crypto-hdkey, crypto-account or crypto-output):
// an account's extended key (m/84'/1'/0', or m/86'/1'/0' for Taproot) at any receiving address, or one address's key.
const account = airgap.watchAccount(key, masterFingerprint, 3) // its fourth receiving address, P2WPKH or P2TR by its path
// or crypto.chains.bitcoin.watchAccount({extendedKey, path, fingerprint, change, index})

const plan = account.createTransaction({amount: 25_000n, feeRate: 2, to, utxos})
const psbt = account.createPsbt(plan, {previousTransactions}) // each coin's previous transaction, by txid: optional

const {sha256} = crypto.hash // the engine's SHA-256, which the fountain code seeds its parts with
const sender = createMultipartEncoder(airgap.encodeSignRequest({psbt}), {sha256}) // show sender.nextPart(), part after part
const receiver = createMultipartDecoder({allowedTypes: airgap.responseTypes, sha256}) // feed it what the camera reads

const {transaction} = airgap.decodeSignResponse(receiver.result(), {request: psbt})
await fetch(`${esplora}/tx`, {body: transaction.hex, method: 'POST'})
```

`decodeSignResponse` refuses (`REQUEST_MISMATCH`) a PSBT of another transaction than the one sent, or one that
changed the coins it spends, and then finalizes it through the chain: every input must carry a signature by the key
its coin pays, which the engine verifies over this transaction (`INVALID_PROTOCOL_DATA` otherwise). Only then is
there a transaction to broadcast.

## The signer (offline)

```ts
// Every receiving and change address of the accounts, as Sparrow and other coordinators spend from them:
const request = airgap.decodeSignRequest(scanned, {fingerprint: wallet.fingerprint, accountPath: ["m/84'/1'/0'", "m/86'/1'/0'"]})
request.keys // [{path, publicKey, addressType}]: the keys its inputs need, each checked against the coin it spends
request.outputs // each with its address, value, and `change` when it pays the account back
request.fee // satoshis, when every input states its value
request.warnings // ['UNVERIFIED_VALUES', …]

if (await userConfirms(request)) {
  // Each key derived at its path as its type, checked against the PSBT's, signs its inputs: P2WPKH and Taproot alike.
  const answer = await airgap.signRequest(request, (path, addressType) =>
    wallet.deriveAccount({addressType, chain: 'bitcoin', path})
  )
  showAnimated(airgap.encodeSignResponse(answer))
}
```

One account (`{account}`, a `BitcoinAccount` with its key) signs the same way, with `account.signPsbt`. A request that
spends none of the account's coins, names a key under the wallet's fingerprint that does not pay the coin it spends,
or places the account's key in another wallet or path, is `REQUEST_MISMATCH`. Decoding is not consent: the signer
shows the request and asks before signing.

A Taproot coin is the account's when the PSBT's BIP-371 Taproot derivation (`PSBT_IN_TAP_BIP32_DERIVATION`, an
x-only key with no leaf hashes) names a key below a Taproot account path under the wallet's fingerprint, and BIP-86's
output of that key is the coin's script; a P2WPKH coin, by its BIP-32 derivation and its key's hash. A PSBT may spend
both: each key signs its own inputs, and `decodeSignResponse` finalizes them together, every signature verified by the
engine. A Taproot signature commits to the value of every coin the transaction spends, so a coordinator that misstates
one makes it invalid; `UNVERIFIED_VALUES` still says when coins come without their previous transactions.

| Warning | Meaning |
| --- | --- |
| `UNVERIFIED_VALUES` | Some of the account's coins come without their previous transaction: their values, and so the fee, are the coordinator's word. Pass `previousTransactions` to `createPsbt` to remove it. |
| `FOREIGN_INPUTS` | Some inputs spend other keys' coins, which this account does not sign. |
| `UNKNOWN_FEE` | An input does not state its value. |
| `NO_ADDRESS_OUTPUT` | An output pays a script with no address (an `OP_RETURN`, a bare script). |

## Accounts

```ts
// What Sparrow imports from an airgapped signer, as Keystone shows it: account keys, wpkh for BIP-84, tr for BIP-86.
const keys = ["m/84'/1'/0'", "m/86'/1'/0'"].map(path =>
  airgap.accountKey({extendedKey: wallet.extendedPublicKey(path), fingerprint, path})
)
const ur = airgap.encodeAccount({masterFingerprint: fingerprint, keys}) // crypto-account: Sparrow offers each as a wallet
airgap.encodeOutput(keys[1]) // one account as a crypto-output, tr([fingerprint/86'/1'/0']tpub…)

const {accounts, descriptors} = airgap.decodeAccount(scanned) // a crypto-account or a crypto-output
airgap.pairingKey(account) // one address's key for crypto-multi-accounts or crypto-hdkey, with its path
```

`crypto-account` and `crypto-output` read every single-key and multisig descriptor of BCR-2020-010 (`sh`, `wsh`, `pk`,
`pkh`, `wpkh`, `combo`, `tr`, `cosigner`, `multi`, `sortedmulti`), and the specification's own example decodes to its
seven descriptors, key for key. `accounts` are the ones this network can watch: `wpkh` at BIP-84 paths and `tr` at
BIP-86 paths, account keys (`m/84'/c'/a'`, `m/86'/c'/a'` with a chain code, as Sparrow and hardware wallets share
them) watched at their first receiving address through the engine's public derivation, and single keys at full paths.
`encodeAccount` and `encodeOutput` write a key's descriptor by its purpose, as Keystone's firmware does: `wpkh` for
84', `tr` for 86', and refuse other purposes. The extended key needs an engine with `bip32-public-derivation`
([nitro-crypto's ADR 0007](https://github.com/hzblj/nitro-crypto/blob/main/docs/adr/0007-extended-public-keys.md)),
and Taproot one with `taproot-tweak` and `secp256k1-schnorr`.

Descriptors are written inside `#6.308`, as the specification's example is. Keystone's JavaScript registry
(`@keystonehq/bc-ur-registry` 0.8.1) writes them without it and reads neither form with `tr` or `cosigner`; both forms
read here.

| Interoperability | Evidence |
| --- | --- |
| `crypto-psbt` | Byte for byte `@keystonehq/bc-ur-registry`'s `CryptoPSBT`, as CBOR and as a UR. PSBTs signed here, P2WPKH and Taproot, finalize in `@scure/btc-signer` to the same transaction, and its signatures finalize here. |
| `crypto-account` | BCR-2020-015's example (with its `tr` descriptor) decodes and re-encodes to the same UR; Keystone's form reads, and Keystone's registry reads an account key written here as the xpub `@scure/bip32` derives. Keystone 3's firmware codec (`keystone-sdk-rust`): its test account, with a multisig, reads in both forms. Keystone 3's firmware `crypto-account` for Sparrow (BIP-84, 44, 49 and 86, `tr` among them): its native SegWit and Taproot accounts are watched at BIP-84's and BIP-86's published addresses, and the keys written here for the same phrase are Keystone's. |
| Coordinators | A PSBT `@scure/btc-signer` builds as Sparrow would (three addresses of the account, change to a fourth; or a P2WPKH and a Taproot coin with Taproot change, BIP-371's fields) signs key by key and finalizes there. |
| Hardware wallets, Sparrow | Not tested on a device or in the app. The PSBTs are standard BIP-174 version 0, with BIP-32 derivations and, when given, previous transactions. |

**Not in this version:** PSBT version 2, Taproot script paths (and key paths under a script tree: only BIP-86 keys are
recognized), P2SH-wrapped inputs, multisig signing, BCR-2023's text `output-descriptor` and `account-descriptor`, and
message signing over QR codes. For the last, no common UR type exists: the only one is Keystone's own `btc-sign-request`
and `btc-signature` (tags 8101 and 8102, `@keystonehq/bc-ur-registry-btc` 0.1.1), which carries one vendor's legacy
signatures (Keystone 3's firmware answers with a compressed-key header, 31 to 34, whatever the address type, so
nothing BIP-322 and nothing for Taproot); Sparrow does not use it, and SeedSigner signs messages from a text QR code.
`@hzblj/crypto-bitcoin` signs and verifies BIP-322 and legacy messages directly.

[Documentation](https://github.com/hzblj/crypto-airgap#readme) · [Security](https://github.com/hzblj/crypto-airgap/blob/main/SECURITY.md)

The other libraries from the same author are at **[libraries.janblazej.dev](https://www.libraries.janblazej.dev)**.
