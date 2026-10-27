import {
  AirgapError,
  type AirgapRequester,
  type AirgapResponder,
  formatKeypath,
  fromUR,
  type HDKey,
  type Keypath,
  parseKeypath,
  protocolError,
  type RequestId,
  toUR,
  type UR,
} from '@hzblj/crypto-airgap'
import type {
  Address,
  EthereumAccount,
  EthereumChain,
  EthereumTransactionRequest,
  Hex,
  ParsedEthereumTransaction,
  SignableMessage,
  SignedEthereumTransaction,
  TypedDataDefinition,
} from '@hzblj/crypto-ethereum'
import {
  bytes,
  type ExtendedPublicKey,
  hex,
  isCryptoError,
  type RecoverableSignature,
  utf8,
} from '@hzblj/nitro-crypto/adapter'
import {parseTypedData, reviewTypedData, typedDataJson} from './typed-data'
import {ETH_SIGN_REQUEST, ETH_SIGNATURE, type EthSignRequest} from './types'

/** An account by its address and where its key is: all a watch-only wallet knows, and all a request names. */
export type EthereumAirgapAccount = {
  readonly address: Address
  /** `m/44'/60'/0'/0/0`. */
  readonly path: string
  /** The BIP-32 fingerprint of the signer's master key. */
  readonly fingerprint: number
}

/**
 * What a watch-only wallet asks to be signed: a transaction of any type the Ethereum adapter signs (legacy with
 * EIP-155, EIP-2930, EIP-1559, EIP-7702; contract creation with `to: null`), EIP-712 typed data in viem's shape, or a
 * message for `personal_sign`.
 */
export type EthereumAirgapRequest = {
  /** A fresh id per request (`createRequestId`): the answer must repeat it. */
  readonly requestId: RequestId
  readonly account: EthereumAirgapAccount
  /** Who asks, for the signer to show: the wallet's name. */
  readonly origin?: string
} & (
  | {readonly transaction: EthereumTransactionRequest}
  | {readonly typedData: TypedDataDefinition}
  | {readonly message: SignableMessage}
)

/**
 * The answer, checked: a transaction ready to broadcast, or a typed data or message signature (65 bytes of hex, v as
 * 27 or 28), each by the account asked.
 */
export type EthereumAirgapResponse =
  | {readonly kind: 'transaction'; readonly transaction: SignedEthereumTransaction; readonly origin?: string}
  | {readonly kind: 'typed-data'; readonly signature: Hex; readonly origin?: string}
  | {readonly kind: 'message'; readonly signature: Hex; readonly origin?: string}

/** An ERC-20 `transfer` the call data makes: who receives, and how many base units. */
export type Erc20Transfer = {readonly recipient: Address; readonly amount: bigint}

/**
 * Something a signer should say before it signs:
 * - `CONTRACT_CREATION`: the transaction deploys a contract (`to` is `null`): there is no recipient, and `data` is its
 *   code.
 * - `DELEGATION`: an EIP-7702 transaction, which sets the code of each account in its `authorizations` to a contract's:
 *   whoever controls that contract controls those accounts.
 * - `ALL_CHAINS_DELEGATION`: one of those authorizations has chain id 0, valid on every EVM chain.
 * - `NO_CHAIN_ID`: typed data whose domain names no chain id: the signature is valid on every chain.
 */
export type EthereumSignWarning = 'CONTRACT_CREATION' | 'DELEGATION' | 'ALL_CHAINS_DELEGATION' | 'NO_CHAIN_ID'

/** An EIP-7702 authorization a type 4 transaction carries, as a signer shows it. */
export type EthereumAuthorizationReview = {
  /**
   * The account that signed it, whose code it sets: recovered by the engine, `undefined` when its signature recovers
   * no key (the network skips such an authorization).
   */
  readonly authority: Address | undefined
  /** The contract it delegates to; the zero address clears a delegation. */
  readonly address: Address
  /** This network's chain id, or 0 for every chain. */
  readonly chainId: number
  readonly nonce: bigint
}

