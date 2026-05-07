/**
 * Best-effort partial-JSON parser.
 *
 * `JSON.parse` can't handle the truncated JSON we receive while a tool
 * call is still streaming. This helper closes whatever containers and
 * strings are still open and tries to parse the result. The goal is
 * "show the user something useful", not faithful reconstruction — we
 * deliberately tolerate dropped trailing characters and return null
 * when the input is too garbled to yield anything.
 */

const TOKEN_OPEN_OBJECT = '{'
const TOKEN_OPEN_ARRAY = '['
const TOKEN_CLOSE_OBJECT = '}'
const TOKEN_CLOSE_ARRAY = ']'
const TOKEN_QUOTE = '"'

function fastParse(input: string): unknown | undefined {
  try {
    return JSON.parse(input)
  } catch {
    return undefined
  }
}

/**
 * Try to make `raw` syntactically valid JSON by stripping trailing
 * fragments and appending the closers needed to balance the open
 * containers. We attempt a few progressively more aggressive fixups
 * because trimming the wrong amount can leave an empty key/value
 * pair behind (e.g. `{"a":1,"b` → after closing the open string we'd
 * get `{"a":1,"b"}` which is invalid; trimming the dangling key gives
 * us `{"a":1}` which parses).
 */
export function tryParsePartialJson(raw: string): unknown {
  if (!raw) return null
  const trimmed = raw.trimStart()
  if (!trimmed) return null

  const direct = fastParse(trimmed)
  if (direct !== undefined) return direct

  const stack: string[] = []
  let inString = false
  let escaped = false

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === TOKEN_QUOTE) {
        inString = false
      }
      continue
    }
    if (ch === TOKEN_QUOTE) {
      inString = true
      continue
    }
    if (ch === TOKEN_OPEN_OBJECT || ch === TOKEN_OPEN_ARRAY) {
      stack.push(ch)
    } else if (ch === TOKEN_CLOSE_OBJECT || ch === TOKEN_CLOSE_ARRAY) {
      stack.pop()
    }
  }

  let candidate = trimmed
  if (escaped) {
    candidate = candidate.slice(0, -1)
  }
  if (inString) {
    candidate += TOKEN_QUOTE
  }

  const closers = stack
    .slice()
    .reverse()
    .map((open) =>
      open === TOKEN_OPEN_OBJECT ? TOKEN_CLOSE_OBJECT : TOKEN_CLOSE_ARRAY,
    )
    .join('')

  // First attempt: close as-is.
  const firstAttempt = fastParse(candidate + closers)
  if (firstAttempt !== undefined) return firstAttempt

  // Strip a trailing comma and try again.
  const noTrailingComma = candidate.replace(/,\s*$/, '')
  const secondAttempt = fastParse(noTrailingComma + closers)
  if (secondAttempt !== undefined) return secondAttempt

  // Strip a dangling key fragment like `,"key` or `,"key":` so the
  // surrounding object still parses.
  const noDanglingKey = noTrailingComma
    .replace(/,\s*"[^"]*"\s*:?\s*$/u, '')
    .replace(/,\s*"[^"]*$/u, '')
    .replace(/\{\s*"[^"]*"\s*:?\s*$/u, '{')
    .replace(/\{\s*"[^"]*$/u, '{')
  const thirdAttempt = fastParse(noDanglingKey + closers)
  if (thirdAttempt !== undefined) return thirdAttempt

  // Strip a dangling property whose value never finished, e.g.
  // `{"a":1,"b":` or `{"a":1,"b":"foo` (after the closer attempt left
  // an unterminated value).
  const noDanglingValue = noDanglingKey.replace(
    /,\s*"[^"]*"\s*:\s*[^,{}\[\]]*$/u,
    '',
  )
  const fourthAttempt = fastParse(noDanglingValue + closers)
  if (fourthAttempt !== undefined) return fourthAttempt

  return null
}
