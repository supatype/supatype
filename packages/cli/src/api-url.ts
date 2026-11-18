/** The Supatype Cloud control plane, where a command goes when nothing names another. */
export const DEFAULT_API_URL = "https://api.supatype.com"

/** `url` without the slashes that end it, so a path can be appended with one of its own. */
export function trimApiUrl(url: string): string {
  return url.replace(/\/+$/, "")
}

/**
 * The Cloud control plane a command asks: the first of `candidates`, in the order given, that
 * names one, else {@link DEFAULT_API_URL}. A blank value names none. Each command lists its own
 * sources (a flag, `SUPATYPE_API_URL`, what `login` stored), so they differ in what they read but
 * not in how a missing or blank one is skipped and the slashes trimmed.
 */
export function pickApiUrl(...candidates: ReadonlyArray<string | undefined>): string {
  const named = candidates.map((candidate) => candidate?.trim() ?? "").find((candidate) => candidate !== "")
  return trimApiUrl(named ?? DEFAULT_API_URL)
}
