import {
  AirgapError,
  type AirgapRequester,
  type AirgapResponder,
  formatKeypath,
  fromUR,
  type HDKey,
  parseKeypath,
  protocolError,
  type RequestId,
  toUR,
  type UR,
} from '@hzblj/crypto-airgap'
import type {
  DecodedSolanaMessage,
  DecodedSolanaOffchainMessage,
  PartiallySignedSolanaTransaction,
  SignedSolanaTransaction,
  SolanaAccount,
  SolanaAddress,
  SolanaAddressLookupTables,
  SolanaChain,
  SolanaInstruction,
  SolanaMessageVersion,
  SolanaOffchainMessage,
} from '@hzblj/crypto-solana'
import {base58, bytes, isCryptoError, utf8} from '@hzblj/nitro-crypto/adapter'

import {SOL_SIGN_REQUEST, SOL_SIGNATURE, type SolSignRequest} from './types'

/** An account by its address and where its key is: all a watch-only wallet knows, and all a request names. */
export type SolanaAirgapAccount = {
  readonly address: SolanaAddress
  /** `m/44'/501'/0'/0'`. */
  readonly path: string
  /** The BIP-32 fingerprint of the signer's master key. */
  readonly fingerprint: number
}

/**
 * What a watch-only wallet asks to be signed:
 * - `transaction`: one the account pays for and signs alone, its instructions and a recent blockhash compiled here
 *   with the account as fee payer: a legacy message, or v0 (`version: 0`) with the address lookup tables to load
 *   accounts from.
 * - `serializedTransaction`: a wire transaction made elsewhere (a dApp's, legacy or v0), which others may sign too:
 *   the signer signs its message, and the answer goes in the account's slot, every other slot kept as it is.
 * - `message`: bytes or text, signed exactly as given.
 * - `offchainMessage`: Solana's off-chain message (version 0 or 1), encoded here; it travels as a message (sign type
 *   2), as Keystone's firmware reads one, and its header keeps it from ever being a transaction.
 */
export type SolanaAirgapRequest = {
  /** A fresh id per request (`createRequestId`): the answer must repeat it. */
  readonly requestId: RequestId
  readonly account: SolanaAirgapAccount
  readonly origin?: string
} & (
  | {
      readonly transaction: {
        readonly instructions: readonly SolanaInstruction[]
        readonly recentBlockhash: string
        /** `'legacy'` unless stated; `0` for a versioned transaction. */
        readonly version?: SolanaMessageVersion
        /** For a v0 transaction: tables to load accounts from, by address, each with the addresses it holds. */
        readonly addressLookupTables?: SolanaAddressLookupTables
      }
    }
  | {readonly serializedTransaction: Uint8Array}
  | {readonly message: Uint8Array | string}
  | {readonly offchainMessage: SolanaOffchainMessage}
)

/**
 * The answer, checked, each signature verified for the account asked: a transaction ready to send, a transaction made
 * elsewhere with the account's slot signed (`complete` once every signer has), a message signature, or an off-chain
 * message's, with the encoded message a verifier needs.
 */
export type SolanaAirgapResponse =
  | {readonly kind: 'transaction'; readonly transaction: SignedSolanaTransaction}
  | {readonly kind: 'partially-signed'; readonly transaction: PartiallySignedSolanaTransaction}
  | {readonly kind: 'message'; readonly signature: Uint8Array}
  | {readonly kind: 'offchain-message'; readonly message: Uint8Array; readonly signature: Uint8Array}

/**
 * Something a signer should say before it signs:
 * - `UNKNOWN_INSTRUCTIONS`: an instruction calls a program, or does a thing, this package does not describe.
 * - `NOT_FEE_PAYER`: the account signs, but another account pays the fee.
 * - `OTHER_SIGNERS`: other accounts must sign too, which this signer cannot do for them.
 * - `UNRESOLVED_LOOKUPS`: a v0 transaction loads accounts from address lookup tables, which a sign request does not
 *   carry: who they are is not known here, and instructions that use them are not described.
 */
export type SolanaSignWarning = 'UNKNOWN_INSTRUCTIONS' | 'NOT_FEE_PAYER' | 'OTHER_SIGNERS' | 'UNRESOLVED_LOOKUPS'