/** A request as the signer reads it: everything to show before asking whether to sign. */
export type EthereumSignRequest = {
  readonly requestId?: RequestId
  readonly origin?: string
  /** The key asked for, below the signer's master key: `m/44'/60'/0'/0/3`. */
  readonly path: string
  /**
   * The address that signs, when known: the account's, or the one the request names. A request may name none; then
   * the signer knows it once it derives the key (`signRequest` does, and checks any address named against it).
   */
  readonly address?: Address
} & (
  | {
      readonly kind: 'transaction'
      /**
       * Parsed from the bytes that are signed, every field present: `type` says which (`legacy`, `eip2930`,
       * `eip1559`, `eip7702`), `to` is `null` for a contract creation, and the chain id is this network's.
       */
      readonly transaction: ParsedEthereumTransaction
      /** When the call data is an ERC-20 `transfer` (the token is `transaction.to`). */
      readonly erc20Transfer?: Erc20Transfer
      /** The most it can cost, in wei: `gas × gasPrice` (types 0 and 1) or `gas × maxFeePerGas` (2 and 4). */
      readonly maxFee: bigint
      /** An EIP-7702 transaction's authorizations, each with the account it delegates; empty for other types. */
      readonly authorizations: readonly EthereumAuthorizationReview[]
      readonly warnings: readonly EthereumSignWarning[]
    }
  | {
      readonly kind: 'typed-data'
      /**
       * EIP-712 typed data as it is signed, read from the request's JSON and hashed by the chain first: the domain's
       * fields (its `chainId` a number, and this network's when present), and each member the types declare, in
       * declared order, integers as `bigint`, addresses EIP-55, bytes as `0x` hex. Members the types do not declare
       * are left out: they are not signed.
       */
      readonly typedData: TypedDataDefinition
      readonly warnings: readonly EthereumSignWarning[]
    }
  | {
      readonly kind: 'message'
      readonly message: Uint8Array
      /** The message as text, when it is UTF-8 without control characters: what to show. */
      readonly text?: string
    }
)

/**
 * Who signs: one account, or a wallet's account as MetaMask and other watch-only wallets use an extended key (any
 * address `<accountPath>/0/index` the request asks for under the wallet's fingerprint).
 */
export type EthereumSignContext =
  | {readonly account: EthereumAirgapAccount}
  | {readonly fingerprint: number; readonly accountPath: string}

/** An account's extended public key, where it is, and the wallet it is of: what a signer shares to pair. */
export type EthereumAccountKey = {
  readonly extendedKey: ExtendedPublicKey
  /** `m/44'/60'/0'`. */
  readonly path: string
  readonly fingerprint: number
  /** The signer's name, which a watch-only wallet shows (MetaMask does). */
  readonly name?: string
}

/**
 * The signer's answer, as `signRequest` makes it. A `RecoverableSignature` (the engine's,
 * `account.signTransaction(…).signature`) goes out with v as the y parity, as ERC-4527 signers send it for typed
 * transactions; hex goes out as it is: a message's or typed data's 65 bytes (v as 27 or 28), or a legacy transaction's
 * `r || s || v` with v as EIP-155's `chainId × 2 + 35 + parity`, which is what MetaMask's keyring reads for one and
 * what `signRequest` writes.
 */
export type EthereumSignature = {
  readonly requestId?: RequestId
  readonly signature: RecoverableSignature | Hex
  readonly origin?: string
}

export type EthereumAirgap = AirgapRequester<
  EthereumAirgapRequest,
  EthereumAirgapResponse,
  {readonly request: EthereumAirgapRequest}
