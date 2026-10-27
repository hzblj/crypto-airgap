import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {after, describe, test} from 'node:test'

import {
  createMultipartDecoder,
  createMultipartEncoder,
  createRequestId,
  encodeUR,
  fromUR,
  isAirgapError,
  parseKeypath,
  toUR,
} from '@hzblj/crypto-airgap'
import {type EthereumTransactionRequest, ethereumAdapter, type TypedDataDefinition} from '@hzblj/crypto-ethereum'
import {hex, utf8} from '@hzblj/nitro-crypto/adapter'
import {createTestCryptoEngine} from '@hzblj/nitro-crypto/testing'
import {DataType, ETHSignature, EthSignRequest} from '@keystonehq/bc-ur-registry-eth'
import {
  hashTypedData,
  parseTransaction,
  recoverTransactionAddress,
  type TransactionSerialized,
  verifyMessage,
  verifyTypedData,
} from 'viem'
import {recoverAuthorizationAddress} from 'viem/utils'

import {
  ETH_SIGN_REQUEST,
  ETH_SIGNATURE,
  type EthereumAirgapRequest,
  type EthereumSignRequest,
  ethereumAirgap,
  parseTypedData,
  typedDataJson,
} from '../src'

const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const SEPOLIA = 11_155_111
const HARDWARE = JSON.parse(readFileSync(new URL('./vectors/hardware.json', import.meta.url), 'utf8'))

const crypto = createTestCryptoEngine({adapters: [ethereumAdapter({chainId: SEPOLIA, name: 'Sepolia'})]})
const chain = crypto.chains.ethereum
const airgap = ethereumAirgap(chain)
const mainnet = createTestCryptoEngine({adapters: [ethereumAdapter()]})
const mainnetAirgap = ethereumAirgap(mainnet.chains.ethereum)

const throwsCode = (run: () => unknown, code: Parameters<typeof isAirgapError>[1]) =>
  assert.throws(run, error => isAirgapError(error, code))

const counter = (start: number) => {
  let next = start

  return (length: number) => Uint8Array.from({length}, () => next++ & 0xff)
}

/** What the camera sees: a multipart message, read by a decoder that loses one part in three. */
const transmit = (ur: Parameters<typeof createMultipartEncoder>[0], allowedTypes: readonly string[]) => {
  const encoder = createMultipartEncoder(ur, {maxFragmentLength: 50, sha256: crypto.hash.sha256})
  const decoder = createMultipartDecoder({allowedTypes, sha256: crypto.hash.sha256})
  let count = 0

  while (!decoder.isComplete()) {
    const part = encoder.nextPart()

    if (count++ % 3 !== 1) {
      decoder.receivePart(part)
    }
  }

  return decoder.result()
}

const TOKEN = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'
const DELEGATE = '0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B'

/** EIP-2612's Permit, as a dApp asks for it: on Sepolia, with a uint256 no JSON number holds exactly. */
const permit = (owner: string, spender: string): TypedDataDefinition => ({
  domain: {chainId: SEPOLIA, name: 'USD Coin', verifyingContract: TOKEN, version: '2'},
  message: {deadline: 1_900_000_000n, nonce: 0n, owner, spender, value: 2n ** 255n + 7n},
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
})

