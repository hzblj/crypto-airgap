import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {after, describe, test} from 'node:test'

import {createRequestId, fromUR, isAirgapError, parseKeypath, toUR} from '@hzblj/crypto-airgap'
import {solanaAdapter} from '@hzblj/crypto-solana'
import {base58, hex, utf8} from '@hzblj/nitro-crypto/adapter'
import {createTestCryptoEngine} from '@hzblj/nitro-crypto/testing'
import {SignType, SolSignRequest} from '@keystonehq/bc-ur-registry-sol'

import {SOL_SIGN_REQUEST, type SolanaAirgapRequest, type SolanaSignRequest, solanaAirgap} from '../src'

const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N'
const TABLE = base58.encode(new Uint8Array(32).fill(9))
const KEYSTONE = JSON.parse(readFileSync(new URL('./vectors/keystone.json', import.meta.url), 'utf8'))

const crypto = createTestCryptoEngine({adapters: [solanaAdapter({cluster: 'devnet'})]})
const chain = crypto.chains.solana
const airgap = solanaAirgap(chain)

const throwsCode = (run: () => unknown, code: Parameters<typeof isAirgapError>[1]) =>
  assert.throws(run, error => isAirgapError(error, code))

const counter = (start: number) => {
  let next = start

  return (length: number) => Uint8Array.from({length}, () => next++ & 0xff)
}

