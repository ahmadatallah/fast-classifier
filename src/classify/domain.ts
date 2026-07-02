import { getDomain } from 'tldts'

/**
 * Registrable root domain of an address or host, public-suffix aware.
 * 'user@mail.amazon.co.uk' -> 'amazon.co.uk' (the origin session's naive
 * last-two-labels split wrongly produced 'co.uk'). Returns null for empty or
 * single-label input.
 */
export function rootDomain(emailOrDomain: string): string | null {
  const input = emailOrDomain.trim().toLowerCase()
  const at = input.lastIndexOf('@')
  const host = at >= 0 ? input.slice(at + 1) : input
  if (!host) return null
  const registrable = getDomain(host)
  if (registrable) return registrable.toLowerCase()
  // tldts returns null for hosts it cannot resolve (bare public suffixes,
  // internal hosts); fall back to the last two labels
  const labels = host.split('.').filter((l) => l.length > 0)
  if (labels.length < 2) return null
  return labels.slice(-2).join('.')
}