/** A request as the signer reads it: everything to show before asking whether to sign. */
export type SolanaSignRequest = {readonly requestId?: RequestId; readonly origin?: string} & (
  | {
      readonly kind: 'transaction'
      /** The compiled message, legacy or v0: the bytes that are signed. */
      readonly message: Uint8Array
      /**
       * Read without lookup tables: a v0 message's looked-up accounts say their table and index, with `address`
       * `undefined` (`UNRESOLVED_LOOKUPS`).
       */
      readonly decoded: DecodedSolanaMessage
      /** Lamports the account's own transfers send (fees and rent not included). */
      readonly lamports: bigint
      readonly warnings: readonly SolanaSignWarning[]
    }
  | {
      readonly kind: 'offchain-message'
      /** The encoded off-chain message: the bytes that are signed. */
      readonly message: Uint8Array
      /** Its version, signers and text (and for version 0, the application and the format): what to show. */
      readonly decoded: DecodedSolanaOffchainMessage
      readonly warnings: readonly SolanaSignWarning[]
    }
  | {
      readonly kind: 'message'
      readonly message: Uint8Array
      /** The message as text, when it is UTF-8 without control characters: what to show. */
      readonly text?: string
    }
)

/** The signer's context: the account it signs as. */
export type SolanaSignContext = {readonly account: SolanaAirgapAccount}

/**
 * The signer's answer: the 64-byte signature (`signRequest` makes it: `signTransactionMessage` for a transaction,
 * `signOffchainMessage` for an off-chain message, `signMessage` for a message).
 */
export type SolanaSignature = {readonly requestId?: RequestId; readonly signature: Uint8Array}

export type SolanaAirgap = AirgapRequester<
  SolanaAirgapRequest,
  SolanaAirgapResponse,
  {readonly request: SolanaAirgapRequest}
> &
  AirgapResponder<SolanaSignRequest, SolanaSignContext, SolanaSignature> & {
    /** A key shared by a signer (from `crypto-multi-accounts`, or a `crypto-hdkey`) as an account to ask for signatures. */
    readonly watchAccount: (key: HDKey, masterFingerprint?: number) => SolanaAirgapAccount
    /** An account's public key as a signer shares it: 32 bytes of Ed25519, with its path and the wallet's fingerprint. */
    readonly pairingKey: (
      account: {readonly publicKey: Uint8Array; readonly path: string},
      fingerprint: number
    ) => HDKey
    /**
     * Signs a request the user agreed to with the account it was read for, as its kind asks: the transaction message,
     * the off-chain message (refused unless the account is among its signers), or the message bytes.
     */
    readonly signRequest: (request: SolanaSignRequest, account: SolanaAccount) => Promise<SolanaSignature>
  }

const BIP44 = 44 + 0x80000000
const SOLANA = 501 + 0x80000000

/** What every off-chain message starts with, and no transaction can. */
const OFFCHAIN_DOMAIN = bytes.concat(Uint8Array.of(0xff), utf8.encode('solana offchain'))

/** A versioned message's first byte is 0x80 and its version; text never starts with one (a UTF-8 continuation byte). */
const isVersionedPrefix = (byte: number | undefined) => byte !== undefined && byte > 0x80 && byte < 0xc0

const SIGNATURE_LENGTH = 64

const mismatch = (message: string) => new AirgapError('REQUEST_MISMATCH', message)

/** A chain's verdict on bytes from outside, as the protocol's error: the cause keeps the chain's own. */
const fromChain = <T>(run: () => T, message: string): T => {
  try {
    return run()
  } catch (error) {
    if (isCryptoError(error)) {
      throw new AirgapError('INVALID_PROTOCOL_DATA', `${message} ${error.message}`, {cause: error})
    }

    throw error
  }
}

const startsWith = (data: Uint8Array, prefix: Uint8Array) =>
  data.length >= prefix.length && prefix.every((byte, index) => data[index] === byte)

/** The older off-chain format's header: the signing domain, version 0, a format, and the text's length. */
const LEGACY_OFFCHAIN_HEADER = OFFCHAIN_DOMAIN.length + 4

/** The most text the older format`s first two formats hold: what a hardware wallet`s screen shows. */
const OFFCHAIN_LIMITED = 1232

/**
 * The text of an off-chain message in the format the `solana sign-offchain-message` CLI wrote before the
 * specification's version 0 (no application domain, no signers): the domain, version 0, a format (0 printable ASCII
 * or 1 UTF-8, each within 1232 bytes, 2 UTF-8 to 65535), the length, the text. Keystone's firmware reads it and shows
 * the text; `undefined` for anything else, or text that is not readable.
 */