describe('versioned transactions, other signers, off-chain messages', async () => {
  const wallet = await crypto.createEphemeralWallet({mnemonic: ABANDON})
  const signer = await wallet.deriveAccount({chain: 'solana'})
  const other = await wallet.deriveAccount({account: 1, chain: 'solana'})
  const recipient = await wallet.deriveAccount({account: 2, chain: 'solana'})
  const account = {address: signer.address, fingerprint: wallet.fingerprint, path: signer.path}
  const context = {account}
  after(() => wallet.dispose())

  /** A request out, read and signed by the signer, and its answer checked. */
  const roundTrip = async (request: SolanaAirgapRequest) => {
    const review = airgap.decodeSignRequest(airgap.encodeSignRequest(request), context)
    const signed = await airgap.signRequest(review, signer)

    return {response: airgap.decodeSignResponse(airgap.encodeSignResponse(signed), {request}), review, signed}
  }

  const transactionOf = (review: SolanaSignRequest) => {
    assert.ok(review.kind === 'transaction')

    return review
  }

  test('a v0 transaction with a lookup table: the signer says what it cannot resolve, and signs the message', async () => {
    const transaction = {
      addressLookupTables: {[TABLE]: [other.address, recipient.address]},
      instructions: [chain.instructions.transfer({from: signer.address, lamports: 5_000n, to: recipient.address})],
      recentBlockhash: BLOCKHASH,
      version: 0 as const,
    }
    const {response, review} = await roundTrip({account, requestId: createRequestId(counter(1)), transaction})
    const read = transactionOf(review)

    assert.equal(read.decoded.version, 0)
    assert.deepEqual(read.decoded.addressTableLookups, [
      {lookupTable: TABLE, readonlyIndexes: [], writableIndexes: [1]},
    ])
    // The recipient comes from the table, which a sign request does not carry: shown as table and index, unnamed.
    const looked = read.decoded.accounts.find(entry => entry.lookup !== undefined)
    assert.deepEqual(looked, {
      address: undefined,
      isSigner: false,
      isWritable: true,
      lookup: {index: 1, lookupTable: TABLE},
    })
    assert.equal(read.decoded.instructions[0]?.summary.type, 'unknown')
    assert.deepEqual(read.warnings, ['UNKNOWN_INSTRUCTIONS', 'UNRESOLVED_LOOKUPS'])
    assert.equal(read.lamports, 0n)

    assert.ok(response.kind === 'transaction')
    assert.deepEqual(response.transaction, await signer.signTransaction(transaction))
  })

  test('a transaction others sign too: the answer fills the account`s slot, and every other slot is kept', async () => {
    const message = chain.compileMessage({
      feePayer: other.address,
      instructions: [
        chain.instructions.transfer({from: other.address, lamports: 1_000n, to: recipient.address}),
        chain.instructions.transfer({from: signer.address, lamports: 2_000n, to: recipient.address}),
      ],
      recentBlockhash: BLOCKHASH,
      version: 0,
    })
    const unsigned = Uint8Array.of(2, ...new Uint8Array(128), ...message)
    const paidFor = (await other.partiallySignTransaction(unsigned)).serialized

    for (const [serializedTransaction, complete] of [
      [unsigned, false],
      [paidFor, true],
    ] as const) {
      const request = {account, requestId: createRequestId(counter(20)), serializedTransaction}
      const {response, review} = await roundTrip(request)
      const read = transactionOf(review)

      assert.deepEqual(read.message, message)
      assert.deepEqual(read.warnings, ['NOT_FEE_PAYER', 'OTHER_SIGNERS'])
      assert.equal(read.lamports, 2_000n)

      assert.ok(response.kind === 'partially-signed')
      assert.equal(response.transaction.complete, complete)
      assert.deepEqual(response.transaction, await signer.partiallySignTransaction(serializedTransaction))
      const decoded = chain.decodeTransaction(response.transaction.serialized)
      assert.equal(decoded.signatures.filter(Boolean).length, complete ? 2 : 1)
    }

    // An answer by another key, or of another message, is refused; so is a transaction this account does not sign.
    const request = {account, requestId: createRequestId(counter(40)), serializedTransaction: paidFor}
    const wrong = await other.signMessage({message})
    throwsCode(
      () =>
        airgap.decodeSignResponse(airgap.encodeSignResponse({requestId: request.requestId, signature: wrong}), {
          request,
        }),
      'REQUEST_MISMATCH'
    )
    const notOurs = chain.compileMessage({
      feePayer: other.address,
      instructions: [chain.instructions.transfer({from: other.address, lamports: 1n, to: recipient.address})],
      recentBlockhash: BLOCKHASH,
    })
    throwsCode(
      () =>
        airgap.encodeSignRequest({
          account,
          requestId: request.requestId,
          serializedTransaction: Uint8Array.of(1, ...new Uint8Array(64), ...notOurs),
        }),
      'INVALID_ARGUMENT'
    )
  })

  test('off-chain messages, versions 0 and 1: shown as text with their signers, signed, and verified', async () => {
    for (const offchainMessage of [
      {signers: [signer.address], text: 'Sign in to Nitro Wallet', version: 1 as const},
      {
        applicationDomain: TABLE,
        signers: [signer.address, other.address],
        text: 'Approve the proposal',
        version: 0 as const,
      },
    ]) {
      const request = {account, offchainMessage, requestId: createRequestId(counter(60))}
      const sent = fromUR(SOL_SIGN_REQUEST, airgap.encodeSignRequest(request))
      assert.equal(sent.signType, 'message')

      const {response, review, signed} = await roundTrip(request)
      assert.ok(review.kind === 'offchain-message')
      assert.equal(review.decoded.text, offchainMessage.text)
      assert.deepEqual(review.warnings, offchainMessage.signers.length > 1 ? ['OTHER_SIGNERS'] : [])

      assert.ok(response.kind === 'offchain-message')
      assert.deepEqual(
        {message: response.message, signature: response.signature},
        await signer.signOffchainMessage(offchainMessage)
      )
      assert.ok(
        chain.verifyOffchainMessage({address: signer.address, message: response.message, signature: signed.signature})
      )
    }

    // The same bytes in Keystone's registry, as a message: there is no other sign type.
    const bytes = chain.encodeOffchainMessage({signers: [signer.address], text: 'Hello', version: 1})
    const theirs = SolSignRequest.constructSOLRequest(
      Buffer.from(bytes),
      signer.path,
      wallet.fingerprint.toString(16).padStart(8, '0'),
      SignType.Message,
      '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
    )
    const ours = toUR(SOL_SIGN_REQUEST, {
      derivationPath: parseKeypath(signer.path, wallet.fingerprint),
      requestId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
      signData: bytes,
      signType: 'message',
    })
    assert.equal(hex.encode(ours.cbor), theirs.toCBOR().toString('hex'))
    assert.equal(
      airgap.decodeSignRequest({cbor: theirs.toCBOR(), type: 'sol-sign-request'}, context).kind,
      'offchain-message'
    )
  })

  test('an off-chain message for other signers, sent as a transaction, malformed, or answered for another is refused', async () => {
    const forOthers = chain.encodeOffchainMessage({signers: [other.address], text: 'Hello', version: 1})
    const request = (signData: Uint8Array, signType: 'transaction' | 'message') =>
      toUR(SOL_SIGN_REQUEST, {derivationPath: parseKeypath(signer.path, wallet.fingerprint), signData, signType})

    throwsCode(() => airgap.decodeSignRequest(request(forOthers, 'message'), context), 'REQUEST_MISMATCH')
    const mine = chain.encodeOffchainMessage({signers: [signer.address], text: 'Hello', version: 1})
    throwsCode(() => airgap.decodeSignRequest(request(mine, 'transaction'), context), 'INVALID_PROTOCOL_DATA')
    throwsCode(
      () =>
        airgap.decodeSignRequest(
          request(Uint8Array.of(...mine.subarray(0, 16), 5, ...mine.subarray(17)), 'message'),
          context
        ),
      'INVALID_PROTOCOL_DATA'
    )
    throwsCode(
      () =>
        airgap.encodeSignRequest({
          account,
          offchainMessage: {signers: [other.address], text: 'Hello', version: 1},
          requestId: createRequestId(counter(80)),
        }),
      'INVALID_ARGUMENT'
    )

    const asked = {
      account,
      offchainMessage: {signers: [signer.address], text: 'Hello', version: 1 as const},
      requestId: createRequestId(counter(90)),
    }
    const another = await signer.signOffchainMessage({signers: [signer.address], text: 'Goodbye', version: 1})
    throwsCode(
      () =>
        airgap.decodeSignResponse(
          airgap.encodeSignResponse({requestId: asked.requestId, signature: another.signature}),
          {request: asked}
        ),
      'REQUEST_MISMATCH'
    )
  })

  test('a transaction of a later version is never signed, as a transaction or as a message', () => {
    for (const signType of ['transaction', 'message'] as const) {
      const ur = toUR(SOL_SIGN_REQUEST, {
        derivationPath: parseKeypath(signer.path, wallet.fingerprint),
        signData: Uint8Array.of(0x81, 1, 0, 1, ...new Uint8Array(64)),
        signType,
      })
      throwsCode(() => airgap.decodeSignRequest(ur, context), 'INVALID_PROTOCOL_DATA')
    }
  })
})

