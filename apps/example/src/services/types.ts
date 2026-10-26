import type {UR} from '@hzblj/crypto-airgap'
import type {EthereumAirgapAccount} from '@hzblj/crypto-airgap-ethereum'
import type {SolanaAirgapAccount} from '@hzblj/crypto-airgap-solana'
import type {BitcoinWatchAccount} from '@hzblj/crypto-bitcoin'

import type {ChainId} from '../core'

/** A payment of the network's own coin, in its smallest unit; `max` sends everything that leaves enough for the fee. */
export type SendRequest = {readonly to: string; readonly amount: bigint | 'max'}

/** An account whose key is on an air-gapped signer: what the watch-only side builds transactions for. */
export type WatchAccount<Id extends ChainId> = {
  readonly bitcoin: BitcoinWatchAccount
  readonly ethereum: EthereumAirgapAccount
  readonly solana: SolanaAirgapAccount
}[Id]

/** A transaction built from the network's current state, for a key held elsewhere: a request, and its answer. */
export type AirgapQuote = {
  /** What the recipient gets. */
  readonly amount: bigint
  /** The network fee, in the network's own coin: the most it can cost. */
  readonly fee: bigint
  /** Facts the screen lists beside the request: nonce, fee rate, inputs. */
  readonly details: readonly {readonly label: string; readonly value: string}[]
  /** What the signer scans: a PSBT, an ERC-4527 request, or a Solana sign request. */
  readonly request: UR
  /** Checks the signer's answer against the request (its signer verified by the engine) and broadcasts it. */
  readonly complete: (answer: UR) => Promise<string>
}

/** What the watch-only side asks one chain's network, on top of what its adapters do offline. */
export type ChainService<Id extends ChainId> = {
  /** The address's balance of the network's own coin. */
  readonly balance: (address: string) => Promise<bigint>
  readonly airgapQuote: (account: WatchAccount<Id>, request: SendRequest) => Promise<AirgapQuote>
}
