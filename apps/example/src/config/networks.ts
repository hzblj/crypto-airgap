import type {ChainId} from '../core'

/** A network's own coin: the only asset the watch-only side reads and sends. */
export type Coin = {
  readonly chain: ChainId
  readonly symbol: string
  readonly name: string
  readonly decimals: number
}

export type Faucet = {readonly label: string; readonly url: string}

export type Network = {
  readonly chain: ChainId
  /** "Ethereum". */
  readonly name: string
  /** The test network: "Sepolia". */
  readonly testnet: string
  /** The service the watch-only side reads balances and the network's state from, and broadcasts through. */
  readonly endpoint: string
  readonly native: Coin
  readonly explorer: {readonly address: (address: string) => string; readonly tx: (hash: string) => string}
  readonly faucets: readonly Faucet[]
}

const ethereum: Network = {
  chain: 'ethereum',
  endpoint: 'https://ethereum-sepolia-rpc.publicnode.com',
  explorer: {
    address: address => `https://sepolia.etherscan.io/address/${address}`,
    tx: hash => `https://sepolia.etherscan.io/tx/${hash}`,
  },
  faucets: [
    {label: 'Google Cloud Sepolia faucet', url: 'https://cloud.google.com/application/web3/faucet/ethereum/sepolia'},
  ],
  name: 'Ethereum',
  native: {chain: 'ethereum', decimals: 18, name: 'Ether', symbol: 'ETH'},
  testnet: 'Sepolia',
}

const bitcoin: Network = {
  chain: 'bitcoin',
  endpoint: 'https://mempool.space/testnet4/api',
  explorer: {
    address: address => `https://mempool.space/testnet4/address/${address}`,
    tx: txid => `https://mempool.space/testnet4/tx/${txid}`,
  },
  faucets: [
    {label: 'mempool.space testnet4 faucet', url: 'https://mempool.space/testnet4/faucet'},
    {label: 'coinfaucet.eu', url: 'https://coinfaucet.eu/en/btc-testnet4/'},
  ],
  name: 'Bitcoin',
  native: {chain: 'bitcoin', decimals: 8, name: 'Bitcoin', symbol: 'BTC'},
  testnet: 'testnet4',
}

const solana: Network = {
  chain: 'solana',
  endpoint: 'https://api.devnet.solana.com',
  explorer: {
    address: address => `https://explorer.solana.com/address/${address}?cluster=devnet`,
    tx: signature => `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
  },
  faucets: [{label: 'Solana faucet', url: 'https://faucet.solana.com'}],
  name: 'Solana',
  native: {chain: 'solana', decimals: 9, name: 'Solana', symbol: 'SOL'},
  testnet: 'devnet',
}

export const NETWORKS: {readonly [Id in ChainId]: Network} = {bitcoin, ethereum, solana}
