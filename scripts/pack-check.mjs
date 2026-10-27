/**
 * Checks what npm would receive, the way a consumer meets it. Packs every published package (each `prepack` builds it
 * through turbo's cache), asserts what must and must not ship in each tarball, then installs them into a throwaway
 * app and type-checks real usage with a consumer's TypeScript: no `source` condition, no workspace links, only what
 * the tarballs declare (and `@hzblj/nitro-crypto` and the chain adapters, from npm, as a consumer has them).
 *
 * The negative cases matter as much as the positive ones: if a declaration failed to resolve, its imports would
 * quietly become `any` and everything would compile, so each `@ts-expect-error` is there to prove the types are real.
 */
import {execFileSync} from 'node:child_process'
import {existsSync} from 'node:fs'
import {mkdir, readdir, readFile, rm, writeFile} from 'node:fs/promises'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const WORK = path.join(ROOT, '.pack-check')

const run = (command, args, cwd = ROOT) => execFileSync(command, args, {cwd, encoding: 'utf8', maxBuffer: 64 << 20})

const fail = message => {
  console.error(`pack-check: ${message}`)
  process.exit(1)
}

const PACKAGE = ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md', 'build/index.js', 'build/index.d.ts']

const REQUIRED = {
  '@hzblj/crypto-airgap': PACKAGE,
  '@hzblj/crypto-airgap-bitcoin': PACKAGE,
  '@hzblj/crypto-airgap-ethereum': PACKAGE,
  '@hzblj/crypto-airgap-solana': PACKAGE,
}

