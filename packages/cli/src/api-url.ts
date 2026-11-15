/** The Supatype Cloud control plane, where a command goes when nothing names another. */
export const DEFAULT_API_URL = "https://api.supatype.com"

/** `url` without the slashes that end it, so a path can be appended with one of its own. */
export function trimApiUrl(url: string): string {
  return url.replace(/\/+$/, "")
}
