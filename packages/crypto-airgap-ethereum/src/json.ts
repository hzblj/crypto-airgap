import {protocolError} from '@hzblj/crypto-airgap'

/**
 * A JSON value as `readJson` returns it. An integer is a `number` while it is a safe integer and a `bigint` beyond,
 * so a `uint256` written as a JSON number keeps every digit.
 */
export type JsonValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | readonly JsonValue[]
  | {readonly [key: string]: JsonValue}

const NUMBER = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/y

/** Digits enough for any EIP-712 integer (a uint256 has 78), and no more: a longer one is refused before BigInt. */
const MAX_DIGITS = 80

const ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  '/': '/',
  '\\': '\\',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
}

/**
 * Reads JSON (RFC 8259) strictly, for payloads that arrive from outside: no comments, trailing commas, `NaN` or
 * unescaped control characters; nothing after the value; objects nested at most `maxDepth` deep (arrays and objects
 * alike); no key twice in an object (two parsers of one payload must never read two values); no lone surrogate
 * escapes; and, for typed data, no NUL character and no number with a fraction or an exponent. Keys such as
 * `__proto__` are own properties, never prototypes. Errors give a position, never the text.
 */
export const readJson = (text: string, maxDepth: number): JsonValue => {
  let at = 0

  const fail = (what: string) => protocolError(`The JSON ${what} (at character ${at}).`)

  const skipSpace = () => {
    for (let code = text.charCodeAt(at); code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d; ) {
      code = text.charCodeAt(++at)
    }
  }

  const expect = (char: string) => {
    if (text[at] !== char) {
      throw fail(`has something else where ${char} belongs`)
    }

    at++
  }

  const hex4 = () => {
    const digits = text.slice(at, at + 4)

    if (!/^[0-9a-fA-F]{4}$/.test(digits)) {
      throw fail('has a \\u escape without four hex digits')
    }

    at += 4

    return Number.parseInt(digits, 16)
  }

  const readString = (): string => {
    expect('"')
    let out = ''
    let start = at

    for (;;) {
      if (at >= text.length) {
        throw fail('ends inside a string')
      }

      const code = text.charCodeAt(at)

      if (code === 0x22) {
        out += text.slice(start, at)
        at++

        return out
      }

      if (code < 0x20) {
        throw fail('has a control character in a string')
      }

      if (code !== 0x5c) {
        at++
        continue
      }

      out += text.slice(start, at)
      at++
      const escaped = text[at] ?? ''
      at++

      if (escaped !== 'u') {
        const char = ESCAPES[escaped]

        if (char === undefined) {
          throw fail('has an unknown escape in a string')
        }

        out += char
        start = at
        continue
      }

      const unit = hex4()

      if (unit >= 0xdc00 && unit <= 0xdfff) {
        throw fail('has a lone surrogate escape')
      }

      if (unit >= 0xd800 && unit <= 0xdbff) {
        if (text.slice(at, at + 2) !== '\\u') {
          throw fail('has a lone surrogate escape')
        }

        at += 2
        const low = hex4()

        if (low < 0xdc00 || low > 0xdfff) {
          throw fail('has a lone surrogate escape')
        }

        out += String.fromCharCode(unit, low)
      } else {
        if (unit === 0) {
          throw fail('has a NUL character, which typed data refuses')
        }

        out += String.fromCharCode(unit)
      }

      start = at
    }
  }

  const readNumber = (): number | bigint => {
    NUMBER.lastIndex = at
    const match = NUMBER.exec(text)

    if (!match) {
      throw fail('has something that is not a value')
    }

    const [literal = '', fraction, exponent] = match

    if (fraction !== undefined || exponent !== undefined) {
      throw fail('has a number with a fraction or an exponent, which no EIP-712 type takes')
    }

    if (literal.length > MAX_DIGITS) {
      throw fail('has an integer longer than any EIP-712 type holds')
    }

    at += literal.length
    const value = Number(literal)

    if (Number.isSafeInteger(value)) {
      return value === 0 ? 0 : value
    }

    return BigInt(literal)
  }

  const readLiteral = <T>(word: string, value: T): T => {
    if (text.slice(at, at + word.length) !== word) {
      throw fail('has something that is not a value')
    }

    at += word.length

    return value
  }

  const readValue = (depth: number): JsonValue => {
    skipSpace()

    switch (text[at]) {
      case '{':
        return readObject(depth + 1)
      case '[':
        return readArray(depth + 1)
      case '"':
        return readString()
      case 't':
        return readLiteral('true', true)
      case 'f':
        return readLiteral('false', false)
      case 'n':
        return readLiteral('null', null)
      default:
        return readNumber()
    }
  }

  const readArray = (depth: number): readonly JsonValue[] => {
    if (depth > maxDepth) {
      throw fail(`nests arrays and objects deeper than ${maxDepth} levels`)
    }

    expect('[')
    const out: JsonValue[] = []
    skipSpace()

    if (text[at] === ']') {
      at++

      return out
    }

    for (;;) {
      out.push(readValue(depth))
      skipSpace()

      if (text[at] === ']') {
        at++

        return out
      }

      expect(',')
    }
  }

  const readObject = (depth: number): {readonly [key: string]: JsonValue} => {
    if (depth > maxDepth) {
      throw fail(`nests arrays and objects deeper than ${maxDepth} levels`)
    }

    expect('{')
    const out: Record<string, JsonValue> = {}
    const keys = new Set<string>()
    skipSpace()

    if (text[at] === '}') {
      at++

      return out
    }

    for (;;) {
      skipSpace()
      const key = readString()

      if (keys.has(key)) {
        throw fail('has a key twice in one object')
      }

      keys.add(key)
      skipSpace()
      expect(':')
      // A property of its own, whatever its name: `__proto__` included.
      Object.defineProperty(out, key, {configurable: true, enumerable: true, value: readValue(depth), writable: true})
      skipSpace()

      if (text[at] === '}') {
        at++

        return out
      }

      expect(',')
    }
  }

  const value = readValue(0)
  skipSpace()

  if (at !== text.length) {
    throw fail('has something after its value')
  }

  return value
}
