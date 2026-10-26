import {createRequestId} from '@hzblj/crypto-airgap'
import {solanaAirgap} from '@hzblj/crypto-airgap-solana'
import type {SolanaChain} from '@hzblj/crypto-solana'

import {NETWORKS} from '../config'
import {formatUnits} from '../utils'
import {NetworkError, rpc, rpcBatch} from './http'
import {AIRGAP_ORIGIN} from './origin'
import type {ChainService, SendRequest} from './types'

const network = NETWORKS.solana
const url = network.endpoint
const CONFIRMED = {commitment: 'confirmed'} as const

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))

type Value<T> = {readonly value: T}

const prepare = async (chain: SolanaChain, address: string, {amount, to}: SendRequest) => {
  const recipient = chain.validateAddress(to)

  if (!recipient.valid) {
    throw new NetworkError(recipient.reason)
  }

  const [blockhash, balance, recipientAccount, rentFloor] = (await rpcBatch(url, [
    {method: 'getLatestBlockhash', params: [CONFIRMED]},
    {method: 'getBalance', params: [address, CONFIRMED]},
    {method: 'getAccountInfo', params: [to, {...CONFIRMED, encoding: 'base64'}]},
    {method: 'getMinimumBalanceForRentExemption', params: [0]},
  ])) as [Value<{blockhash: string}>, Value<number>, Value<unknown>, number]

  const lamports = BigInt(balance.value)
  const transfer = (value: bigint) => [chain.instructions.transfer({from: address, lamports: value, to})]
  const message = chain.compileMessage({
    feePayer: address,
    instructions: transfer(1n),
    recentBlockhash: blockhash.value.blockhash,
  })
  const {value: networkFee} = await rpc<Value<number | null>>(url, 'getFeeForMessage', [toBase64(message), CONFIRMED])
  const fee = BigInt(networkFee ?? 5000)
  const value = amount === 'max' ? lamports - fee : amount

  if (value <= 0n || value + fee > lamports) {
    throw new NetworkError(`Not enough SOL: the account has ${formatUnits(lamports, 9)}.`)
  }
  if (recipientAccount.value === null && value < BigInt(rentFloor)) {
    throw new NetworkError(
      `A new Solana account must start with at least ${formatUnits(BigInt(rentFloor), 9)} SOL (its rent exemption).`
    )
  }
  const left = lamports - fee - value
  if (left > 0n && left < BigInt(rentFloor)) {
    throw new NetworkError(
      `That would leave ${formatUnits(left, 9)} SOL, below the ${formatUnits(BigInt(rentFloor), 9)} SOL an account keeps for rent: send less, or everything.`
    )
  }

  return {
    amount: value,
    details: [
      {label: 'Network', value: `Solana ${network.testnet}`},
      {label: 'Recent blockhash', value: `${blockhash.value.blockhash.slice(0, 12)}…`},
      {label: 'Instructions', value: 'System transfer'},
    ],
    fee,
    transaction: {instructions: transfer(value), recentBlockhash: blockhash.value.blockhash},
  }
}

const broadcast = (serialized: Uint8Array) =>
  rpc<string>(url, 'sendTransaction', [toBase64(serialized), {encoding: 'base64', preflightCommitment: 'confirmed'}])

export const solanaService = (chain: SolanaChain, random: (length: number) => Uint8Array): ChainService<'solana'> => {
  const airgap = solanaAirgap(chain)

  return {
    airgapQuote: async (account, send) => {
      const {transaction, ...quote} = await prepare(chain, account.address, send)
      const request = {account, origin: AIRGAP_ORIGIN, requestId: createRequestId(random), transaction}

      return {
        ...quote,
        complete: async answer => {
          const response = airgap.decodeSignResponse(answer, {request})

          if (response.kind !== 'transaction') {
            throw new NetworkError('The signer answered with a message signature, not a transaction.')
          }

          return broadcast(response.transaction.serialized)
        },
        request: airgap.encodeSignRequest(request),
      }
    },
    balance: async address => BigInt((await rpc<Value<number>>(url, 'getBalance', [address, CONFIRMED])).value),
  }
}