// Tests, TypeScript sources, the WebAssembly binary (the testing entry carries it), and native build output stay home.
const FORBIDDEN = [/^src\//, /^test\//, /\.DS_Store$/, /\.tsbuildinfo$/]

const packages = []
for (const directory of await readdir(path.join(ROOT, 'packages'))) {
  const manifestPath = path.join(ROOT, 'packages', directory, 'package.json')
  if (!existsSync(manifestPath)) {
    continue
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (!manifest.private) {
    packages.push({directory, name: manifest.name})
  }
}

await rm(WORK, {force: true, recursive: true})
await mkdir(path.join(WORK, 'tarballs'), {recursive: true})

let fileCount = 0
for (const {directory, name} of packages) {
  const tarball = path.join(WORK, 'tarballs', `${directory}.tgz`)
  run('yarn', ['pack', '--out', tarball], path.join(ROOT, 'packages', directory))

  const files = run('tar', ['-tzf', tarball])
    .split('\n')
    .filter(Boolean)
    .map(file => file.replace(/^package\//, ''))
  const missing = (REQUIRED[name] ?? ['package.json', 'README.md']).filter(file => !files.includes(file))
  const leaked = files.filter(file => FORBIDDEN.some(pattern => pattern.test(file)))
  if (missing.length > 0) {
    fail(`${name} is missing:\n  ${missing.join('\n  ')}`)
  }
  if (leaked.length > 0) {
    fail(`${name} must not ship:\n  ${leaked.join('\n  ')}`)
  }

  const packed = JSON.parse(run('tar', ['-xzOf', tarball, 'package/package.json']))
  for (const field of ['dependencies', 'peerDependencies']) {
    if (JSON.stringify(packed[field] ?? {}).includes('workspace:')) {
      fail(`${name} still declares a workspace: range in ${field}: it would not install outside this repo`)
    }
  }
  // `source` points at src/, which stays home: a consumer that sets the condition (a monorepo's own tests do) would
  // resolve to a file that is not there. `publishConfig.exports` is the published map without it.
  if (JSON.stringify(packed.exports ?? {}).includes('"source"')) {
    fail(`${name} publishes a \`source\` condition in its exports, to a src/ it does not ship`)
  }

  const installed = path.join(WORK, 'node_modules', name)
  await mkdir(installed, {recursive: true})
  run('tar', ['-xzf', tarball, '-C', installed, '--strip-components', '1'])
  fileCount += files.length
}

const consumer = `import {
  CRYPTO_HDKEY,
  CRYPTO_MULTI_ACCOUNTS,
  createMultipartDecoder,
  createMultipartEncoder,
  createRequestId,
  fromUR,
  isAirgapError,
  toUR,
  type UR,
} from '@hzblj/crypto-airgap'
import {bitcoinAirgap} from '@hzblj/crypto-airgap-bitcoin'
import {ethereumAirgap, parseTypedData} from '@hzblj/crypto-airgap-ethereum'
import {solanaAirgap} from '@hzblj/crypto-airgap-solana'
import {bitcoinAdapter} from '@hzblj/crypto-bitcoin'
import {ethereumAdapter} from '@hzblj/crypto-ethereum'
import {solanaAdapter} from '@hzblj/crypto-solana'
import {createCryptoEngine, type ExtendedPublicKey} from '@hzblj/nitro-crypto'

export const airgap = async (scanned: UR) => {
  const crypto = createCryptoEngine({adapters: [ethereumAdapter(), bitcoinAdapter({network: 'testnet'}), solanaAdapter()]})
  const btc = bitcoinAirgap(crypto.chains.bitcoin)
  const eth = ethereumAirgap(crypto.chains.ethereum)
  const sol = solanaAirgap(crypto.chains.solana)
  const {sha256} = crypto.hash
  const sender = createMultipartEncoder(btc.encodeSignRequest({psbt: new Uint8Array()}), {maxFragmentLength: 180, sha256})
  const part: string = sender.nextPart()
  const receiver = createMultipartDecoder({allowedTypes: [...eth.responseTypes, ...sol.responseTypes], sha256})
  receiver.receivePart(part)
  const fraction: number = receiver.progress.fraction
  const account = {address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', fingerprint: 1, path: "m/44'/60'/0'/0/0"} as const
  const request = eth.decodeSignRequest(scanned, {account})
  const to: string | null | undefined =
    request.kind === 'transaction' ? request.transaction.to : request.kind === 'message' ? request.text : request.typedData.primaryType
  const fee: bigint = request.kind === 'transaction' && request.transaction.type === 'legacy' ? request.transaction.gasPrice : 0n
  const typedData = parseTypedData('{"types":{},"primaryType":"EIP712Domain","domain":{"name":"x"}}')
  const typed = eth.decodeSignResponse(scanned, {request: {account, requestId: createRequestId(crypto.random), typedData}})
  const typedSignature: string | undefined = typed.kind === 'typed-data' ? typed.signature : undefined
  const solAccount = {address: 'So11111111111111111111111111111111111111112', fingerprint: 1, path: "m/44'/501'/0'/0'"}
  const offchain = sol.decodeSignResponse(scanned, {request: {account: solAccount, offchainMessage: {signers: [solAccount.address], text: 'x', version: 1}, requestId: createRequestId(crypto.random)}})
  const partial = sol.decodeSignResponse(scanned, {request: {account: solAccount, requestId: createRequestId(crypto.random), serializedTransaction: new Uint8Array()}})
  const complete: boolean | undefined = partial.kind === 'partially-signed' ? partial.transaction.complete : offchain.kind === 'offchain-message' ? true : undefined
  const answer = eth.decodeSignResponse(scanned, {request: {account, message: 'x', requestId: createRequestId(crypto.random)}})
  const serialized: string | undefined = answer.kind === 'transaction' ? answer.transaction.serialized : undefined
  const keys = fromUR(CRYPTO_MULTI_ACCOUNTS, scanned).keys.map(key => sol.watchAccount(key).address)
  const review = btc.decodeSignRequest(scanned, {account: crypto.chains.bitcoin.watchAccount({fingerprint: 1, path: "m/84'/1'/0'/0/0", publicKey: new Uint8Array(33)})})
  const btcFee: bigint | undefined = review.fee

  // Account keys: Sparrow's crypto-account, MetaMask's crypto-hdkey, and requests for any address of the account.
  const wallet = await crypto.createEphemeralWallet()
  const extendedKey: ExtendedPublicKey = wallet.extendedPublicKey("m/84'/1'/0'")
  const bitcoinKey = btc.accountKey({extendedKey, fingerprint: wallet.fingerprint, path: "m/84'/1'/0'"})
  const sparrow: UR<'crypto-account'> = btc.encodeAccount({keys: [bitcoinKey], masterFingerprint: wallet.fingerprint})
  const third: string = btc.watchAccount(bitcoinKey, wallet.fingerprint, 2).address
  const metamask: UR = toUR(CRYPTO_HDKEY, eth.accountKey({extendedKey: wallet.extendedPublicKey("m/44'/60'/0'"), fingerprint: 1, name: 'Wallet', path: "m/44'/60'/0'"}))
  const anyAddress = eth.decodeSignRequest(scanned, {accountPath: "m/44'/60'/0'", fingerprint: wallet.fingerprint})
  const signed = eth.encodeSignResponse(await eth.signRequest(anyAddress, path => wallet.deriveAccount({chain: 'ethereum', path})))
  const psbt = btc.decodeSignRequest(scanned, {accountPath: ["m/84'/1'/0'", "m/86'/1'/0'"], fingerprint: wallet.fingerprint})
  const answered: UR = btc.encodeSignResponse(await btc.signRequest(psbt, (path, addressType) => wallet.deriveAccount({addressType, chain: 'bitcoin', path})))
  const taproot: UR<'crypto-output'> = btc.encodeOutput(btc.accountKey({extendedKey: wallet.extendedPublicKey("m/86'/1'/0'"), fingerprint: wallet.fingerprint, path: "m/86'/1'/0'"}))
  wallet.dispose()

  // @ts-expect-error: an Ethereum request carries no PSBT
  request.psbt
  // @ts-expect-error: a parsed transaction is a union on its type, and only legacy and EIP-2930 have a gas price
  if (request.kind === 'transaction') request.transaction.gasPrice
  // @ts-expect-error: decoders take an allowlist
  createMultipartDecoder({sha256})
  // @ts-expect-error: multipart takes SHA-256 from the caller (the engine), having none of its own
  createMultipartEncoder(scanned, {maxFragmentLength: 180})

  return [fraction, to, fee, typedSignature, complete, serialized, keys, btcFee, sparrow, third, metamask, signed, answered, taproot, isAirgapError(null, 'REQUEST_MISMATCH')]
}
`

await writeFile(path.join(WORK, 'consumer.ts'), consumer)
await writeFile(
  path.join(WORK, 'tsconfig.json'),
  JSON.stringify(
    {
      compilerOptions: {lib: ['ESNext', 'DOM'], noEmit: true, skipLibCheck: true, strict: true, types: []},
      extends: 'expo/tsconfig.base',
      include: ['consumer.ts'],
    },
    null,
    2
  )
)

try {
  run('yarn', ['run', '-T', 'tsc', '-p', WORK])
} catch (error) {
  fail(`a consumer's type check failed:\n${error.stdout}`)
}

await rm(WORK, {force: true, recursive: true})
console.log(`pack-check: ${packages.length} packages, ${fileCount} files, and a consumer type-checks`)
