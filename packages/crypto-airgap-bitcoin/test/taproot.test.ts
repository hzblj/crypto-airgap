import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {after, describe, test} from 'node:test'

import {
  createMultipartDecoder,
  createMultipartEncoder,
  encodeUR,
  fromUR,
  isAirgapError,
  toUR,
} from '@hzblj/crypto-airgap'
import {type BitcoinAccountType, bitcoinAdapter} from '@hzblj/crypto-bitcoin'
import {hex} from '@hzblj/nitro-crypto/adapter'
import {createTestCryptoEngine} from '@hzblj/nitro-crypto/testing'
import {HDKey} from '@scure/bip32'
import {mnemonicToSeedSync} from '@scure/bip39'
import {Transaction} from '@scure/btc-signer'

import {bitcoinAirgap, CRYPTO_ACCOUNT, CRYPTO_OUTPUT, CRYPTO_PSBT} from '../src'

const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const KEYSTONE = JSON.parse(readFileSync(new URL('./vectors/keystone.json', import.meta.url), 'utf8'))
const HARDENED = 0x80000000

const testnet = createTestCryptoEngine({adapters: [bitcoinAdapter({network: 'testnet'})]})
const mainnet = createTestCryptoEngine({adapters: [bitcoinAdapter()]})
const airgap = bitcoinAirgap(testnet.chains.bitcoin)
const mainnetAirgap = bitcoinAirgap(mainnet.chains.bitcoin)

const throwsCode = (run: () => unknown, code: Parameters<typeof isAirgapError>[1]) =>
  assert.throws(run, error => isAirgapError(error, code))

/** Every part of a UR, read by a decoder that loses one in three. */
const transmit = (ur: Parameters<typeof createMultipartEncoder>[0], allowedTypes: readonly string[]) => {
  const encoder = createMultipartEncoder(ur, {maxFragmentLength: 80, sha256: testnet.hash.sha256})
  const decoder = createMultipartDecoder({allowedTypes, sha256: testnet.hash.sha256})
  let count = 0

  while (!decoder.isComplete()) {
    const part = encoder.nextPart()

    if (count++ % 3 !== 1) {
      decoder.receivePart(part)
    }
  }

  return decoder.result()
}

/** A BIP-32 path as @scure/btc-signer writes it in a PSBT. */
const indexes = (path: string) =>
  path
    .slice(2)
    .split('/')
    .map(step => (step.endsWith("'") ? Number.parseInt(step, 10) + HARDENED : Number.parseInt(step, 10)))