describe('every ERC-4527 data type, both sides', async () => {
  const wallet = await crypto.createEphemeralWallet({mnemonic: ABANDON})
  const signer = await wallet.deriveAccount({chain: 'ethereum', index: 0})
  const other = await wallet.deriveAccount({chain: 'ethereum', index: 1})
  const context = {accountPath: "m/44'/60'/0'", fingerprint: wallet.fingerprint}
  const account = {address: signer.address, fingerprint: wallet.fingerprint, path: signer.path}
  const deriveAt = (path: string) => wallet.deriveAccount({chain: 'ethereum', path})
  after(() => wallet.dispose())

  /** A request out through lossy multipart, read and signed by the signer, and its answer checked. */
  const roundTrip = async (request: EthereumAirgapRequest) => {
    const review = airgap.decodeSignRequest(transmit(airgap.encodeSignRequest(request), airgap.requestTypes), context)
    const answer = airgap.encodeSignResponse(await airgap.signRequest(review, deriveAt))

    return {answer, response: airgap.decodeSignResponse(transmit(answer, airgap.responseTypes), {request}), review}
  }

  const transactionOf = (review: EthereumSignRequest) => {
    assert.ok(review.kind === 'transaction')

    return review
  }

  test('a legacy transaction (data type 1) is answered with EIP-155`s v, as Keystone answers it', async () => {
    const transaction: EthereumTransactionRequest = {
      gas: 21_000n,
      gasPrice: 20_000_000_000n,
      nonce: 9,
      to: other.address,
      type: 'legacy',
      value: 10n ** 16n,
    }
    const request = {account, requestId: createRequestId(counter(1)), transaction}
    assert.equal(fromUR(ETH_SIGN_REQUEST, airgap.encodeSignRequest(request)).dataType, 'legacy-transaction')

    const {answer, response, review} = await roundTrip(request)
    const read = transactionOf(review)
    assert.equal(read.transaction.type, 'legacy')
    assert.equal(read.maxFee, 21_000n * 20_000_000_000n)
    assert.deepEqual(read.warnings, [])

    // v = 11155111 × 2 + 35 + parity: four bytes after r || s.
    const {signature} = fromUR(ETH_SIGNATURE, answer)
    assert.equal(signature.length, 68)
    const v = Number.parseInt(hex.encode(signature.subarray(64)), 16)
    assert.ok(v === SEPOLIA * 2 + 35 || v === SEPOLIA * 2 + 36)

    assert.ok(response.kind === 'transaction')
    const serialized = response.transaction.serialized as TransactionSerialized
    assert.equal(await recoverTransactionAddress({serializedTransaction: serialized}), signer.address)
    assert.equal(parseTransaction(serialized).type, 'legacy')
    assert.equal(parseTransaction(serialized).chainId, SEPOLIA)
  })

  test('EIP-2930 and EIP-1559 transactions with access lists, and a contract creation', async () => {
    const accessList = [{address: TOKEN, storageKeys: [`0x${'00'.repeat(31)}01` as const]}]
    const eip2930 = await roundTrip({
      account,
      requestId: createRequestId(counter(20)),
      transaction: {accessList, gas: 60_000n, gasPrice: 3_000_000_000n, nonce: 1, to: TOKEN, type: 'eip2930'},
    })
    assert.equal(transactionOf(eip2930.review).transaction.type, 'eip2930')
    assert.equal(fromUR(ETH_SIGNATURE, eip2930.answer).signature.length, 65)
    assert.ok(eip2930.response.kind === 'transaction')
    const parsed = parseTransaction(eip2930.response.transaction.serialized as TransactionSerialized)
    assert.equal(parsed.type, 'eip2930')
    assert.equal(parsed.accessList?.[0]?.storageKeys.length, 1)
    assert.equal(
      await recoverTransactionAddress({
        serializedTransaction: eip2930.response.transaction.serialized as TransactionSerialized,
      }),
      signer.address
    )

    const creation = await roundTrip({
      account,
      requestId: createRequestId(counter(40)),
      transaction: {
        accessList,
        data: '0x6080604052',
        gas: 200_000n,
        maxFeePerGas: 30_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
        nonce: 2,
        to: null,
      },
    })
    const review = transactionOf(creation.review)
    assert.equal(review.transaction.to, null)
    assert.equal(review.transaction.type, 'eip1559')
    assert.deepEqual(review.warnings, ['CONTRACT_CREATION'])
    assert.equal(review.erc20Transfer, undefined)
    assert.ok(creation.response.kind === 'transaction')
    assert.equal(parseTransaction(creation.response.transaction.serialized as TransactionSerialized).to ?? null, null)
  })

  test('an EIP-7702 transaction shows whose code it sets, and to which contract', async () => {
    const authorization = await signer.signAuthorization({address: DELEGATE, nonce: 4})
    const everywhere = await other.signAuthorization({address: DELEGATE, allowAllChains: true, chainId: 0, nonce: 0})
    const {response, review} = await roundTrip({
      account,
      requestId: createRequestId(counter(60)),
      transaction: {
        authorizationList: [authorization, everywhere],
        data: '0x',
        gas: 100_000n,
        maxFeePerGas: 30_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
        nonce: 3,
        to: signer.address,
        type: 'eip7702',
      },
    })
    const read = transactionOf(review)

    assert.equal(read.transaction.type, 'eip7702')
    assert.deepEqual(read.warnings, ['DELEGATION', 'ALL_CHAINS_DELEGATION'])
    assert.deepEqual(read.authorizations, [
      {address: DELEGATE, authority: signer.address, chainId: SEPOLIA, nonce: 4n},
      {address: DELEGATE, authority: other.address, chainId: 0, nonce: 0n},
    ])

    assert.ok(response.kind === 'transaction')
    const parsed = parseTransaction(response.transaction.serialized as TransactionSerialized)
    assert.equal(parsed.type, 'eip7702')
    const [first] = parsed.authorizationList ?? []
    assert.ok(first)
    assert.equal(await recoverAuthorizationAddress({authorization: first}), signer.address)
    assert.equal(
      await recoverTransactionAddress({
        serializedTransaction: response.transaction.serialized as TransactionSerialized,
      }),
      signer.address
    )
  })

  test('EIP-712 typed data (data type 2) goes out as JSON, is read as it is hashed, and comes back verified', async () => {
    const typedData = permit(signer.address, other.address)
    const request = {account, requestId: createRequestId(counter(80)), typedData}
    const sent = fromUR(ETH_SIGN_REQUEST, airgap.encodeSignRequest(request))
    assert.equal(sent.dataType, 'typed-data')
    // The uint256 travels as decimal text, which no JSON number would hold exactly.
    assert.match(utf8.decode(sent.signData), new RegExp(`"value":"${2n ** 255n + 7n}"`))

    const {response, review} = await roundTrip(request)
    assert.ok(review.kind === 'typed-data')
    assert.deepEqual(review.warnings, [])
    assert.equal(review.typedData.domain?.chainId, SEPOLIA)
    assert.deepEqual(review.typedData.message, {
      deadline: 1_900_000_000n,
      nonce: 0n,
      owner: signer.address,
      spender: other.address,
      value: 2n ** 255n + 7n,
    })

    assert.ok(response.kind === 'typed-data')
    assert.equal(
      await verifyTypedData({...typedData, address: signer.address, signature: response.signature} as never),
      true
    )
    assert.equal(response.signature, await signer.signTypedData(typedData))

    // A domain that names no chain is signed, and said: the signature is valid on every chain.
    const unbound = {...typedData, domain: {name: 'USD Coin', verifyingContract: TOKEN, version: '2'}}
    const types = {
      ...typedData.types,
      EIP712Domain: (typedData.types.EIP712Domain ?? []).filter(field => field.name !== 'chainId'),
    }
    const noChain = airgap.decodeSignRequest(
      airgap.encodeSignRequest({account, requestId: createRequestId(counter(90)), typedData: {...unbound, types}}),
      context
    )
    assert.ok(noChain.kind === 'typed-data')
    assert.deepEqual(noChain.warnings, ['NO_CHAIN_ID'])
  })

  test('typed data for another chain, or that does not hash, is refused before it is shown', () => {
    const typedData = permit(signer.address, other.address)
    const forMainnet = toUR(ETH_SIGN_REQUEST, {
      dataType: 'typed-data',
      derivationPath: parseKeypath(signer.path, wallet.fingerprint),
      signData: utf8.encode(typedDataJson({...typedData, domain: {...typedData.domain, chainId: 1}})),
    })
    throwsCode(() => airgap.decodeSignRequest(forMainnet, context), 'REQUEST_MISMATCH')
    throwsCode(
      () =>
        airgap.encodeSignRequest({
          account,
          requestId: createRequestId(counter(1)),
          typedData: {...typedData, primaryType: 'Nope'},
        }),
      'INVALID_PROTOCOL_DATA'
    )

    for (const json of [
      '{"types":{},"primaryType":"Permit","message":{}}',
      '{"types":{"Permit":[]},"primaryType":"Permit","message":{},"types":{}}',
      '[1, 2]',
      '{"types":{"M":[{"name":"v","type":"uint256"}]},"primaryType":"M","domain":{"name":"x"},"message":{"v":1.5}}',
    ]) {
      const ur = toUR(ETH_SIGN_REQUEST, {
        dataType: 'typed-data',
        derivationPath: parseKeypath(signer.path, wallet.fingerprint),
        signData: utf8.encode(json),
      })
      throwsCode(() => airgap.decodeSignRequest(ur, context), 'INVALID_PROTOCOL_DATA')
    }
  })

  test('a request MetaMask`s QR keyring writes for typed data and a message, without a chain id, is signed and read back its way', async () => {
    // @metamask/eth-qr-keyring 3.0.1 (device.ts): JSON.stringify of the dApp's eth_signTypedData_v4 object, no chain id,
    // and the answer read as r, s and v sliced from the signature. The dApp writes numbers as JSON numbers and text.
    const typedData = {
      domain: {chainId: String(SEPOLIA), name: 'USD Coin', verifyingContract: TOKEN.toLowerCase(), version: '2'},
      message: {deadline: 1_900_000_000, nonce: '0x0', owner: signer.address, spender: other.address, value: '1000000'},
      primaryType: 'Permit',
      types: permit(signer.address, other.address).types,
    }
    const requestId = '6f1a3c1e-6c8e-4a63-9b4d-2f1d8b6c4a10'
    const theirs = EthSignRequest.constructETHRequest(
      Buffer.from(JSON.stringify(typedData), 'utf8'),
      DataType.typedData,
      signer.path,
      wallet.fingerprint.toString(16).padStart(8, '0'),
      requestId,
      undefined,
      signer.address
    )
    const review = airgap.decodeSignRequest({cbor: theirs.toCBOR(), type: 'eth-sign-request'}, context)
    assert.ok(review.kind === 'typed-data')
    assert.equal(review.typedData.domain?.verifyingContract, TOKEN)
    assert.equal(review.typedData.message.value, 1_000_000n)

    const read = ETHSignature.fromCBOR(
      Buffer.from(airgap.encodeSignResponse(await airgap.signRequest(review, deriveAt)).cbor)
    )
    assert.equal(read.getRequestId()?.toString('hex'), requestId.replaceAll('-', ''))
    const signature = read.getSignature()
    const joined =
      `0x${Buffer.concat([signature.subarray(0, 32), signature.subarray(32, 64), signature.subarray(64)]).toString('hex')}` as const
    assert.equal(await verifyTypedData({...typedData, address: signer.address, signature: joined} as never), true)
    assert.equal(hashTypedData(typedData as never), hex.encode(chain.hashTypedData(review.typedData), {prefix: true}))

    // A personal message the same way: no chain id, which a message's signature does not bind anyway.
    const message = EthSignRequest.constructETHRequest(
      Buffer.from('Sign in to Sepolia'),
      DataType.personalMessage,
      signer.path,
      wallet.fingerprint.toString(16).padStart(8, '0'),
      requestId,
      undefined,
      signer.address
    )
    const messageReview = airgap.decodeSignRequest({cbor: message.toCBOR(), type: 'eth-sign-request'}, context)
    const messageAnswer = ETHSignature.fromCBOR(
      Buffer.from(airgap.encodeSignResponse(await airgap.signRequest(messageReview, deriveAt)).cbor)
    ).getSignature()
    assert.equal(
      await verifyMessage({
        address: signer.address,
        message: 'Sign in to Sepolia',
        signature: `0x${messageAnswer.toString('hex')}`,
      }),
      true
    )

    // A request that names a chain id names this one, whatever it asks.
    const elsewhere = EthSignRequest.constructETHRequest(
      Buffer.from('Sign in'),
      DataType.personalMessage,
      signer.path,
      wallet.fingerprint.toString(16).padStart(8, '0'),
      requestId,
      1
    )
    throwsCode(
      () => airgap.decodeSignRequest({cbor: elsewhere.toCBOR(), type: 'eth-sign-request'}, context),
      'REQUEST_MISMATCH'
    )
  })

  test('answers of another typed data, by another key, or with a v no signer writes are refused', async () => {
    const typedData = permit(signer.address, other.address)
    const request = {account, requestId: createRequestId(counter(100)), typedData}
    const answer = (signature: `0x${string}`) =>
      airgap.decodeSignResponse(airgap.encodeSignResponse({requestId: request.requestId, signature}), {request})

    const byOther = await other.signTypedData(typedData)
    const ofAnother = await signer.signTypedData({...typedData, message: {...typedData.message, value: 1n}})
    throwsCode(() => answer(byOther), 'REQUEST_MISMATCH')
    throwsCode(() => answer(ofAnother), 'REQUEST_MISMATCH')
    const good = await signer.signTypedData(typedData)
    throwsCode(() => answer(`${good.slice(0, -2)}05` as `0x${string}`), 'INVALID_PROTOCOL_DATA')
    assert.equal(answer(`${good.slice(0, -2)}${good.endsWith('1b') ? '00' : '01'}` as `0x${string}`).kind, 'typed-data')

    const legacy = {
      account,
      requestId: createRequestId(counter(120)),
      transaction: {gas: 21_000n, gasPrice: 1n, nonce: 0, to: other.address, type: 'legacy' as const},
    }
    const signed = await signer.signTransaction(legacy.transaction)
    // v as the parity, 27 or 28, or EIP-155's: each reads, and recovers the signer.
    for (const v of [signed.signature.recovery, 27 + signed.signature.recovery]) {
      const response = airgap.decodeSignResponse(
        airgap.encodeSignResponse({
          requestId: legacy.requestId,
          signature: hex.encode(Uint8Array.of(...signed.signature.signature, v), {prefix: true}) as `0x${string}`,
        }),
        {request: legacy}
      )
      assert.ok(response.kind === 'transaction')
      assert.deepEqual(response.transaction, signed)
    }
    // EIP-155's v for mainnet is not Sepolia's.
    const mainnetV = hex.encode(Uint8Array.of(...signed.signature.signature, 37 + signed.signature.recovery), {
      prefix: true,
    }) as `0x${string}`
    throwsCode(
      () =>
        airgap.decodeSignResponse(airgap.encodeSignResponse({requestId: legacy.requestId, signature: mainnetV}), {
          request: legacy,
        }),
      'INVALID_PROTOCOL_DATA'
    )
  })

  test('the data type says which transaction it is, and a blob transaction is not one', () => {
    const unsigned = hex.decode(
      chain.serializeTransaction({gas: 21_000n, gasPrice: 1n, nonce: 0, to: other.address, type: 'legacy'})
    )
    const typed = hex.decode(
      chain.serializeTransaction({
        gas: 21_000n,
        maxFeePerGas: 2n,
        maxPriorityFeePerGas: 1n,
        nonce: 0,
        to: other.address,
      })
    )
    const request = (dataType: 'legacy-transaction' | 'typed-transaction', signData: Uint8Array) =>
      toUR(ETH_SIGN_REQUEST, {
        chainId: SEPOLIA,
        dataType,
        derivationPath: parseKeypath(signer.path, wallet.fingerprint),
        signData,
      })

    throwsCode(() => airgap.decodeSignRequest(request('typed-transaction', unsigned), context), 'INVALID_PROTOCOL_DATA')
    throwsCode(() => airgap.decodeSignRequest(request('legacy-transaction', typed), context), 'INVALID_PROTOCOL_DATA')
    throwsCode(
      () => airgap.decodeSignRequest(request('typed-transaction', Uint8Array.of(0x03, ...typed.subarray(1))), context),
      'INVALID_PROTOCOL_DATA'
    )

    // A transaction whose own chain id is another than the request says is refused as a mismatch.
    const mainnetTransaction = hex.decode(
      mainnet.chains.ethereum.serializeTransaction({
        gas: 21_000n,
        gasPrice: 1n,
        nonce: 0,
        to: other.address,
        type: 'legacy',
      })
    )
    throwsCode(
      () => airgap.decodeSignRequest(request('legacy-transaction', mainnetTransaction), context),
      'REQUEST_MISMATCH'
    )
  })
})