> &
  AirgapResponder<EthereumSignRequest, EthereumSignContext, EthereumSignature> & {
    /**
     * A key shared by a signer (from `crypto-multi-accounts`, or a `crypto-hdkey`) as an account to ask for
     * signatures: a single key at a full path, or an account's extended key (`m/44'/60'/a'`), at its address `index`
     * (0 unless stated) below the children it names (`0/*` unless stated, as MetaMask reads it), derived publicly by
     * the engine.
     */
    readonly watchAccount: (key: HDKey, masterFingerprint?: number, index?: number) => EthereumAirgapAccount
    /** An account's public key as a signer shares it: compressed, with its path and the wallet's fingerprint. */
    readonly pairingKey: (account: {readonly publicKey: Hex; readonly path: string}, fingerprint: number) => HDKey
    /**
     * An account's extended public key as a `crypto-hdkey` for MetaMask and other watch-only wallets, as Keystone and
     * OneKey share it: children `0/*`, the note `account.standard`, and `name` (`wallet.extendedPublicKey("m/44'/60'/0'")`).
     */
    readonly accountKey: (key: EthereumAccountKey) => HDKey
    /**
     * Signs a request the user agreed to, with the key `account(path)` derives (the wallet's
     * `deriveAccount({chain, path})`), after checking it is at the path asked and is any address the request names: a
     * transaction (a legacy one answered with EIP-155's v, a typed one with the y parity), typed data or a message
     * (v as 27 or 28), as Keystone's firmware answers each.
     */
    readonly signRequest: (
      request: EthereumSignRequest,
      account: (path: string) => Promise<EthereumAccount>
    ) => Promise<EthereumSignature>
  }

const HARDENED = 0x80000000
const BIP44 = 44 + HARDENED
const ETHEREUM = 60 + HARDENED

/** `0/*`: the receiving addresses below an account, where MetaMask and Keystone look. */
const RECEIVING: Keypath = {
  components: [
    {hardened: false, index: 0},
    {hardened: false, wildcard: true},
  ],
}

/** Whether `path` is a receiving address directly below `accountPath`: `<account>/0/7`. */
const isBelowAccount = (path: string, accountPath: string) => {
  const rest = path.startsWith(`${accountPath}/`) ? path.slice(accountPath.length + 1).split('/') : []

  return rest.length === 2 && rest[0] === '0' && /^\d+$/.test(rest[1] ?? '')
}

/**
 * Where an account key's address `index` is, from the children it names: non-hardened indexes and a last wildcard
 * (`0/*`, the default; Ledger's legacy layout is `*`). Anything else is not a set of addresses to watch.
 */
const childPath = (children: Keypath | undefined, index: number) => {
  const components = (children ?? RECEIVING).components
  const steps = components.map((step, position) => {
    if (step.hardened) {
      return undefined
    }

    if (position === components.length - 1) {
      return 'wildcard' in step ? `${index}` : undefined
    }

    return 'index' in step ? `${step.index}` : undefined
  })

  if (steps.length === 0 || steps.some(step => step === undefined)) {
    throw new AirgapError('INVALID_PROTOCOL_DATA', 'An account key`s children are a path of indexes ending in `*`.')
  }

  return steps.join('/')
}

/** EIP-2718 types the Ethereum adapter signs (1, 2 and 4); a legacy transaction is an RLP list, from 0xc0. */
const TYPED_TRANSACTIONS: readonly number[] = [0x01, 0x02, 0x04]

const RLP_LIST = 0xc0

/** `transfer(address,uint256)`. */
const TRANSFER = '0xa9059cbb'

const mismatch = (message: string) => new AirgapError('REQUEST_MISMATCH', message)

/**
 * A chain's verdict as the protocol's error, the cause keeping the chain's own: a request for another chain id is
 * `REQUEST_MISMATCH`, anything else the chain refuses `INVALID_PROTOCOL_DATA`.
 */
const fromChain = <T>(run: () => T, message: string): T => {
  try {
    return run()
  } catch (error) {
    if (isCryptoError(error, 'CHAIN_MISMATCH')) {
      throw new AirgapError('REQUEST_MISMATCH', error.message, {cause: error})
    }

    if (isCryptoError(error)) {
      throw new AirgapError('INVALID_PROTOCOL_DATA', `${message} ${error.message}`, {cause: error})
    }

    throw error
  }
}

const messageBytes = (message: SignableMessage) => (typeof message === 'string' ? utf8.encode(message) : message)