describe('Keystone 3`s firmware: the payloads it reads', async () => {
  const mainnet = solanaAirgap(createTestCryptoEngine({adapters: [solanaAdapter()]}).chains.solana)
  const wallet = await crypto.createEphemeralWallet({mnemonic: ABANDON})
  const signer = await wallet.deriveAccount({account: 0, chain: 'solana', path: "m/44'/501'/0'"})
  after(() => wallet.dispose())

  test('v0 transactions that load accounts from lookup tables: read for their fee payer, the lookups said', () => {
    for (const message of KEYSTONE.versionedMessages) {
      const signData = hex.decode(message)
      const payer = base58.encode(signData.subarray(5, 37))
      const review = mainnet.decodeSignRequest(
        toUR(SOL_SIGN_REQUEST, {derivationPath: parseKeypath("m/44'/501'/0'/0'"), signData, signType: 'transaction'}),
        {account: {address: payer, fingerprint: 0x12121212, path: "m/44'/501'/0'/0'"}}
      )
      assert.ok(review.kind === 'transaction')
      assert.equal(review.decoded.version, 0)
      assert.equal(review.decoded.feePayer, payer)
      assert.ok(review.decoded.addressTableLookups.length > 0)
      assert.ok(review.warnings.includes('UNRESOLVED_LOOKUPS'))
    }
  })

  test('a sign-in in the solana CLI`s older off-chain format: its text shown, as Keystone shows it, and its bytes signed', async () => {
    const signData = hex.decode(KEYSTONE.offchainLegacy)
    const review = mainnet.decodeSignRequest(
      toUR(SOL_SIGN_REQUEST, {
        derivationPath: parseKeypath(signer.path, wallet.fingerprint),
        signData,
        signType: 'message',
      }),
      {account: {address: signer.address, fingerprint: wallet.fingerprint, path: signer.path}}
    )
    assert.ok(review.kind === 'message')
    assert.ok(review.text?.startsWith('magiceden.io wants you to sign in'))
    assert.ok(review.text?.endsWith('c1314b5b-ece8-4b4f-a879-3894dda364e4'))

    const {signature} = await mainnet.signRequest(review, signer)
    assert.ok(chain.verifyMessage({address: signer.address, message: signData, signature}))
    // The header Keystone checks: one byte more than its length says is not that format, nor the specification's.
    const longer = Uint8Array.of(...signData, 0x0a)
    throwsCode(
      () =>
        mainnet.decodeSignRequest(
          toUR(SOL_SIGN_REQUEST, {derivationPath: parseKeypath(signer.path), signData: longer, signType: 'message'}),
          {account: {address: signer.address, fingerprint: wallet.fingerprint, path: signer.path}}
        ),
      'INVALID_PROTOCOL_DATA'
    )
    assert.equal(utf8.decode(signData.subarray(1, 16)), 'solana offchain')
  })
})
