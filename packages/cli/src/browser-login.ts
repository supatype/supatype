/**
 * The CLI's half of the browser login handover (see `supatype login`).
 *
 * The CLI makes a session id and an ECDH P-256 key pair and sends the browser the public half. When
 * the user approves, the control plane makes a personal access token, encrypts it to that key and
 * holds it behind a device code the page shows. The CLI exchanges the code the user types for the
 * ciphertext and decrypts it. The code is what stops a link sent to a victim from logging their
 * browser into someone else's CLI.
 */
import { createDecipheriv, createECDH, hkdfSync, randomUUID, type ECDH } from "node:crypto"
import { hostname } from "node:os"
import { isShape, isString } from "@supatype/shared"

const PRODUCTION_ACCOUNTS_URL = "https://accounts.supatype.com"
const HKDF_INFO = "supatype-cli-login"
const GCM_TAG_BYTES = 16
const FETCH_TIMEOUT_MS = 15_000

/** One login attempt: what the CLI keeps to read the answer, and what it sends the browser. */
export interface LoginSession {
  sessionId: string
  tokenName: string
  keys: ECDH
}

/** The control plane's answer to the right device code, every field hex. */
interface SealedToken {
  access_token: string
  nonce: string
  public_key: string
}

const isSealedToken = isShape({ access_token: isString, nonce: isString, public_key: isString })

/** `cli_<hostname>_<unix seconds>`, what the token is called in the account's list of tokens. */
export function defaultTokenName(now: Date = new Date()): string {
  return `cli_${hostname()}_${Math.floor(now.getTime() / 1000)}`
}

export function newLoginSession(tokenName: string): LoginSession {
  const keys = createECDH("prime256v1")
  keys.generateKeys()
  return { sessionId: randomUUID(), tokenName, keys }
}

/**
 * Where the accounts site is: `SUPATYPE_ACCOUNTS_URL` when set, else the API URL's own host with its
 * `api.` label swapped for `accounts.` (api.lvh.me:18680 gives accounts.lvh.me:18680), else production.
 */
export function accountsUrl(apiUrl: string, env: NodeJS.ProcessEnv = process.env): string {
  const named = env["SUPATYPE_ACCOUNTS_URL"]?.trim()
  if (named) return named.replace(/\/+$/, "")
  try {
    const url = new URL(apiUrl)
    if (url.hostname.startsWith("api.")) return `${url.protocol}//accounts.${url.host.slice("api.".length)}`
  } catch {
    // An API URL that is not a URL cannot name a host; production is the only answer left.
  }
  return PRODUCTION_ACCOUNTS_URL
}

/** The page the user approves on, carrying the session, the token's name and the CLI's public key. */
export function loginUrl(accounts: string, session: LoginSession): string {
  const query = new URLSearchParams({
    session_id: session.sessionId,
    token_name: session.tokenName,
    public_key: session.keys.getPublicKey("hex"),
  })
  return `${accounts}/cli/login?${query.toString()}`
}

/**
 * Exchange the device code for the sealed token. Undefined when the control plane does not accept
 * the code (404: not approved, wrong, used or expired, which it deliberately does not tell apart).
 */
export async function fetchSealedToken(apiUrl: string, sessionId: string, deviceCode: string): Promise<SealedToken | undefined> {
  const code = deviceCode.replace(/[\s-]/g, "").toUpperCase()
  const url = `${apiUrl.replace(/\/+$/, "")}/api/v1/cli/login/${encodeURIComponent(sessionId)}?device_code=${encodeURIComponent(code)}`
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (res.status === 404) return undefined
  if (!res.ok) throw new Error(`Login failed (${res.status}) at ${url.split("?")[0] ?? url}`)
  const body: unknown = await res.json().catch(() => undefined)
  if (!isSealedToken(body)) throw new Error("The control plane's login answer was not what this CLI expects. Update the CLI.")
  return body
}

/** The personal access token inside `sealed`: ECDH with the server's key, HKDF-SHA256, AES-256-GCM. */
export function openSealedToken(session: LoginSession, sealed: SealedToken): string {
  const shared = session.keys.computeSecret(Buffer.from(sealed.public_key, "hex"))
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), HKDF_INFO, 32))
  const data = Buffer.from(sealed.access_token, "hex")
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.nonce, "hex"))
  decipher.setAuthTag(data.subarray(data.length - GCM_TAG_BYTES))
  return Buffer.concat([decipher.update(data.subarray(0, data.length - GCM_TAG_BYTES)), decipher.final()]).toString("utf8")
}
