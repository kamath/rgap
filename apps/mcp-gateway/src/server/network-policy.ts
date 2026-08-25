import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { HttpError } from './http'

export async function assertAllowedServerUrl(value: string) {
  const url = new URL(value)
  if (url.username || url.password) {
    throw new HttpError(400, 'MCP server URLs cannot contain credentials.')
  }
  const allowPrivate =
    process.env.ALLOW_PRIVATE_MCP_URLS === 'true' ||
    process.env.NODE_ENV !== 'production'
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) {
    throw new HttpError(400, 'MCP server URLs must use HTTPS.')
  }
  if (allowPrivate) return url

  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await lookup(url.hostname, { all: true, verbatim: true })
  if (!addresses.length || addresses.some(({ address }) => isPrivate(address))) {
    throw new HttpError(400, 'MCP server URL resolves to a private network.')
  }
  return url
}

function isPrivate(address: string) {
  if (address === '::1' || address === '::') return true
  const lower = address.toLowerCase()
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true
  if (/^fe[89ab]/.test(lower)) return true
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1]
  const ipv4 = mapped ?? (isIP(address) === 4 ? address : undefined)
  if (!ipv4) return false
  const [first, second] = ipv4.split('.').map(Number)
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second! >= 16 && second! <= 31) ||
    (first === 192 && second === 168) ||
    first! >= 224
  )
}