describe('Keystone 3`s firmware, signing: the same signatures', async () => {
  const wallet = await mainnet.createEphemeralWallet({mnemonic: ABANDON})
  const vectors = HARDWARE.keystoneSigning
  const context = {accountPath: "m/44'/60'/0'", fingerprint: wallet.fingerprint}
  const deriveAt = (path: string) => wallet.deriveAccount({chain: 'ethereum', path})
  after(() => wallet.dispose())

  const requestOf = (dataType: 'typed-data' | 'personal-message', data: string) =>
    toUR(ETH_SIGN_REQUEST, {
      dataType,
      derivationPath: parseKeypath(vectors.path, wallet.fingerprint),
      requestId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
      signData: hex.decode(data),
    })

  test('a Seaport order as eth_signTypedData_v4 JSON: read as Keystone reads it, and signed byte for byte as it signs', async () => {
    const review = mainnetAirgap.decodeSignRequest(requestOf('typed-data', vectors.typedData), context)
    assert.ok(review.kind === 'typed-data')
    assert.equal(review.typedData.primaryType, 'OrderComponents')
    assert.equal(review.typedData.domain?.chainId, 1)
    assert.equal(review.typedData.message.salt, 16_178_208_897_136_618n)
    // A member its types do not declare is not signed, so it is not shown.
    assert.equal('totalOriginalConsiderationItems' in review.typedData.message, false)
    assert.deepEqual(review.warnings, [])

    const answer = await mainnetAirgap.signRequest(review, deriveAt)
    assert.equal(answer.signature, `0x${vectors.typedDataSignature}`)

    // viem hashes the same JSON, parsed its own way, to the same digest.
    const json = JSON.parse(utf8.decode(hex.decode(vectors.typedData)))
    assert.equal(
      hashTypedData(json),
      hex.encode(mainnet.chains.ethereum.hashTypedData(parseTypedData(hex.decode(vectors.typedData))), {prefix: true})
    )
  })

  test('a personal message, byte for byte', async () => {
    const review = mainnetAirgap.decodeSignRequest(requestOf('personal-message', vectors.personalMessage), context)
    assert.ok(review.kind === 'message')
    assert.equal(review.text, 'Example `personal_sign` message')
    assert.equal((await mainnetAirgap.signRequest(review, deriveAt)).signature, `0x${vectors.personalMessageSignature}`)
  })

  test('a legacy transaction`s v in as few bytes as it takes: Keystone`s eth-signature reads, and Keystone`s registry reads ours', () => {
    const theirs = fromUR(ETH_SIGNATURE, {
      cbor: new ETHSignature(Buffer.from(vectors.eip155Signature, 'hex')).toCBOR(),
      type: 'eth-signature',
    })
    assert.equal(theirs.signature.length, 67)
    assert.equal(Number.parseInt(hex.encode(theirs.signature.subarray(64)), 16), vectors.eip155V)

    const ours = toUR(ETH_SIGNATURE, {signature: hex.decode(vectors.eip155Signature)})
    assert.equal(ETHSignature.fromCBOR(Buffer.from(ours.cbor)).getSignature().toString('hex'), vectors.eip155Signature)
    throwsCode(() => toUR(ETH_SIGNATURE, {signature: new Uint8Array(73)}), 'INVALID_ARGUMENT')
    throwsCode(() => toUR(ETH_SIGNATURE, {signature: new Uint8Array(64)}), 'INVALID_ARGUMENT')
  })

  test('typed data requests: the same CBOR as Keystone`s registry writes, for every data type', () => {
    const typedData = utf8.encode(typedDataJson(permit('0x70997970C51812dc3A010C7d01b50e0d17dc79C8', TOKEN)))
    for (const [dataType, theirsType] of [
      ['legacy-transaction', DataType.transaction],
      ['typed-data', DataType.typedData],
      ['personal-message', DataType.personalMessage],
      ['typed-transaction', DataType.typedTransaction],
    ] as const) {
      const theirs = EthSignRequest.constructETHRequest(
        Buffer.from(typedData),
        theirsType,
        vectors.path,
        '73c5da0a',
        '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
        SEPOLIA
      )
      const ours = toUR(ETH_SIGN_REQUEST, {
        chainId: SEPOLIA,
        dataType,
        derivationPath: parseKeypath(vectors.path, 0x73c5da0a),
        requestId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
        signData: typedData,
      })
      assert.equal(hex.encode(ours.cbor), theirs.toCBOR().toString('hex'))
      assert.equal(encodeUR(ours), theirs.toUREncoder(100_000).nextPart())
    }
  })
})