const legacyOffchainText = (data: Uint8Array): string | undefined => {
  const format = data[OFFCHAIN_DOMAIN.length + 1]
  const length = (data[OFFCHAIN_DOMAIN.length + 2] ?? 0) | ((data[OFFCHAIN_DOMAIN.length + 3] ?? 0) << 8)
  const text = data.subarray(LEGACY_OFFCHAIN_HEADER)

  if (
    data[OFFCHAIN_DOMAIN.length] !== 0 ||
    format === undefined ||
    format > 2 ||
    text.length === 0 ||
    text.length !== length ||
    (format < 2 && text.length > OFFCHAIN_LIMITED) ||
    (format === 0 && !text.every(byte => byte === 0x0a || (byte >= 0x20 && byte <= 0x7e)))
  ) {
    return undefined
  }

  return readableText(text)
}

const messageBytes = (message: Uint8Array | string) => (typeof message === 'string' ? utf8.encode(message) : message)

/** Text worth showing as text: valid UTF-8 that decodes back to the same bytes, without control characters. */
const readableText = (message: Uint8Array): string | undefined => {
  const text = utf8.decode(message)

  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what this looks for.
  return bytes.equal(utf8.encode(text), message) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)
    ? text
    : undefined
}

/**
 * Air-gapped signing for Solana, bound to a chain (`crypto.chains.solana`): Keystone's `sol-sign-request` and
 * `sol-signature`, for transactions (legacy and v0, the account's own or several signers'), messages and off-chain
 * messages. Nothing here signs or verifies by itself: the chain compiles, decodes and verifies, the engine signs.
 */
