# @hzblj/crypto-airgap-ethereum

[![npm](https://img.shields.io/npm/v/@hzblj/crypto-airgap-ethereum.svg)](https://www.npmjs.com/package/@hzblj/crypto-airgap-ethereum)
[![license](https://img.shields.io/npm/l/@hzblj/crypto-airgap-ethereum.svg)](https://github.com/hzblj/crypto-airgap/blob/main/LICENSE)

Ethereum and EVM air-gapped signing for [`@hzblj/crypto-airgap`](https://www.npmjs.com/package/@hzblj/crypto-airgap):
ERC-4527's `eth-sign-request` and `eth-signature`, for every data type it has: legacy transactions, EIP-712 typed data,
`personal_sign` messages, and typed transactions (EIP-2930, EIP-1559, EIP-7702). Every answer is checked by recovering
its signer with [`@hzblj/crypto-ethereum`](https://www.npmjs.com/package/@hzblj/crypto-ethereum), on the engine.

```sh
npx expo install @hzblj/crypto-airgap @hzblj/crypto-airgap-ethereum @hzblj/crypto-ethereum @hzblj/nitro-crypto react-native-nitro-modules
```

## The watch-only wallet (online)

```ts
import {createRequestId} from '@hzblj/crypto-airgap'
import {ethereumAirgap} from '@hzblj/crypto-airgap-ethereum'

const airgap = ethereumAirgap(crypto.chains.sepolia)
const account = airgap.watchAccount(key) // {address, path, fingerprint}, from the key the signer shared
airgap.watchAccount(key, undefined, 5) // an account's extended key (m/44'/60'/0'): its sixth address, m/…/0/5

const request = {
  account,
  origin: 'My Wallet',
  requestId: createRequestId(crypto.random), // fresh for every request
  transaction: {to, value, nonce, gas, maxFeePerGas, maxPriorityFeePerGas},
}
show(airgap.encodeSignRequest(request)) // eth-sign-request, data type 4 (a typed transaction)

const answer = airgap.decodeSignResponse(scanned, {request})
if (answer.kind === 'transaction') await rpc('eth_sendRawTransaction', [answer.transaction.serialized])
```

`transaction` is any request the Ethereum adapter signs: EIP-1559 by default, `type: 'legacy'` (EIP-155, data type 1),
`'eip2930'` or `'eip7702'` (data type 4), with access lists, and `to: null` to create a contract. A legacy
transaction's answer carries v as EIP-155's `chainId × 2 + 35 + parity`, in as many bytes as it takes (as Keystone
writes it); a typed one's, the y parity. Both read here.

```ts
// EIP-712, in viem's shape (eth_signTypedData_v4's): it travels as JSON, data type 2, bigints as decimal text.
show(airgap.encodeSignRequest({account, requestId, typedData: {domain, types, primaryType, message}}))
const answer = airgap.decodeSignResponse(scanned, {request}) // {kind: 'typed-data', signature}, v as 27 or 28

// A dApp's JSON as it came, every digit kept: parseTypedData reads it strictly (see below).
const typedData = parseTypedData(params[1])
```

A message goes the same way with `message` (data type 3). Typed data and messages come back as 65-byte signatures, v
as 27 or 28. An answer with another request id, or whose signature recovers to another address than the account's (a
signature by another key, or of another transaction or typed data), is `REQUEST_MISMATCH`.

## The signer (offline)

```ts
// Any address of the account (m/44'/60'/0'/0/i), as MetaMask asks: or {account: {address, path, fingerprint}} for one.
const request = airgap.decodeSignRequest(scanned, {fingerprint: wallet.fingerprint, accountPath: "m/44'/60'/0'"})
request.path // m/44'/60'/0'/0/3
request.address // when the request names one, or the account's

if (request.kind === 'transaction') {
  request.transaction // parsed from the bytes to be signed: type ('legacy', 'eip2930', 'eip1559', 'eip7702'), to (null: a contract creation), value, data, nonce, fees, chainId, accessList
  request.erc20Transfer // {recipient, amount} when the call data is an ERC-20 transfer
  request.maxFee // gas × gasPrice, or gas × maxFeePerGas, in wei
  request.authorizations // EIP-7702: [{authority, address, chainId, nonce}], the account each one delegates, recovered
  request.warnings // ['CONTRACT_CREATION', 'DELEGATION', 'ALL_CHAINS_DELEGATION']
} else if (request.kind === 'typed-data') {
  request.typedData // as it is hashed: declared members only, integers as bigint, addresses EIP-55
  request.warnings // ['NO_CHAIN_ID'] when the domain names no chain
} else {
  request.text // the message as text, when it is readable
}

if (await userConfirms(request)) {
  // The key at request.path signs, once its address is checked against any the request names.
  const answer = await airgap.signRequest(request, path => wallet.deriveAccount({chain: 'ethereum', path}))
  show(airgap.encodeSignResponse(answer))
}
```

A request for another path (outside the account, or a change address), another wallet's fingerprint or another
address is `REQUEST_MISMATCH`, and so is one for another chain id than the adapter's: the request's `chain-id` (1
when a transaction request leaves it out, as the schema says), the transaction's own, and a typed data domain's. Typed
data and messages may leave the request's chain id out, as MetaMask's and Keystone's keyrings do; a message's
signature binds no chain, and typed data is bound by its domain, whose chain id must be this network's when it has
one (`NO_CHAIN_ID` says when it has none). Transactions are parsed strictly by the chain (canonical RLP, this chain's
id, a data type that matches the bytes), so what is shown is exactly what is signed.

| Data type | Here |
| --- | --- |
| 1, legacy transaction | Yes, with EIP-155; answered with EIP-155's v |
| 2, EIP-712 typed data | Yes: JSON, read strictly, hashed by the chain |
| 3, personal message | Yes |
| 4, typed transaction | Types 1 (EIP-2930), 2 (EIP-1559) and 4 (EIP-7702); a blob transaction (3) is refused |

### Typed data JSON

`parseTypedData(json)` (string or UTF-8 bytes) reads what a request carries, and what a dApp passes to
`eth_signTypedData_v4`, strictly: RFC 8259 JSON with nothing after it, no key twice in an object (two parsers must
never read two values), objects and arrays nested at most 32 deep (Keystone's firmware's limit), no NUL character
(Keystone refuses it too: a screen may cut text short at one), no fraction or exponent (no EIP-712 type takes one),
and integers kept exact, as a `bigint` beyond a safe number. A JSON string holding that JSON reads too, once, as
Keystone reads it. `__proto__` is a member like any other. The values are then the chain's to check, as it hashes them.
`typedDataJson(typedData)` writes what a request carries.

## Pairing

```ts
// What MetaMask's QR hardware wallets and others read, as Keystone and OneKey write it: children 0/*, account.standard.
const path = "m/44'/60'/0'"
const key = airgap.accountKey({extendedKey: wallet.extendedPublicKey(path), fingerprint, name: 'My Wallet', path})
show(toUR(CRYPTO_HDKEY, key))
```

`watchAccount` takes an account's extended key (`m/44'/60'/a'` with a chain code; its addresses below the children
it names, `0/*` unless it names others, derived by the engine's public derivation, [nitro-crypto's ADR 0007](https://github.com/hzblj/nitro-crypto/blob/main/docs/adr/0007-extended-public-keys.md)) or a key at a full path
(`m/44'/60'/0'/0/0`). `pairingKey(account, fingerprint)` is one address's key, for `crypto-multi-accounts`.

| Interoperability | Evidence |
| --- | --- |
| `eth-sign-request`, `eth-signature` | Byte for byte `@keystonehq/bc-ur-registry-eth` 0.22.1 both ways, as CBOR and as URs, for each data type, and for a signature with a multi-byte v. A request its `constructETHRequest` writes is read and answered here, typed data and messages the way `@metamask/eth-qr-keyring` 3.0.1 writes them (`JSON.stringify`, no chain id) and reads the answer (r, s and v sliced). Keystone 3's firmware codec (`keystone-sdk-rust`): its requests and signature read and write back byte for byte. |
| Keystone 3's signing | Its firmware's own vectors: a Seaport order as `eth_signTypedData_v4` JSON (a chain id as text, a member its types leave out) and a personal message, each signed here to its 65 bytes exactly; its legacy v written in as few bytes as it takes reads here. |
| Typed data | Hashed as viem hashes the same JSON; signatures viem verifies. |
| Account keys | Keystone's registry reads `accountKey` as the xpub viem derives, with MetaMask's children and note. Keystone's documented `crypto-hdkey`, a OneKey's, and a Keystone 3 Pro's `crypto-multi-accounts` are watched at the addresses `@scure/bip32` derives. |
| Transactions | Of every type, parsed, assembled and recovered as viem does, byte for byte; viem recovers EIP-7702 authorizations' signers too. |
| Hardware wallets, MetaMask | Not tested on a device or in the app. |

**Not in this version:** EIP-4844 blob transactions (the adapter does not sign them), EIP-7702 authorizations on their
own (ERC-4527 has no data type for them: they travel inside a type 4 transaction), batch requests
(`eth-batch-sign-request`), and a legacy transaction without EIP-155 (the adapter never signs one).

[Documentation](https://github.com/hzblj/crypto-airgap#readme) · [Security](https://github.com/hzblj/crypto-airgap/blob/main/SECURITY.md)

The other libraries from the same author are at **[libraries.janblazej.dev](https://www.libraries.janblazej.dev)**.
