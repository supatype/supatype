/**
 * `fetch` with a deadline, because the built-in has none.
 *
 * A poll loop bounded by `maxSec` iterations is only bounded if each attempt can end. Against a
 * socket that accepts and never responds, an un-timed `fetch` never settles, the loop never reaches
 * its second iteration, and a wait advertised as 120 seconds runs until someone kills it. That is
 * how `supatype push` came to hang indefinitely after reporting the schema applied.
 */
export async function fetchWithin(url: string, ms: number, init?: RequestInit): Promise<Response> {
  return await fetch(url, { ...init, signal: AbortSignal.timeout(ms) })
}
