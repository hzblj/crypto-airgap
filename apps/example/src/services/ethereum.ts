import {createRequestId} from '@hzblj/crypto-airgap'
import {ethereumAirgap} from '@hzblj/crypto-airgap-ethereum'
import type {EthereumChain, EthereumTransactionRequest, Hex} from '@hzblj/crypto-ethereum'

import {NETWORKS} from '../config'
import {formatUnits} from '../utils'
import {NetworkError, rpc, rpcBatch} from './http'
import {AIRGAP_ORIGIN} from './origin'
import type {ChainService, SendRequest} from './types'

const network = NETWORKS.ethereum
const GWEI = 1_000_000_000n
/** Sepolia's suggested tip is often a few wei; a gwei gets a transaction into the next blocks for a negligible fee. */
const MIN_TIP = GWEI

type Block = {readonly baseFeePerGas?: Hex}

const prepare = async (chain: EthereumChain, address: string, {amount, to}: SendRequest) => {
  const recipient = chain.validateAddress(to)

  if (!recipient.valid) {
    throw new NetworkError(recipient.reason)
  }

  const [nonce, block, tip, balance] = (await rpcBatch(network.endpoint, [
    {method: 'eth_getTransactionCount', params: [address, 'pending']},
    {method: 'eth_getBlockByNumber', params: ['latest', false]},
    {method: 'eth_maxPriorityFeePerGas', params: []},
    {method: 'eth_getBalance', params: [address, 'latest']},
  ])) as [Hex, Block, Hex, Hex]

  const ether = BigInt(balance)
  const baseFee = BigInt(block.baseFeePerGas ?? '0x0')
  const maxPriorityFeePerGas = BigInt(tip) > MIN_TIP ? BigInt(tip) : MIN_TIP
  // Twice the base fee rides out six full blocks of increases; the unused part is never charged.
  const maxFeePerGas = baseFee * 2n + maxPriorityFeePerGas
  // A plain transfer to an account: 21,000 gas, always.
  const gas = 21_000n
  const fee = gas * maxFeePerGas
  const value = amount === 'max' ? ether - fee : amount

  if (value <= 0n || value + fee > ether) {
    throw new NetworkError(
      `Not enough ETH: this needs ${formatUnits((value > 0n ? value : 0n) + fee, 18)} ETH with the fee, the account has ${formatUnits(ether, 18)}.`
    )
  }

  const request: EthereumTransactionRequest = {
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas,
    nonce: BigInt(nonce),
    to: recipient.normalized,
    value,
  }

  return {
    amount: value,
    details: [
      {label: 'Network', value: `${network.testnet}, chain id ${chain.network.chainId}`},
      {label: 'Nonce', value: BigInt(nonce).toString()},
      {label: 'Max fee per gas', value: `${formatUnits(maxFeePerGas, 9, 3)} gwei`},
      {label: 'Transaction type', value: 'EIP-1559'},
    ],
    fee,
    request,
  }
}

export const ethereumService = (
  chain: EthereumChain,
  random: (length: number) => Uint8Array
): ChainService<'ethereum'> => {
  const airgap = ethereumAirgap(chain)

  return {
    airgapQuote: async (account, send) => {
      const {request: transaction, ...quote} = await prepare(chain, account.address, send)
      const request = {account, origin: AIRGAP_ORIGIN, requestId: createRequestId(random), transaction}

      return {
        ...quote,
        complete: async answer => {
          const response = airgap.decodeSignResponse(answer, {request})

          if (response.kind !== 'transaction') {
            throw new NetworkError('The signer answered with a message signature, not a transaction.')
          }

          return rpc<Hex>(network.endpoint, 'eth_sendRawTransaction', [response.transaction.serialized])
        },
        request: airgap.encodeSignRequest(request),
      }
    },
    balance: async address => BigInt(await rpc<Hex>(network.endpoint, 'eth_getBalance', [address, 'latest'])),
  }
}