export const solanaAirgap = (chain: SolanaChain<string>): SolanaAirgap => {
  const watchAccount = (key: HDKey, masterFingerprint?: number): SolanaAirgapAccount => {
    const fingerprint = key.origin?.sourceFingerprint ?? masterFingerprint
    const components = key.origin?.components ?? []

    if (key.keyData.length !== 32) {
      throw new AirgapError('INVALID_PROTOCOL_DATA', 'A Solana key is a 32-byte Ed25519 public key.')
    }

    if (fingerprint === undefined || !key.origin) {
      throw new AirgapError('INVALID_PROTOCOL_DATA', 'A key to sign with says which wallet and path it is from.')
    }

    const indexes = components.map(step => ('index' in step && step.hardened ? step.index + 0x80000000 : Number.NaN))

    if (indexes[0] !== BIP44 || indexes[1] !== SOLANA || (key.useInfo && key.useInfo.type !== 501)) {
      throw mismatch("This key is not a Solana key (m/44'/501'/…).")
    }

    if (indexes.length < 3 || indexes.some(Number.isNaN)) {
      throw new AirgapError('INVALID_PROTOCOL_DATA', 'A Solana key`s path is hardened indexes only (SLIP-0010).')
    }

    return Object.freeze({
      address: chain.addressFromPublicKey(key.keyData),
      fingerprint,
      path: formatKeypath(key.origin),
    })
  }

  const compile = (request: Extract<SolanaAirgapRequest, {readonly transaction: unknown}>) => {
    const {addressLookupTables, instructions, recentBlockhash, version} = request.transaction
    const message = fromChain(
      () =>
        chain.compileMessage({
          feePayer: request.account.address,
          instructions,
          recentBlockhash,
          ...(version === undefined ? {} : {version}),
          ...(addressLookupTables === undefined ? {} : {addressLookupTables}),
        }),
      'The transaction is not one to sign.'
    )

    if (chain.decodeMessage(message).signers.length !== 1) {
      throw new AirgapError(
        'INVALID_ARGUMENT',
        'A transaction built here is signed by its fee payer alone: pass one others sign as serializedTransaction.'
      )
    }

    return message
  }

  /** A wire transaction made elsewhere, read strictly, with the account among its signers. */
  const readSerialized = (request: Extract<SolanaAirgapRequest, {readonly serializedTransaction: unknown}>) => {
    const decoded = fromChain(
      () => chain.decodeTransaction(request.serializedTransaction),
      'The transaction is not one to sign.'
    )
    const slot = decoded.signers.indexOf(request.account.address)

    if (slot === -1) {
      throw new AirgapError('INVALID_ARGUMENT', 'The account is not among the transaction`s signers.')
    }

    return {decoded, slot}
  }

  /** An off-chain message's bytes, with the account among its signers. */
  const offchainBytes = (request: Extract<SolanaAirgapRequest, {readonly offchainMessage: unknown}>) => {
    const message = fromChain(
      () => chain.encodeOffchainMessage(request.offchainMessage),
      'The off-chain message is not one to sign.'
    )

    if (!chain.decodeOffchainMessage(message).signers.includes(request.account.address)) {
      throw new AirgapError('INVALID_ARGUMENT', 'The account is not among the off-chain message`s signers.')
    }

    return message
  }

  const signRequestOf = (request: SolanaAirgapRequest): SolSignRequest => {
    const base = {
      address: base58.decode(request.account.address),
      derivationPath: parseKeypath(request.account.path, request.account.fingerprint),
      origin: request.origin,
      requestId: request.requestId,
    }

    if ('transaction' in request) {
      return {...base, signData: compile(request), signType: 'transaction'}
    }

    if ('serializedTransaction' in request) {
      return {...base, signData: readSerialized(request).decoded.message, signType: 'transaction'}
    }

    if ('offchainMessage' in request) {
      return {...base, signData: offchainBytes(request), signType: 'message'}
    }

    return {...base, signData: messageBytes(request.message), signType: 'message'}
  }

  /** The account's slot of a wire transaction signed with `signature`, every other slot as it was. */
  const fillSlot = (
    request: Extract<SolanaAirgapRequest, {readonly serializedTransaction: unknown}>,
    signature: Uint8Array
  ): PartiallySignedSolanaTransaction => {
    const {decoded, slot} = readSerialized(request)
    const serialized = request.serializedTransaction.slice()
    // The wire format: the signature count (compact-u16), the signatures, then the message.
    const first = serialized.length - decoded.message.length - decoded.signers.length * SIGNATURE_LENGTH
    serialized.set(signature, first + slot * SIGNATURE_LENGTH)
    const signatures = decoded.signatures.map((existing, index) => (index === slot ? signature : existing))
    const payer = signatures[0]

    return Object.freeze({
      complete: signatures.every(entry => entry !== undefined),
      serialized,
      signature: payer === undefined ? undefined : base58.encode(payer),
    })
  }

  return Object.freeze({
    chain: 'solana',
    decodeSignRequest: (ur: UR, {account}: SolanaSignContext): SolanaSignRequest => {
      const request = fromUR(SOL_SIGN_REQUEST, ur)
      const common = {origin: request.origin, requestId: request.requestId}

      if (formatKeypath(request.derivationPath) !== account.path) {
        throw mismatch('The request is for another key than this account`s.')
      }

      const source = request.derivationPath.sourceFingerprint

      if (source !== undefined && source !== account.fingerprint) {
        throw mismatch('The request is for another wallet than this one.')
      }

      if (request.address && !bytes.equal(request.address, base58.decode(account.address))) {
        throw mismatch('The request names another address than this account`s.')
      }

      if (startsWith(request.signData, OFFCHAIN_DOMAIN)) {
        // Off-chain messages travel as messages (sign type 2): a "transaction" with this header is no transaction.
        if (request.signType !== 'message') {
          throw protocolError('The transaction is an off-chain message: it is refused as a transaction.')
        }

        let decoded: DecodedSolanaOffchainMessage

        try {
          decoded = chain.decodeOffchainMessage(request.signData)
        } catch (error) {
          const text = isCryptoError(error) ? legacyOffchainText(request.signData) : undefined

          if (text === undefined) {
            throw isCryptoError(error)
              ? new AirgapError(
                  'INVALID_PROTOCOL_DATA',
                  `The off-chain message is not one this reads. ${error.message}`,
                  {
                    cause: error,
                  }
                )
              : error
          }

          // The solana CLI's older format, as some dApps still send it: its text is shown, its bytes signed as given.
          return Object.freeze({...common, kind: 'message', message: request.signData, text})
        }

        if (!decoded.signers.includes(account.address)) {
          throw mismatch('This account is not among the off-chain message`s signers.')
        }

        return Object.freeze({
          ...common,
          decoded,
          kind: 'offchain-message',
          message: request.signData,
          warnings: Object.freeze(decoded.signers.length > 1 ? (['OTHER_SIGNERS'] as const) : []),
        })
      }

      // A versioned transaction this does not read (v1 and later) is never signed, as a transaction or as a message.
      if (isVersionedPrefix(request.signData[0])) {
        throw protocolError('The data is a versioned transaction this does not read: it is refused.')
      }

      let decoded: DecodedSolanaMessage | undefined

      try {
        decoded = chain.decodeMessage(request.signData)
      } catch (error) {
        if (!isCryptoError(error) || request.signType === 'transaction') {
          throw isCryptoError(error)
            ? new AirgapError('INVALID_PROTOCOL_DATA', `The transaction is not one to sign. ${error.message}`, {
                cause: error,
              })
            : error
        }
      }

      if (request.signType === 'message') {
        // A "message" that is a transaction this account would sign is a transaction in disguise.
        if (decoded?.signers.includes(account.address)) {
          throw new AirgapError('INVALID_PROTOCOL_DATA', 'The message is a transaction: it is refused as a message.')
        }

        const text = readableText(request.signData)

        return Object.freeze({
          ...common,
          kind: 'message',
          message: request.signData,
          ...(text === undefined ? {} : {text}),
        })
      }

      if (!decoded?.signers.includes(account.address)) {
        throw mismatch('This account is not among the transaction`s signers.')
      }

      const warnings: SolanaSignWarning[] = []

      if (decoded.instructions.some(instruction => instruction.summary.type === 'unknown')) {
        warnings.push('UNKNOWN_INSTRUCTIONS')
      }

      if (decoded.feePayer !== account.address) {
        warnings.push('NOT_FEE_PAYER')
      }

      if (decoded.signers.length > 1) {
        warnings.push('OTHER_SIGNERS')
      }

      if (decoded.accounts.some(entry => entry.address === undefined)) {
        warnings.push('UNRESOLVED_LOOKUPS')
      }

      const lamports = decoded.instructions.reduce(
        (total, {summary}) =>
          summary.type === 'transfer' && summary.from === account.address ? total + summary.lamports : total,
        0n
      )

      return Object.freeze({
        ...common,
        decoded,
        kind: 'transaction',
        lamports,
        message: request.signData,
        warnings: Object.freeze(warnings),
      })
    },
    decodeSignResponse: (ur: UR, {request}: {readonly request: SolanaAirgapRequest}): SolanaAirgapResponse => {
      const answer = fromUR(SOL_SIGNATURE, ur)

      if (answer.requestId !== request.requestId) {
        throw mismatch('The signature answers another request than this one.')
      }

      if ('message' in request) {
        const valid = chain.verifyMessage({
          address: request.account.address,
          message: messageBytes(request.message),
          signature: answer.signature,
        })

        if (!valid) {
          throw mismatch('The message signature is not by the account asked.')
        }

        return Object.freeze({kind: 'message', signature: answer.signature})
      }

      if ('offchainMessage' in request) {
        const message = offchainBytes(request)

        if (!chain.verifyOffchainMessage({address: request.account.address, message, signature: answer.signature})) {
          throw mismatch('The off-chain message signature is not by the account asked, or not of this message.')
        }

        return Object.freeze({kind: 'offchain-message', message, signature: answer.signature})
      }

      if ('serializedTransaction' in request) {
        const {decoded} = readSerialized(request)

        if (
          !chain.verifyMessage({
            address: request.account.address,
            message: decoded.message,
            signature: answer.signature,
          })
        ) {
          throw mismatch('The signature is not by the account asked, or not of this transaction.')
        }

        return Object.freeze({kind: 'partially-signed', transaction: fillSlot(request, answer.signature)})
      }

      const message = compile(request)

      try {
        return Object.freeze({
          kind: 'transaction',
          transaction: chain.assembleTransaction({message, signatures: [answer.signature]}),
        })
      } catch (error) {
        if (isCryptoError(error, 'INVALID_SIGNATURE')) {
          throw new AirgapError(
            'REQUEST_MISMATCH',
            'The signature is not by the account asked, or not of this transaction.',
            {
              cause: error,
            }
          )
        }

        throw error
      }
    },
    encodeSignRequest: (request: SolanaAirgapRequest) => toUR(SOL_SIGN_REQUEST, signRequestOf(request)),
    encodeSignResponse: ({requestId, signature}: SolanaSignature) => toUR(SOL_SIGNATURE, {requestId, signature}),
    pairingKey: ({path, publicKey}, fingerprint) => {
      if (publicKey.length !== 32) {
        throw new AirgapError('INVALID_ARGUMENT', 'A Solana public key is 32 bytes.')
      }

      return {keyData: publicKey.slice(), origin: parseKeypath(path, fingerprint), useInfo: {network: 0, type: 501}}
    },
    requestTypes: Object.freeze(['sol-sign-request']),
    responseTypes: Object.freeze(['sol-signature']),
    signRequest: async (request: SolanaSignRequest, account: SolanaAccount): Promise<SolanaSignature> => {
      const signature =
        request.kind === 'transaction'
          ? await account.signTransactionMessage(request.message)
          : request.kind === 'offchain-message'
            ? (await account.signOffchainMessage(request.message)).signature
            : await account.signMessage({message: request.message})

      return Object.freeze({signature, ...(request.requestId === undefined ? {} : {requestId: request.requestId})})
    },
    watchAccount,
  })
}
