/** A personal access token: `spt_` and 40 lowercase hex characters. */
const PERSONAL_ACCESS_TOKEN = /^spt_[0-9a-f]{40}$/

/**
 * Whether `token` is a personal access token, which `supatype login` and `--token` store. Unlike a
 * session it has no refresh token and is not renewed: it lasts until it is revoked or its own
 * expiry, and the control plane refusing it means it must be replaced.
 */
export function isPersonalAccessToken(token: string | undefined): boolean {
  return token !== undefined && PERSONAL_ACCESS_TOKEN.test(token)
}
