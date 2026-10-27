# @hzblj/crypto-airgap-solana

[![npm](https://img.shields.io/npm/v/@hzblj/crypto-airgap-solana.svg)](https://www.npmjs.com/package/@hzblj/crypto-airgap-solana)
[![license](https://img.shields.io/npm/l/@hzblj/crypto-airgap-solana.svg)](https://github.com/hzblj/crypto-airgap/blob/main/LICENSE)

Solana air-gapped signing for [`@hzblj/crypto-airgap`](https://www.npmjs.com/package/@hzblj/crypto-airgap):
`sol-sign-request` and `sol-signature` (Keystone's registry, the schema OneKey documents too), for transactions
(legacy and v0 with address lookup tables, the account's own or a dApp's that others sign too), messages and off-chain
messages. Every answer is verified against its signer by
[`@hzblj/crypto-solana`](https://www.npmjs.com/package/@hzblj/crypto-solana), on the engine.

```sh
npx expo install @hzblj/crypto-airgap @hzblj/crypto-airgap-solana @hzblj/crypto-solana @hzblj/nitro-crypto react-native-nitro-modules
```

## The watch-only wallet (online)

```ts
import {createRequestId} from '@hzblj/crypto-airgap'
import {solanaAirgap} from '@hzblj/crypto-airgap-solana'

const airgap = solanaAirgap(crypto.chains.solana)
const account = airgap.watchAccount(key) // {address, path, fingerprint}

const request = {
  account,
  requestId: createRequestId(crypto.random),
  transaction: {instructions: [crypto.chains.solana.instructions.transfer({from: account.address, lamports, to})], recentBlockhash},
}
show(airgap.encodeSignRequest(request)) // the compiled message, with the account as fee payer

const answer = airgap.decodeSignResponse(scanned, {request})
if (answer.kind === 'transaction') await rpc('sendTransaction', [base64(answer.transaction.serialized), {encoding: 'base64'}])
```

The answer's signature is verified by the engine over the message before the transaction is assembled: one by
another key, or of another message, is `REQUEST_MISMATCH`, as is an answer to another request id.

```ts
// A v0 transaction, loading accounts from lookup tables (each table's address, and the addresses it holds):
const v0 = {account, requestId, transaction: {instructions, recentBlockhash, version: 0, addressLookupTables: {[table]: addresses}}}

// A dApp's wire transaction that others sign too: the signer signs its message, the answer fills the account's slot.
const request = {account, requestId, serializedTransaction: bytes}
const answer = airgap.decodeSignResponse(scanned, {request}) // {kind: 'partially-signed', transaction: {serialized, complete, signature}}

// An off-chain message (version 0 or 1), encoded here: it travels as a message, and comes back verified.
const offchain = {account, requestId, offchainMessage: {version: 1, signers: [account.address], text: 'Sign in'}}
airgap.decodeSignResponse(scanned, {request: offchain}) // {kind: 'offchain-message', message, signature}
```

## The signer (offline)

```ts
const request = airgap.decodeSignRequest(scanned, {account: {address, path, fingerprint}})

if (request.kind === 'transaction') {
  request.decoded.version // 'legacy' or 0
  request.decoded.instructions // each with a summary: transfer, token-transfer, create-token-account, compute budget, unknown
  request.decoded.accounts // a v0 message's looked-up accounts: {lookup: {lookupTable, index}, address: undefined}
  request.lamports // what the account's own transfers send
  request.warnings // ['UNKNOWN_INSTRUCTIONS', 'NOT_FEE_PAYER', 'OTHER_SIGNERS', 'UNRESOLVED_LOOKUPS']
} else if (request.kind === 'offchain-message') {
  request.decoded // {version, signers, text} (and version 0's application domain and format)
}

if (await userConfirms(request)) {
  show(airgap.encodeSignResponse(await airgap.signRequest(request, account))) // the account the request was read for
}
```

A transaction this account is not a signer of, an off-chain message it is not a signer of, or a request for another
path, wallet or address, is `REQUEST_MISMATCH`. A "message" whose bytes are a transaction this account would sign is
refused (`INVALID_PROTOCOL_DATA`): it is a transaction in disguise; so is anything that starts as a versioned
transaction this does not read (v1 and later), as a transaction or as a message.

A sign request carries the message alone, not the lookup tables a v0 message loads accounts from, and a signer offline
cannot fetch them: those accounts are shown by table and index, without an address, an instruction that uses one is
not described (`UNKNOWN_INSTRUCTIONS`), and `UNRESOLVED_LOOKUPS` says so. Signers and programs are never looked up,
so who signs and what is called are always known.

**Off-chain messages** have no sign type of their own: Keystone's registry (`@keystonehq/bc-ur-registry-sol` 0.9.5)
and its firmware codec know only transactions (1) and messages (2), and Keystone 3's firmware tells an off-chain
message from other messages by its `\xffsolana offchain` header. So they travel as messages, and the signer reads the
header: the specification's versions 0 and 1 are decoded by the chain (the account must be among the signers), and the
older format the `solana` CLI wrote (no application domain or signers, as Magic Eden's sign-in still sends it) is shown
as its text, as Keystone shows it, and signed as a message. Anything else with the header is refused.

| Interoperability | Evidence |
| --- | --- |
| `sol-sign-request`, `sol-signature` | Byte for byte `@keystonehq/bc-ur-registry-sol` 0.9.5 both ways, for transactions, messages and off-chain messages (as messages), as CBOR and as URs. |
| Messages | Legacy and v0, decoded as `@solana/kit` decodes them (through crypto-solana), and compiled back to the same bytes. A v0 transaction signed here is the one the account signs itself; a partly signed one, the one `partiallySignTransaction` makes. |
| Keystone 3 (firmware codec) | `keystone-sdk-rust`'s own payloads: its `sol-sign-request` (a 0.1 SOL transfer) and `sol-signature` byte for byte, the transfer shown to its fee payer; its `crypto-multi-accounts` watched account by account. |
| Keystone 3 (firmware) | Its app's own payloads: two v0 transactions with lookup tables read for their fee payer, the lookups said; a sign-in in the CLI's older off-chain format shown as its text and signed. |
| Hardware wallets, Solflare, Backpack | Not tested on a device or in the app. Solana keys (SLIP-0010, hardened only) have no extended public key: they pair one account at a time. |

**Not in this version:** v1 transactions (the adapter does not read them), lookup tables on the signer's side (a sign
request has no field for them), off-chain message envelopes with several signatures, and pairing types other than
`crypto-hdkey` and `crypto-multi-accounts`.

[Documentation](https://github.com/hzblj/crypto-airgap#readme) · [Security](https://github.com/hzblj/crypto-airgap/blob/main/SECURITY.md)

The other libraries from the same author are at **[libraries.janblazej.dev](https://www.libraries.janblazej.dev)**.
