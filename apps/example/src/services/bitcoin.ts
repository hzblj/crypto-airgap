import {bitcoinAirgap} from '@hzblj/crypto-airgap-bitcoin'
import type {BitcoinChain, BitcoinTransactionPlan, BitcoinUtxo, BitcoinWatchAccount} from '@hzblj/crypto-bitcoin'

import {NETWORKS} from '../config'
import {formatUnits} from '../utils'
import {getJson, getText, NetworkError, postText} from './http'
import type {ChainService, SendRequest} from './types'

const network = NETWORKS.bitcoin
const api = network.endpoint

type Stats = {readonly funded_txo_sum: number; readonly spent_txo_sum: number}
type AddressInfo = {readonly chain_stats: Stats; readonly mempool_stats: Stats}
type EsploraUtxo = {readonly txid: string; readonly vout: number; readonly value: number}
type Fees = {readonly halfHourFee: number; readonly minimumFee: number}

/** A payment from `account` at the network's current state: the coins it spends, the fee, what the screens list. */
const prepare = async (chain: BitcoinChain, account: BitcoinWatchAccount, {amount, to}: SendRequest) => {
  const recipient = chain.validateAddress(to)

  if (!recipient.valid) {
    throw new NetworkError(recipient.reason)
  }

  const [coins, fees] = await Promise.all([
    getJson<EsploraUtxo[]>(`${api}/address/${account.address}/utxo`),
    getJson<Fees>(`${api}/v1/fees/recommended`),
  ])

  if (coins.length === 0) {
    throw new NetworkError('This address has no coins to spend yet: fund it from a testnet4 faucet.')
  }

  const utxos: BitcoinUtxo[] = coins.map(coin => ({txid: coin.txid, value: BigInt(coin.value), vout: coin.vout}))
  const feeRate = Math.max(fees.halfHourFee, fees.minimumFee, 1)
  const plan = account.createTransaction({amount, feeRate, to: recipient.normalized, utxos})

  return {
    amount: plan.amount,
    details: [
      {label: 'Network', value: `Bitcoin ${network.testnet}`},
      {label: 'Fee rate', value: `${feeRate} sat/vB`},
      {label: 'Size', value: `${plan.vsize} vB, at most`},
      {label: 'Inputs', value: `${plan.inputs.length} of ${utxos.length} coins`},
      {
        label: 'Change',
        value: plan.change > 0n ? `${formatUnits(plan.change, 8, 8)} BTC back to this address` : 'None',
      },
    ],
    fee: plan.fee,
    plan,
  }
}

/** Each coin's whole previous transaction, which lets the signer check the values it signs (and so the fee). */
const previousTransactions = async (plan: BitcoinTransactionPlan) =>
  Object.fromEntries(
    await Promise.all(
      [...new Set(plan.inputs.map(input => input.txid))].map(
        async txid => [txid, await getText(`${api}/tx/${txid}/hex`)] as const
      )
    )
  )

export const bitcoinService = (chain: BitcoinChain): ChainService<'bitcoin'> => {
  const airgap = bitcoinAirgap(chain)

  return {
    airgapQuote: async (account, send) => {
      const {plan, ...quote} = await prepare(chain, account, send)
      const psbt = account.createPsbt(plan, {previousTransactions: await previousTransactions(plan)})

      return {
        ...quote,
        complete: async answer =>
          postText(`${api}/tx`, airgap.decodeSignResponse(answer, {request: psbt}).transaction.hex),
        request: airgap.encodeSignRequest({psbt}),
      }
    },
    balance: async address => {
      const {chain_stats: confirmed, mempool_stats: pending} = await getJson<AddressInfo>(`${api}/address/${address}`)

      return (
        BigInt(confirmed.funded_txo_sum - confirmed.spent_txo_sum) +
        BigInt(pending.funded_txo_sum - pending.spent_txo_sum)
      )
    },
  }
}