describe('typed data JSON, strictly', () => {
  const minimal = (message: string) =>
    `{"types":{"EIP712Domain":[{"name":"name","type":"string"}],"M":[{"name":"v","type":"uint256"}]},"primaryType":"M","domain":{"name":"x"},"message":${message}}`

  test('integers keep every digit, as a bigint beyond a safe number', () => {
    const max = (2n ** 256n - 1n).toString()
    assert.equal(parseTypedData(minimal(`{"v":${max}}`)).message.v, 2n ** 256n - 1n)
    assert.equal(parseTypedData(minimal('{"v":42}')).message.v, 42)
  })

  test('nesting to 32 levels reads, and 33 does not, as Keystone`s firmware counts them', () => {
    const nested = (depth: number) =>
      `{"types":{},"primaryType":"M","message":{"v":${'['.repeat(depth - 2)}0${']'.repeat(depth - 2)}}}`
    assert.doesNotThrow(() => parseTypedData(nested(32)))
    throwsCode(() => parseTypedData(nested(33)), 'INVALID_PROTOCOL_DATA')
  })

  test('a stringified payload reads, once, as Keystone reads it', () => {
    assert.equal(parseTypedData(JSON.stringify(minimal('{"v":1}'))).primaryType, 'M')
    throwsCode(() => parseTypedData(JSON.stringify(JSON.stringify(minimal('{"v":1}')))), 'INVALID_PROTOCOL_DATA')
  })

  test('what JSON or EIP-712 does not allow, or two parsers could read two ways, is refused', () => {
    for (const json of [
      minimal('{"v":1,}'),
      minimal('{"v":1,"v":2}'),
      minimal('{"v":01}'),
      minimal('{"v":1e3}'),
      minimal('{"v":NaN}'),
      minimal('{"v":"\\ud800"}'),
      minimal('{"v":"\\u0000"}'),
      minimal('{"v":"a\tb"}'),
      `${minimal('{"v":1}')} x`,
      `${minimal('{"v":1}')} // comment`,
      minimal(`{"v":${'9'.repeat(81)}}`),
      '',
    ]) {
      throwsCode(() => parseTypedData(json), 'INVALID_PROTOCOL_DATA')
    }

    throwsCode(() => parseTypedData(Uint8Array.of(0x7b, 0xff, 0x7d)), 'INVALID_PROTOCOL_DATA')
  })

  test('`__proto__` is a member like any other, never a prototype', () => {
    const typedData = parseTypedData(minimal('{"v":1,"__proto__":{"polluted":true}}'))
    assert.equal(Object.getPrototypeOf(typedData.message), Object.prototype)
    assert.equal(Object.hasOwn(typedData.message, '__proto__'), true)
    assert.equal(({} as Record<string, unknown>).polluted, undefined)
  })

  test('typedDataJson writes what parseTypedData reads back to the same digest', () => {
    const typedData = permit('0x70997970C51812dc3A010C7d01b50e0d17dc79C8', TOKEN)
    assert.deepEqual(chain.hashTypedData(parseTypedData(typedDataJson(typedData))), chain.hashTypedData(typedData))
  })
})
