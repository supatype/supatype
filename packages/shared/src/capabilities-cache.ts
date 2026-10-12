/** How long an engine's or a server's answer is trusted before it is asked again. */
export const CAPABILITIES_TTL_MS = 5 * 60_000

/**
 * Answers by key (a binary, a project and image, a server), each with when it was given. With
 * `ttlMs`, an answer older than that is asked again; without, the key itself changes when the
 * engine does.
 */
export interface CapabilitiesCache<T> {
  answers: Map<string, { caps: T; at: number }>
  ttlMs?: number
}

/** A cache of answers, trusted for `ttlMs` when given. */
export function capabilitiesCache<T>(ttlMs?: number): CapabilitiesCache<T> {
  return { answers: new Map(), ...(ttlMs !== undefined && { ttlMs }) }
}

function recalled<T>(cache: CapabilitiesCache<T>, key: string): T | undefined {
  const known = cache.answers.get(key)
  if (known === undefined) return undefined
  if (cache.ttlMs === undefined || Date.now() - known.at <= cache.ttlMs) return known.caps
  cache.answers.delete(key)
  return undefined
}

function remember<T>(cache: CapabilitiesCache<T>, key: string, caps: T): T {
  cache.answers.set(key, { caps, at: Date.now() })
  return caps
}

/** The answer for `key`, asked with `probe` unless one is known. A throw is not remembered. */
export function rememberCapabilitiesSync<T>(cache: CapabilitiesCache<T>, key: string, probe: () => T): T {
  return recalled(cache, key) ?? remember(cache, key, probe())
}

/** {@link rememberCapabilitiesSync} for a probe that has to wait, such as a request to a server. */
export async function rememberCapabilities<T>(
  cache: CapabilitiesCache<T>,
  key: string,
  probe: () => Promise<T>,
): Promise<T> {
  return recalled(cache, key) ?? remember(cache, key, await probe())
}
