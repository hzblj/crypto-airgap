import {protocolError} from '@hzblj/crypto-airgap'
import type {Address, TypedDataDefinition, TypedDataField, TypedDataTypes} from '@hzblj/crypto-ethereum'
import {bytes, hex, utf8} from '@hzblj/nitro-crypto/adapter'

import {type JsonValue, readJson} from './json'

/** How deep typed data's JSON may nest, arrays and objects alike: Keystone's firmware limit, far beyond real payloads. */
export const MAX_TYPED_DATA_DEPTH = 32

const isObject = (value: unknown): value is {readonly [key: string]: unknown} =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array)

const own = (value: {readonly [key: string]: unknown}, key: string) =>
  Object.hasOwn(value, key) ? value[key] : undefined

/** Sets `key` as an own property, whatever its name: `__proto__` included. */
const define = (target: Record<string, unknown>, key: string, value: unknown) =>
  Object.defineProperty(target, key, {configurable: true, enumerable: true, value, writable: true})

const readTypes = (value: unknown): TypedDataTypes => {
  if (!isObject(value)) {
    throw protocolError('The typed data`s types are an object of struct types.')
  }

  const types: Record<string, readonly TypedDataField[]> = {}

  for (const [name, fields] of Object.entries(value)) {
    if (!Array.isArray(fields)) {
      throw protocolError('A struct type is a list of members.')
    }

    define(
      types,
      name,
      Object.freeze(
        fields.map(field => {
          const memberName = isObject(field) ? own(field, 'name') : undefined
          const memberType = isObject(field) ? own(field, 'type') : undefined

          if (typeof memberName !== 'string' || typeof memberType !== 'string') {
            throw protocolError('A struct member is a {name, type} pair of strings.')
          }

          return Object.freeze({name: memberName, type: memberType})
        })
      )
    )
  }

  return Object.freeze(types)
}

/**
 * Typed data from the JSON of an `eth_signTypedData_v4` request, as MetaMask and Keystone's keyrings put it in an
 * `eth-sign-request` (data type 2): `{types, primaryType, domain, message}`, in UTF-8. Read strictly (`readJson`):
 * at most 32 levels deep, no key twice, no NUL, integers exact (a `bigint` beyond a safe `number`); a JSON string that
 * holds that JSON is read too, as Keystone reads it. The shape is checked here and the values by the chain, which
 * hashes them (`hashTypedData`); members the types do not declare are kept, and ignored there.
 */
export const parseTypedData = (json: string | Uint8Array): TypedDataDefinition => {
  let text = json

  if (typeof text !== 'string') {
    text = utf8.decode(json as Uint8Array)

    if (!bytes.equal(utf8.encode(text), json as Uint8Array)) {
      throw protocolError('The typed data is not UTF-8.')
    }
  }

  let value: JsonValue = readJson(text, MAX_TYPED_DATA_DEPTH)

  // Typed data stringified once more, as some dApps send it: Keystone's firmware reads it, and so does this.
  if (typeof value === 'string') {
    value = readJson(value, MAX_TYPED_DATA_DEPTH)
  }

  if (!isObject(value)) {
    throw protocolError('Typed data is a JSON object: types, primaryType, domain and message.')
  }

  const primaryType = own(value, 'primaryType')
  const domain = own(value, 'domain')
  const message = own(value, 'message') ?? (primaryType === 'EIP712Domain' ? {} : undefined)

  if (typeof primaryType !== 'string') {
    throw protocolError('The typed data names its primary type.')
  }

  if (domain !== undefined && !isObject(domain)) {
    throw protocolError('The typed data`s domain is an object.')
  }

  if (!isObject(message)) {
    throw protocolError('The typed data`s message is an object.')
  }

  return Object.freeze({
    ...(domain === undefined ? {} : {domain}),
    message,
    primaryType,
    types: readTypes(own(value, 'types')),
  })
}

/**
 * The JSON an `eth-sign-request` carries for typed data, as MetaMask's `JSON.stringify(typedData)` writes it: integers
 * that are `bigint` as decimal text (what every EIP-712 implementation reads, and no JSON number can hold exactly),
 * bytes as `0x` hex.
 */
export const typedDataJson = ({domain, message, primaryType, types}: TypedDataDefinition): string =>
  JSON.stringify({domain, message, primaryType, types}, (_key, value: unknown) =>
    typeof value === 'bigint'
      ? value.toString()
      : value instanceof Uint8Array
        ? hex.encode(value, {prefix: true})
        : value
  )

const ARRAY = /^(.+)\[([1-9][0-9]*)?\]$/
const INTEGER = /^u?int[0-9]+$/
const BYTES = /^bytes[0-9]*$/
const INTEGER_TEXT = /^(-?)(0x[0-9a-fA-F]+|[0-9]+)$/

/** EIP-712's domain fields, in its order, each with its one type. */
const DOMAIN_FIELDS: readonly TypedDataField[] = [
  {name: 'name', type: 'string'},
  {name: 'version', type: 'string'},
  {name: 'chainId', type: 'uint256'},
  {name: 'verifyingContract', type: 'address'},
  {name: 'salt', type: 'bytes32'},
]

const toBigInt = (value: unknown): bigint => {
  if (typeof value === 'bigint') {
    return value
  }

  if (typeof value === 'number') {
    return BigInt(value)
  }

  const match = INTEGER_TEXT.exec(String(value))
  const magnitude = BigInt(match?.[2] ?? '0')

  return match?.[1] === '-' ? -magnitude : magnitude
}

/**
 * Typed data as a review screen shows it, in the form that is hashed: the domain's fields `EIP712Domain` lists (as
 * declared, or those present), each member the types declare and no other, in declared order, integers as `bigint`,
 * addresses EIP-55, bytes as lowercase `0x` hex, the domain's chain id a `number`. Only for typed data the chain has
 * hashed already: its values are known to be of their types. It hashes to the same digest.
 */
export const reviewTypedData = (
  typedData: TypedDataDefinition,
  checksum: (address: string) => Address
): TypedDataDefinition => {
  const {types} = typedData

  const normalize = (type: string, value: unknown): unknown => {
    const array = ARRAY.exec(type)

    if (array) {
      return Object.freeze((value as readonly unknown[]).map(item => normalize(array[1] ?? '', item)))
    }

    if (type === 'address') {
      return checksum(value as string)
    }

    if (type === 'bool' || type === 'string') {
      return value
    }

    if (BYTES.test(type)) {
      return value instanceof Uint8Array ? hex.encode(value, {prefix: true}) : (value as string).toLowerCase()
    }

    if (INTEGER.test(type)) {
      return toBigInt(value)
    }

    const out: Record<string, unknown> = {}
    const record = value as {readonly [key: string]: unknown}

    for (const field of types[type] ?? []) {
      define(out, field.name, normalize(field.type, own(record, field.name)))
    }

    return Object.freeze(out)
  }

  const source = typedData.domain ?? {}
  const domainFields =
    types.EIP712Domain ??
    DOMAIN_FIELDS.filter(field => own(source as Record<string, unknown>, field.name) !== undefined)
  const domain: Record<string, unknown> = {}

  for (const field of domainFields) {
    const value = normalize(field.type, own(source as Record<string, unknown>, field.name))
    define(domain, field.name, field.name === 'chainId' ? Number(value) : value)
  }

  return Object.freeze({
    domain: Object.freeze(domain),
    message:
      typedData.primaryType === 'EIP712Domain'
        ? Object.freeze({})
        : (normalize(typedData.primaryType, typedData.message) as TypedDataDefinition['message']),
    primaryType: typedData.primaryType,
    types,
  })
}