/** Text worth showing as text: valid UTF-8 that decodes back to the same bytes, without control characters. */
const readableText = (message: Uint8Array): string | undefined => {
  const text = utf8.decode(message)

  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what this looks for.
  return bytes.equal(utf8.encode(text), message) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)
    ? text
    : undefined
}

/** An integer's big-endian bytes without leading zeros, one byte at least: how Keystone writes v. */
const minimalBytes = (value: bigint) => {
  const out: number[] = []

  for (let rest = value; rest > 0n || out.length === 0; rest >>= 8n) {
    out.unshift(Number(rest & 0xffn))
  }

  return Uint8Array.from(out)
}

/** `r || s || v`, from either form a signer hands over: v as the y parity for the engine's. */
const signatureBytes = (signature: RecoverableSignature | Hex): Uint8Array =>
  typeof signature === 'string'
    ? hex.decode(signature)
    : bytes.concat(signature.signature, Uint8Array.of(signature.recovery))

/**
 * The engine's form of an answer's `r || s || v`, v read as signers write it: the y parity (0 or 1), 27 or 28, or for
 * a legacy transaction on `eip155ChainId`, EIP-155's `chainId × 2 + 35 + parity` in any number of bytes. Which key it
 * recovers is checked after; anything else is `INVALID_PROTOCOL_DATA`.
 */
const recoverableOf = (signature: Uint8Array, eip155ChainId?: number): RecoverableSignature => {
  let v = 0n

  for (const byte of signature.subarray(64)) {
    v = (v << 8n) | BigInt(byte)
  }

  const eip155 = eip155ChainId === undefined ? undefined : BigInt(eip155ChainId) * 2n + 35n
  const parity =
    v === 0n || v === 1n
      ? v
      : v === 27n || v === 28n
        ? v - 27n
        : eip155 !== undefined && (v === eip155 || v === eip155 + 1n)
          ? v - eip155
          : undefined

  if (parity === undefined || signature.length < 65) {
    throw protocolError('The signature`s v is not a recovery id this reads.')
  }

  return {recovery: parity === 0n ? 0 : 1, signature: signature.slice(0, 64)}
}

/** 65 bytes of hex, v as 27 or 28, as `personal_sign`, `eth_signTypedData_v4` and every verifier take it. */
const legacyV = (signature: Uint8Array): Hex => {
  const {recovery, signature: rs} = recoverableOf(signature)

  return hex.encode(bytes.concat(rs, Uint8Array.of(27 + recovery)), {prefix: true}) as Hex
}

/** A legacy transaction's answer: `r || s || v`, v as EIP-155's `chainId × 2 + 35 + parity`, as Keystone writes it. */
const eip155Signature = ({recovery, signature}: RecoverableSignature, chainId: number): Hex =>
  hex.encode(bytes.concat(signature, minimalBytes(BigInt(chainId) * 2n + 35n + BigInt(recovery))), {
    prefix: true,
  }) as Hex

/** What a transaction may cost at most, in wei. */
const maxFeeOf = (transaction: ParsedEthereumTransaction) =>
  transaction.type === 'legacy' || transaction.type === 'eip2930'
    ? transaction.gas * transaction.gasPrice
    : transaction.gas * transaction.maxFeePerGas

/**
 * Air-gapped signing for Ethereum and every EVM chain, bound to a chain (`crypto.chains.ethereum`): ERC-4527's
 * `eth-sign-request` and `eth-signature`, for each of its data types: legacy transactions (1), EIP-712 typed data as
 * JSON (2), `personal_sign` messages (3) and typed transactions of types 1, 2 and 4 (4). Nothing here signs or
 * verifies by itself: the chain parses, hashes and recovers, the engine signs.
 */