describe('Taproot accounts: tr() descriptors, as Keystone and Sparrow pair BIP-86 accounts', () => {
  test('Keystone 3`s crypto-account: its BIP-84 and BIP-86 accounts watched at BIP-84`s and BIP-86`s own addresses', () => {
    const imported = mainnetAirgap.decodeAccount({
      cbor: hex.decode(KEYSTONE.firmwareAccount.cbor),
      type: 'crypto-account',
    })

    assert.equal(imported.masterFingerprint, 0x73c5da0a)
    assert.deepEqual(
      imported.descriptors.map(descriptor => descriptor.scripts.join('(')),
      ['wpkh', 'pkh', 'sh(wpkh', 'tr']
    )
    // BIP-84's and BIP-86's published first receiving addresses of the phrase: P2WPKH and Taproot are watched, the rest
    // (pkh, sh(wpkh)) are descriptors this package reads but does not spend from.
    assert.deepEqual(
      imported.accounts.map(account => [account.addressType, account.path, account.address]),
      [
        ['p2wpkh', "m/84'/0'/0'/0/0", 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'],
        ['p2tr', "m/86'/0'/0'/0/0", 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr'],
      ]
    )

    // Written the specification's way, with the 308 tag, it reads back as the same descriptors.
    const respoken = fromUR(CRYPTO_ACCOUNT, toUR(CRYPTO_ACCOUNT, imported))
    assert.deepEqual(respoken.descriptors, imported.descriptors)
  })

  test('an account key from this engine is written as Keystone writes it: tr for BIP-86, and the xpub BIP-86 publishes', async () => {
    const wallet = await mainnet.createEphemeralWallet({mnemonic: ABANDON})
    const keys = ["m/84'/0'/0'", "m/86'/0'/0'"].map(path =>
      mainnetAirgap.accountKey({extendedKey: wallet.extendedPublicKey(path), fingerprint: wallet.fingerprint, path})
    )
    const ur = mainnetAirgap.encodeAccount({keys, masterFingerprint: wallet.fingerprint})
    const descriptors = fromUR(CRYPTO_ACCOUNT, ur).descriptors
    const theirs = mainnetAirgap.decodeAccount({
      cbor: hex.decode(KEYSTONE.firmwareAccount.cbor),
      type: 'crypto-account',
    })

    assert.deepEqual(
      descriptors.map(descriptor => descriptor.scripts),
      [['wpkh'], ['tr']]
    )
    for (const [index, descriptor] of descriptors.entries()) {
      const ours = descriptor.keys[0]
      const keystone = theirs.descriptors[index === 0 ? 0 : 3]?.keys[0]
      assert.ok(ours && 'hdkey' in ours && keystone && 'hdkey' in keystone)
      assert.deepEqual(ours.hdkey.keyData, keystone.hdkey.keyData)
      assert.deepEqual(ours.hdkey.chainCode, keystone.hdkey.chainCode)
      // Keystone also states the origin's depth (3) and the children (0/*), which a reader derives anyway.
      const {depth, ...origin} = keystone.hdkey.origin ?? {components: []}
      assert.equal(depth, 3)
      assert.deepEqual(ours.hdkey.origin, origin)
      assert.equal(ours.hdkey.parentFingerprint, keystone.hdkey.parentFingerprint)
    }
    assert.deepEqual(
      mainnetAirgap.decodeAccount(ur).accounts.map(account => account.address),
      theirs.accounts.map(account => account.address)
    )

    // One account as a crypto-output, which Sparrow imports too.
    const [, taproot] = keys
    assert.ok(taproot)
    const output = mainnetAirgap.encodeOutput(taproot)
    assert.equal(output.type, 'crypto-output')
    assert.deepEqual(fromUR(CRYPTO_OUTPUT, output).scripts, ['tr'])
    const single = mainnetAirgap.decodeAccount(output)
    assert.equal(single.masterFingerprint, wallet.fingerprint)
    assert.equal(single.accounts[0]?.address, 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr')

    // The reference derives the same account key BIP-86 lists.
    assert.equal(
      HDKey.fromMasterSeed(mnemonicToSeedSync(ABANDON)).derive("m/86'/0'/0'").publicExtendedKey,
      KEYSTONE.firmwareAccount.xpubs[3].xpub
    )

    // A key at a purpose with no descriptor here is not shared as one.
    throwsCode(
      () =>
        mainnetAirgap.encodeAccount({
          keys: [
            mainnetAirgap.accountKey({
              extendedKey: wallet.extendedPublicKey("m/49'/0'/0'"),
              fingerprint: wallet.fingerprint,
              path: "m/49'/0'/0'",
            }),
          ],
          masterFingerprint: wallet.fingerprint,
        }),
      'INVALID_ARGUMENT'
    )
    wallet.dispose()
  })
})

describe('Taproot PSBTs, both sides', async () => {
  const wallet = await testnet.createEphemeralWallet({mnemonic: ABANDON})
  const fingerprint = wallet.fingerprint
  const deriveAt = (path: string, addressType: BitcoinAccountType) =>
    wallet.deriveAccount({addressType, chain: 'bitcoin', path})
  const recipient = (await wallet.deriveAccount({account: 3, chain: 'bitcoin'})).address
  after(() => wallet.dispose())

  /** The watch-only wallet's Taproot account, from the tr() descriptor the signer shared. */
  const paired = (index = 0) => {
    const path = "m/86'/1'/0'"
    const ur = airgap.encodeAccount({
      keys: [airgap.accountKey({extendedKey: wallet.extendedPublicKey(path), fingerprint, path})],
      masterFingerprint: fingerprint,
    })
    const [descriptor] = airgap.decodeAccount(ur).descriptors
    const key = descriptor?.keys[0]
    assert.ok(key && 'hdkey' in key)

    return airgap.watchAccount(key.hdkey, fingerprint, index)
  }

  test('a payment from a BIP-86 account goes out, is signed by the key path, and finalizes', async () => {
    const watch = paired()
    const signer = await wallet.deriveAccount({addressType: 'p2tr', chain: 'bitcoin'})
    assert.equal(watch.addressType, 'p2tr')
    assert.equal(watch.address, signer.address)

    const plan = watch.createTransaction({
      amount: 40_000n,
      feeRate: 2,
      to: recipient,
      utxos: [
        {txid: 'a1'.repeat(32), value: 30_000n, vout: 0},
        {txid: 'b2'.repeat(32), value: 25_000n, vout: 1},
      ],
    })
    const unsigned = watch.createPsbt(plan)
    const review = airgap.decodeSignRequest(transmit(airgap.encodeSignRequest({psbt: unsigned}), airgap.requestTypes), {
      accountPath: "m/86'/1'/0'",
      fingerprint,
    })

    assert.deepEqual(
      review.keys.map(key => [key.addressType, key.path, key.publicKey.length]),
      [['p2tr', "m/86'/1'/0'/0/0", 32]]
    )
    assert.deepEqual(
      review.outputs.map(output => output.change),
      [false, true]
    )
    assert.equal(review.fee, plan.fee)
    // A Taproot signature commits to every coin's value: still, the coins come without their previous transactions.
    assert.deepEqual(review.warnings, ['UNVERIFIED_VALUES'])

    const signed = await airgap.signRequest(review, deriveAt)
    const {transaction} = airgap.decodeSignResponse(transmit(airgap.encodeSignResponse(signed), airgap.responseTypes), {
      request: unsigned,
    })
    const reference = Transaction.fromPSBT(signed.psbt)
    reference.finalize()
    assert.equal(transaction.hex, hex.encode(reference.extract()))

    // One account signs the same way: the single-account context, by its script.
    const alone = airgap.decodeSignRequest(toUR(CRYPTO_PSBT, unsigned), {account: signer})
    assert.deepEqual(
      alone.keys.map(key => [key.addressType, key.path]),
      [['p2tr', signer.path]]
    )
  })

  test('a coordinator`s PSBT spending a P2WPKH and a Taproot account of one wallet, as Sparrow writes one', async () => {
    const segwit = await wallet.deriveAccount({chain: 'bitcoin', index: 2})
    const taproot = await wallet.deriveAccount({addressType: 'p2tr', chain: 'bitcoin', index: 5})
    const change = await wallet.deriveAccount({addressType: 'p2tr', chain: 'bitcoin', change: 1, index: 0})
    const theirs = new Transaction({lockTime: 0, version: 2})
    theirs.addInput({
      bip32Derivation: [[segwit.publicKey, {fingerprint, path: indexes(segwit.path)}]],
      index: 0,
      sequence: 0xfffffffd,
      txid: '11'.repeat(32),
      witnessUtxo: {amount: 50_000n, script: segwit.scriptPubKey},
    })
    theirs.addInput({
      index: 1,
      sequence: 0xfffffffd,
      tapBip32Derivation: [
        [taproot.publicKey.subarray(1), {der: {fingerprint, path: indexes(taproot.path)}, hashes: []}],
      ],
      tapInternalKey: taproot.publicKey.subarray(1),
      txid: '22'.repeat(32),
      witnessUtxo: {amount: 30_000n, script: taproot.scriptPubKey},
    })
    const pay = testnet.chains.bitcoin.validateAddress(recipient)
    assert.ok(pay.valid)
    theirs.addOutput({amount: 60_000n, script: pay.scriptPubKey})
    theirs.addOutput({
      amount: 19_000n,
      script: change.scriptPubKey,
      tapBip32Derivation: [
        [change.publicKey.subarray(1), {der: {fingerprint, path: indexes(change.path)}, hashes: []}],
      ],
      tapInternalKey: change.publicKey.subarray(1),
    })
    const psbt = theirs.toPSBT()
    const context = {accountPath: ["m/84'/1'/0'", "m/86'/1'/0'"], fingerprint}

    const review = airgap.decodeSignRequest(toUR(CRYPTO_PSBT, psbt), context)
    assert.deepEqual(
      review.keys.map(key => [key.addressType, key.path]),
      [
        ['p2wpkh', segwit.path],
        ['p2tr', taproot.path],
      ]
    )
    assert.deepEqual(
      review.outputs.map(output => output.change),
      [false, true]
    )
    assert.equal(review.fee, 1_000n)
    assert.equal(review.sending, 60_000n)

    const {psbt: signed} = await airgap.signRequest(review, deriveAt)
    const {transaction} = airgap.decodeSignResponse(toUR(CRYPTO_PSBT, signed), {request: psbt})
    const reference = Transaction.fromPSBT(signed)
    reference.finalize()
    assert.equal(transaction.hex, hex.encode(reference.extract()))

    // With only the P2WPKH account, the Taproot coin is another key's: said, and left unsigned.
    const partly = airgap.decodeSignRequest(toUR(CRYPTO_PSBT, psbt), {accountPath: "m/84'/1'/0'", fingerprint})
    assert.deepEqual(partly.warnings, ['FOREIGN_INPUTS', 'UNVERIFIED_VALUES'])

    // A key derived as the wrong type for its input is refused before it signs anything.
    await assert.rejects(
      airgap.signRequest(review, path => wallet.deriveAccount({chain: 'bitcoin', path})),
      error => isAirgapError(error, 'INVALID_ARGUMENT')
    )
  })

  test('a Taproot derivation that does not pay its coin, or misplaces the account`s key, is not the signer`s', async () => {
    const taproot = await wallet.deriveAccount({addressType: 'p2tr', chain: 'bitcoin', index: 1})
    const stranger = await wallet.deriveAccount({account: 7, addressType: 'p2tr', chain: 'bitcoin'})
    const lying = new Transaction({lockTime: 0, version: 2})
    lying.addInput({
      index: 0,
      tapBip32Derivation: [
        [stranger.publicKey.subarray(1), {der: {fingerprint, path: indexes(taproot.path)}, hashes: []}],
      ],
      txid: '33'.repeat(32),
      witnessUtxo: {amount: 30_000n, script: taproot.scriptPubKey},
    })
    lying.addOutput({amount: 29_000n, script: taproot.scriptPubKey})
    throwsCode(
      () => airgap.decodeSignRequest(toUR(CRYPTO_PSBT, lying.toPSBT()), {accountPath: "m/86'/1'/0'", fingerprint}),
      'REQUEST_MISMATCH'
    )

    const misplaced = new Transaction({lockTime: 0, version: 2})
    misplaced.addInput({
      index: 0,
      tapBip32Derivation: [
        [taproot.publicKey.subarray(1), {der: {fingerprint: 0x01020304, path: indexes(taproot.path)}, hashes: []}],
      ],
      txid: '44'.repeat(32),
      witnessUtxo: {amount: 30_000n, script: taproot.scriptPubKey},
    })
    misplaced.addOutput({amount: 29_000n, script: taproot.scriptPubKey})
    throwsCode(
      () => airgap.decodeSignRequest(toUR(CRYPTO_PSBT, misplaced.toPSBT()), {account: taproot}),
      'REQUEST_MISMATCH'
    )
    assert.equal(encodeUR(toUR(CRYPTO_PSBT, misplaced.toPSBT())).startsWith('ur:crypto-psbt/'), true)
  })
})
