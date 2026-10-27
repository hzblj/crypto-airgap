import {
  createMultipartDecoder,
  createMultipartEncoder,
  createRequestId,
  type Sha256,
  type UR,
} from '@hzblj/crypto-airgap'
import {bitcoinAirgap} from '@hzblj/crypto-airgap-bitcoin'
import {ethereumAirgap} from '@hzblj/crypto-airgap-ethereum'
import {solanaAirgap} from '@hzblj/crypto-airgap-solana'
// The encodings without the native module, so the loopback runs in the tests too.
import {base58, hex} from '@hzblj/nitro-crypto/adapter'

import type {ChainAccount, WalletCrypto} from '../../core'

/** The chains the loopback runs: each air-gap package's. */
export const LOOPBACK_CHAINS = ['ethereum', 'bitcoin', 'solana'] as const

export type LoopbackChain = (typeof LOOPBACK_CHAINS)[number]

/** One message's trip between the phones, as a camera that misses every third code would make it. */
export type Transmission = {
  readonly ur: UR
  readonly fragments: number
  /** Codes shown before the reader had the whole message. */
  readonly shown: number
  /** Codes the reader actually read. */
  readonly read: number
}

export type LoopbackRun = {
  readonly chain: LoopbackChain
  readonly request: Transmission
  readonly answer: Transmission
  /** What the signer read from the request, line by line: what it would show before asking. */
  readonly review: readonly {readonly label: string; readonly value: string}[]
  /** What the watch-only side checked the answer against, and what it ends with. */
  readonly verified: readonly {readonly label: string; readonly value: string}[]
  readonly milliseconds: number
}

/** Bytes per part: small, so even a short transaction shows the multipart path. */
const FRAGMENT = 60

/**
 * A UR shown as an animated QR code and read by a camera that misses every third code: the encoder and decoder the
 * two phones would use, with nothing between them but strings.
 */
export const transmit = (ur: UR, allowedTypes: readonly string[], sha256: Sha256): Transmission => {
  const encoder = createMultipartEncoder(ur, {maxFragmentLength: FRAGMENT, sha256})
  const decoder = createMultipartDecoder({allowedTypes, sha256})
  let shown = 0
  let read = 0

  while (!decoder.isComplete()) {
    const part = encoder.nextPart().toUpperCase()
    shown++

    if (shown % 3 !== 2 || encoder.isSinglePart) {
      decoder.receivePart(part)
      read++
    }
  }

  return {fragments: encoder.fragmentCount, read, shown, ur: decoder.result()}
}

type Accounts<Id extends LoopbackChain> = {readonly signer: ChainAccount<Id>; readonly recipient: ChainAccount<Id>}

const shortHex = (text: string) => (text.length > 20 ? `${text.slice(0, 10)}…${text.slice(-8)}` : text)

/** Sepolia's USDC, whose EIP-2612 permit the Ethereum loopback signs. */
const USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'

/** EIP-712 typed data: an EIP-2612 permit letting `recipient` spend 25 USDC of the signer's, as a dApp asks for one. */
const ethereum = async (crypto: WalletCrypto, fingerprint: number, {recipient, signer}: Accounts<'ethereum'>) => {
  const airgap = ethereumAirgap(crypto.chains.ethereum)
  const request = {
    account: {address: signer.address, fingerprint, path: signer.path},
    origin: 'Loopback',
    requestId: createRequestId(crypto.random),
    typedData: {
      domain: {chainId: crypto.chains.ethereum.network.chainId, name: 'USDC', verifyingContract: USDC, version: '2'},
      message: {
        deadline: 2_000_000_000n,
        nonce: 0n,
        owner: signer.address,
        spender: recipient.address,
        value: 25_000_000n,
      },
      primaryType: 'Permit',
      types: {
        EIP712Domain: [
          {name: 'name', type: 'string'},
          {name: 'version', type: 'string'},
          {name: 'chainId', type: 'uint256'},
          {name: 'verifyingContract', type: 'address'},
        ],
        Permit: [
          {name: 'owner', type: 'address'},
          {name: 'spender', type: 'address'},
          {name: 'value', type: 'uint256'},
          {name: 'nonce', type: 'uint256'},
          {name: 'deadline', type: 'uint256'},
        ],
      },
    },
  }
  const sent = transmit(airgap.encodeSignRequest(request), airgap.requestTypes, crypto.hash.sha256)
  const review = airgap.decodeSignRequest(sent.ur, {account: request.account})

  if (review.kind !== 'typed-data') {
    throw new Error('The signer read something else than the typed data sent.')
  }

  const answer = transmit(
    airgap.encodeSignResponse(await airgap.signRequest(review, async () => signer)),
    airgap.responseTypes,
    crypto.hash.sha256
  )
  const result = airgap.decodeSignResponse(answer.ur, {request})

  if (result.kind !== 'typed-data') {
    throw new Error('The answer is not a typed data signature.')
  }

  return {
    answer,
    request: sent,
    review: [
      {label: 'EIP-712', value: `${review.typedData.primaryType}, ${review.typedData.domain?.name ?? 'no name'}`},
      {label: 'Spender', value: shortHex(String(review.typedData.message.spender))},
      {label: 'Value', value: '25 USDC'},
      {label: 'Chain id', value: String(review.typedData.domain?.chainId ?? 'None')},
    ],
    verified: [
      {label: 'Request id', value: 'Matches'},
      {label: 'Signer recovered', value: shortHex(signer.address)},
      {label: 'Signature', value: shortHex(result.signature)},
    ],
  }
}

