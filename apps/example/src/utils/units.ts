/**
 * Amounts are integers in a coin's smallest unit (wei, satoshi, lamport) from the network to the signature; text exists
 * only at the edges, where people read and type them.
 */

/** `1.5` in a coin of `decimals` decimals, or `undefined` for anything that is not a non-negative amount of it. */
export const parseUnits = (text: string, decimals: number): bigint | undefined => {
  const normalized = text.trim().replace(',', '.')

  if (!/^\d*\.?\d*$/.test(normalized) || normalized === '' || normalized === '.') {
    return undefined
  }

  const [whole = '', fraction = ''] = normalized.split('.')

  if (fraction.length > decimals) {
    return undefined
  }

  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0')
}

/** `150000000` sats as `1.5`: no trailing zeros, at most `maxFraction` decimals (rounded down). */
export const formatUnits = (value: bigint, decimals: number, maxFraction = 6): string => {
  const negative = value < 0n
  const absolute = negative ? -value : value
  const base = 10n ** BigInt(decimals)
  const whole = absolute / base
  const fraction = (absolute % base).toString().padStart(decimals, '0').slice(0, maxFraction).replace(/0+$/, '')
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')

  return `${negative ? '-' : ''}${grouped}${fraction ? `.${fraction}` : ''}`
}

/** The full precision, for a field the user may edit: no grouping, no rounding. */
export const formatExact = (value: bigint, decimals: number): string =>
  formatUnits(value, decimals, decimals).replaceAll(',', '')

/** `0x9858…da94`: enough to recognize an address, never enough to trust one. */
export const shortAddress = (address: string, head = 6, tail = 4): string =>
  address.length <= head + tail + 1 ? address : `${address.slice(0, head)}…${address.slice(-tail)}`