export const ethereumAirgap = (chain: EthereumChain<string>): EthereumAirgap => {
  const chainId = chain.network.chainId

  const watchAccount = (key: HDKey, masterFingerprint?: number, index = 0): EthereumAirgapAccount => {
    const fingerprint = key.origin?.sourceFingerprint ?? masterFingerprint
    const indexes = (key.origin?.components ?? []).map(step =>
      'index' in step ? (step.hardened ? step.index + HARDENED : step.index) : Number.NaN
    )

    if (key.keyData.length !== 33) {
      throw new AirgapError('INVALID_PROTOCOL_DATA', 'An Ethereum key is a compressed secp256k1 public key.')
    }

    if (fingerprint === undefined || !key.origin) {
      throw new AirgapError('INVALID_PROTOCOL_DATA', 'A key to sign with says which wallet and path it is from.')
    }

    if (indexes[0] !== BIP44 || indexes[1] !== ETHEREUM || (key.useInfo && key.useInfo.type !== 60)) {
      throw mismatch("This key is not an Ethereum key (m/44'/60'/…).")
    }

    const isAccount = indexes.length === 3 && key.chainCode !== undefined

    if (!(isAccount || indexes.length >= 5) || indexes.some(Number.isNaN)) {
      throw new AirgapError(
        'INVALID_PROTOCOL_DATA',
        "A key to sign with is an account's extended key (m/44'/60'/account') or an address's (m/44'/60'/…/index)."
      )
    }

    const path = formatKeypath(key.origin)

    if (!isAccount) {
      return Object.freeze({
        address: fromChain(() => chain.addressFromPublicKey(key.keyData), 'The key is not a public key.'),
        fingerprint,
        path,
      })
    }

    const relative = childPath(key.children, index)
    const extendedKey: ExtendedPublicKey = {
      chainCode: key.chainCode ?? new Uint8Array(32),
      childNumber: indexes[2] ?? 0,
      depth: 3,
      parentFingerprint: key.parentFingerprint ?? 0,
      publicKey: key.keyData,
    }
    const leaf = fromChain(() => chain.derivePublic(extendedKey, `m/${relative}`), 'The key is not one to derive from.')

    return Object.freeze({
      address: fromChain(() => chain.addressFromPublicKey(leaf.publicKey), 'The key is not a public key.'),
      fingerprint,
      path: `${path}/${relative}`,
    })
  }

  const signRequestOf = (request: EthereumAirgapRequest): EthSignRequest => {
    const base = {
      address: hex.decode(request.account.address),
      chainId,
      derivationPath: parseKeypath(request.account.path, request.account.fingerprint),
      origin: request.origin,
      requestId: request.requestId,
    }

    if ('transaction' in request) {
      const signData = hex.decode(
        fromChain(() => chain.serializeTransaction(request.transaction), 'The transaction is not one to sign.')
      )

      return {
        ...base,
        dataType: request.transaction.type === 'legacy' ? 'legacy-transaction' : 'typed-transaction',
        signData,
      }
    }

    if ('typedData' in request) {
      // What goes out must be typed data this chain hashes: a malformed one is the caller's mistake, said here.
      fromChain(() => chain.hashTypedData(request.typedData), 'The typed data is not one to sign.')

      return {...base, dataType: 'typed-data', signData: utf8.encode(typedDataJson(request.typedData))}
    }

    return {...base, dataType: 'personal-message', signData: messageBytes(request.message)}
  }

  /** A transaction read for review: parsed by the chain from the bytes that are signed, and what it does. */
  const reviewTransaction = (request: EthSignRequest) => {
    const first = request.signData[0] ?? 0

    if (request.dataType === 'legacy-transaction' ? first < RLP_LIST : !TYPED_TRANSACTIONS.includes(first)) {
      throw protocolError(
        'A legacy transaction is an RLP list (data type 1), and a typed one starts with its type, 1, 2 or 4 (data type 4).'
      )
    }

    const transaction = fromChain(() => chain.parseTransaction(request.signData), 'The transaction is not one to sign.')
    const data = hex.decode(transaction.data)
    const erc20Transfer =
      transaction.to !== null &&
      transaction.data.toLowerCase().startsWith(TRANSFER) &&
      data.length === 68 &&
      data.subarray(4, 16).every(byte => byte === 0)
        ? {
            amount: BigInt(hex.encode(data.subarray(36), {prefix: true})),
            recipient: chain.checksumAddress(data.subarray(16, 36)),
          }
        : undefined
    const authorizations =
      transaction.type === 'eip7702'
        ? transaction.authorizationList.map(authorization =>
            Object.freeze({
              address: authorization.address,
              authority: fromChain(
                () => chain.recoverAuthorizationAddress(authorization),
                'An authorization is not one this reads.'
              ),
              chainId: authorization.chainId,
              nonce: authorization.nonce,
            })
          )
        : []
    const warnings: EthereumSignWarning[] = []

    if (transaction.to === null) {
      warnings.push('CONTRACT_CREATION')
    }

    if (transaction.type === 'eip7702') {
      warnings.push('DELEGATION')
    }

    if (authorizations.some(authorization => authorization.chainId === 0)) {
      warnings.push('ALL_CHAINS_DELEGATION')
    }

    return {
      authorizations: Object.freeze(authorizations),
      kind: 'transaction' as const,
      maxFee: maxFeeOf(transaction),
      transaction,
      warnings: Object.freeze(warnings),
      ...(erc20Transfer ? {erc20Transfer} : {}),
    }
  }

  /** Typed data read for review: parsed strictly, hashed by the chain, and shown in the form that is hashed. */
  const reviewTypedDataRequest = (request: EthSignRequest) => {
    const parsed = parseTypedData(request.signData)
    const digest = fromChain(() => chain.hashTypedData(parsed), 'The typed data is not one to sign.')
    const typedData = reviewTypedData(parsed, address => chain.checksumAddress(address))

    // What is shown is what is signed: the same digest, or nothing at all.
    if (!bytes.equal(chain.hashTypedData(typedData), digest)) {
      throw protocolError('The typed data does not read back as it hashes.')
    }

    return {
      kind: 'typed-data' as const,
      typedData,
      warnings: Object.freeze(typedData.domain?.chainId === undefined ? (['NO_CHAIN_ID'] as const) : []),
    }
  }

  return Object.freeze({
    accountKey: ({extendedKey, fingerprint, name, path}: EthereumAccountKey): HDKey => ({
      chainCode: extendedKey.chainCode,
      children: RECEIVING,
      keyData: extendedKey.publicKey,
      name,
      note: 'account.standard',
      origin: parseKeypath(path, fingerprint),
      parentFingerprint: extendedKey.parentFingerprint || undefined,
      useInfo: {network: 0, type: 60},
    }),
    chain: 'ethereum',
    decodeSignRequest: (ur: UR, context: EthereumSignContext): EthereumSignRequest => {
      const request = fromUR(ETH_SIGN_REQUEST, ur)
      const path = formatKeypath(request.derivationPath)
      const account = 'account' in context ? context.account : undefined
      const fingerprint = 'account' in context ? context.account.fingerprint : context.fingerprint
      const asked = 'account' in context ? path === context.account.path : isBelowAccount(path, context.accountPath)

      if (!asked) {
        throw mismatch('The request is for another key than this account`s.')
      }

      const source = request.derivationPath.sourceFingerprint

      if (source !== undefined && source !== fingerprint) {
        throw mismatch('The request is for another wallet than this one.')
      }

      if (account && request.address && !bytes.equal(request.address, hex.decode(account.address))) {
        throw mismatch('The request names another address than this account`s.')
      }

      const named = request.address
      const address =
        account?.address ?? (named && fromChain(() => chain.checksumAddress(named), 'The address is not one.'))
      const common = {origin: request.origin, path, requestId: request.requestId, ...(address ? {address} : {})}

      const isTransaction = request.dataType === 'legacy-transaction' || request.dataType === 'typed-transaction'

      // A transaction request names its chain (1 when it does not, as the schema says). Typed data and messages need
      // not: MetaMask's and Keystone's keyrings leave it out, and typed data names its chain in its domain. When they
      // name one, it is this network's.
      if ((isTransaction || request.chainId !== undefined) && (request.chainId ?? 1) !== chainId) {
        throw mismatch(`The request is for chain id ${request.chainId ?? 1}, not ${chainId} (${chain.network.name}).`)
      }

      if (request.dataType === 'personal-message') {
        const text = readableText(request.signData)

        return Object.freeze({
          ...common,
          kind: 'message',
          message: request.signData,
          ...(text === undefined ? {} : {text}),
        })
      }

      return Object.freeze({
        ...common,
        ...(isTransaction ? reviewTransaction(request) : reviewTypedDataRequest(request)),
      })
    },
    decodeSignResponse: (ur: UR, {request}: {readonly request: EthereumAirgapRequest}): EthereumAirgapResponse => {
      const answer = fromUR(ETH_SIGNATURE, ur)

      if (answer.requestId !== request.requestId) {
        throw mismatch('The signature answers another request than this one.')
      }

      const origin = answer.origin === undefined ? {} : {origin: answer.origin}

      if ('message' in request) {
        const signature = legacyV(answer.signature)
        const valid = fromChain(
          () => chain.verifyMessage({address: request.account.address, message: request.message, signature}),
          'The signature is not one this reads.'
        )

        if (!valid) {
          throw mismatch('The message signature is not by the account asked.')
        }

        return Object.freeze({kind: 'message', signature, ...origin})
      }

      if ('typedData' in request) {
        const signature = legacyV(answer.signature)
        const valid = fromChain(
          () => chain.verifyTypedData({...request.typedData, address: request.account.address, signature}),
          'The signature is not one this reads.'
        )

        if (!valid) {
          throw mismatch('The typed data signature is not by the account asked, or not of this typed data.')
        }

        return Object.freeze({kind: 'typed-data', signature, ...origin})
      }

      const signature = recoverableOf(answer.signature, request.transaction.type === 'legacy' ? chainId : undefined)
      const signer = fromChain(
        () => chain.recoverTransactionAddress({signature, transaction: request.transaction}),
        'The signature is not one this reads.'
      )

      if (signer !== request.account.address) {
        throw mismatch('The transaction signature is not by the account asked, or not of this transaction.')
      }

      return Object.freeze({
        kind: 'transaction',
        transaction: fromChain(
          () => chain.assembleTransaction(request.transaction, signature),
          'The signature does not fit the transaction.'
        ),
        ...origin,
      })
    },
    encodeSignRequest: (request: EthereumAirgapRequest) => toUR(ETH_SIGN_REQUEST, signRequestOf(request)),
    encodeSignResponse: ({origin, requestId, signature}: EthereumSignature) =>
      toUR(ETH_SIGNATURE, {origin, requestId, signature: signatureBytes(signature)}),
    pairingKey: ({path, publicKey}, fingerprint) => {
      const uncompressed = hex.decode(publicKey)

      if (uncompressed.length !== 65 || uncompressed[0] !== 0x04) {
        throw new AirgapError('INVALID_ARGUMENT', 'An Ethereum account`s public key is 65 bytes, uncompressed.')
      }

      // Compressing needs no curve arithmetic: the parity of y picks the prefix, and x follows.
      const compressed = bytes.concat(Uint8Array.of(0x02 | ((uncompressed[64] ?? 0) & 1)), uncompressed.subarray(1, 33))

      return {keyData: compressed, origin: parseKeypath(path, fingerprint), useInfo: {network: 0, type: 60}}
    },
    requestTypes: Object.freeze(['eth-sign-request']),
    responseTypes: Object.freeze(['eth-signature']),
    signRequest: async (request: EthereumSignRequest, account: (path: string) => Promise<EthereumAccount>) => {
      const signer = await account(request.path)

      if (signer.path !== request.path || (request.address !== undefined && signer.address !== request.address)) {
        throw mismatch('The request names an address this wallet does not have at that path.')
      }

      let signature: RecoverableSignature | Hex

      if (request.kind === 'transaction') {
        const signed = await signer.signTransaction(request.transaction)
        signature =
          request.transaction.type === 'legacy' ? eip155Signature(signed.signature, chainId) : signed.signature
      } else if (request.kind === 'typed-data') {
        signature = await signer.signTypedData(request.typedData)
      } else {
        signature = await signer.signMessage({message: request.message})
      }

      return Object.freeze({signature, ...(request.requestId === undefined ? {} : {requestId: request.requestId})})
    },
    watchAccount,
  })
}