/** A Taproot (BIP-86) payment as a PSBT: BIP-371's fields out, a key path signature back. */
const bitcoin = async (crypto: WalletCrypto, fingerprint: number, {recipient, signer}: Accounts<'bitcoin'>) => {
  const airgap = bitcoinAirgap(crypto.chains.bitcoin)
  const watch = crypto.chains.bitcoin.watchAccount({
    addressType: signer.addressType,
    fingerprint,
    path: signer.path,
    publicKey: signer.publicKey,
  })
  // Coins no network has: the loopback never broadcasts, and a signature commits only to what the PSBT says.
  const utxos = [
    {txid: hex.encode(crypto.random(32)), value: 90_000n, vout: 0},
    {txid: hex.encode(crypto.random(32)), value: 60_000n, vout: 1},
  ]
  const psbt = watch.createPsbt(watch.createTransaction({amount: 100_000n, feeRate: 4, to: recipient.address, utxos}))
  const sent = transmit(airgap.encodeSignRequest({psbt}), airgap.requestTypes, crypto.hash.sha256)
  const review = airgap.decodeSignRequest(sent.ur, {account: signer})
  const signed = await airgap.signRequest(review, async () => signer)
  const answer = transmit(airgap.encodeSignResponse(signed), airgap.responseTypes, crypto.hash.sha256)
  const {transaction} = airgap.decodeSignResponse(answer.ur, {request: psbt})

  return {
    answer,
    request: sent,
    review: [
      {label: 'Account', value: signer.addressType === 'p2tr' ? 'Taproot, BIP-86' : 'Native SegWit, BIP-84'},
      {label: 'Sending', value: `${review.sending} sats`},
      {label: 'Fee', value: `${review.fee ?? 0n} sats`},
      {label: 'Warnings', value: review.warnings.join(', ') || 'None'},
    ],
    verified: [
      {label: 'Same transaction', value: shortHex(review.txid)},
      {label: 'Signatures', value: `${review.inputs.length} key path, verified by the engine`},
      {label: 'Ready to broadcast', value: `${transaction.vsize} vB`},
    ],
  }
}

/** A v0 transaction whose recipient comes from an address lookup table: what the signer cannot resolve, it says. */
const solana = async (crypto: WalletCrypto, fingerprint: number, {recipient, signer}: Accounts<'solana'>) => {
  const airgap = solanaAirgap(crypto.chains.solana)
  const table = base58.encode(crypto.random(32))
  const request = {
    account: {address: signer.address, fingerprint, path: signer.path},
    origin: 'Loopback',
    requestId: createRequestId(crypto.random),
    transaction: {
      addressLookupTables: {[table]: [recipient.address]},
      instructions: [
        crypto.chains.solana.instructions.transfer({
          from: signer.address,
          lamports: 100_000_000n,
          to: recipient.address,
        }),
      ],
      recentBlockhash: base58.encode(crypto.random(32)),
      version: 0 as const,
    },
  }
  const sent = transmit(airgap.encodeSignRequest(request), airgap.requestTypes, crypto.hash.sha256)
  const review = airgap.decodeSignRequest(sent.ur, {account: request.account})

  if (review.kind !== 'transaction') {
    throw new Error('The signer read a message, not the transaction sent.')
  }

  const answer = transmit(
    airgap.encodeSignResponse(await airgap.signRequest(review, signer)),
    airgap.responseTypes,
    crypto.hash.sha256
  )
  const result = airgap.decodeSignResponse(answer.ur, {request})

  if (result.kind !== 'transaction') {
    throw new Error('The answer is not a transaction.')
  }

  const lookedUp = review.decoded.accounts.filter(account => account.lookup !== undefined).length

  return {
    answer,
    request: sent,
    review: [
      {label: 'Version', value: `v${review.decoded.version}`},
      {label: 'From lookup tables', value: `${lookedUp} account, not resolved offline`},
      {label: 'Fee payer', value: shortHex(review.decoded.feePayer)},
      {label: 'Warnings', value: review.warnings.join(', ') || 'None'},
    ],
    verified: [
      {label: 'Request id', value: 'Matches'},
      {label: 'Signature', value: 'Verified by the engine'},
      {label: 'Transaction id', value: shortHex(result.transaction.signature)},
    ],
  }
}

/**
 * Both sides of air-gapped signing in one process, with a demo key: the watch-only side builds a request (an EIP-712
 * permit, a Taproot PSBT, a v0 Solana transaction with a lookup table), it travels as QR parts to the signer, which
 * reads, checks and signs it, and the answer travels back to be checked. Nothing is broadcast, and nothing is mocked
 * but the camera. `account` gives each chain's accounts by number: Bitcoin's are Taproot ones.
 */
export const runLoopback = async (
  crypto: WalletCrypto,
  chain: LoopbackChain,
  fingerprint: number,
  account: <Id extends LoopbackChain>(chain: Id, n: number) => Promise<ChainAccount<Id>>
): Promise<LoopbackRun> => {
  const started = Date.now()
  const run =
    chain === 'ethereum'
      ? await ethereum(crypto, fingerprint, {
          recipient: await account('ethereum', 1),
          signer: await account('ethereum', 0),
        })
      : chain === 'bitcoin'
        ? await bitcoin(crypto, fingerprint, {
            recipient: await account('bitcoin', 1),
            signer: await account('bitcoin', 0),
          })
        : await solana(crypto, fingerprint, {recipient: await account('solana', 1), signer: await account('solana', 0)})

  return {...run, chain, milliseconds: Date.now() - started}
}
