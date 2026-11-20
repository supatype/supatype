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
import { errorMessage } from "./error-message.js"
import { trimApiUrl } from "./api-url.js"
import { fetchWithin } from "./fetch-within.js"

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

const isLoginConfig = isShape({ accounts_url: isString })

/** `value` as an http(s) URL without its closing slashes, or undefined when it is not one. */
function webUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:" ? trimApiUrl(value) : undefined
  } catch {
    return undefined
  }
}

function accountsUnknown(apiUrl: string, why: string): Error {
  return new Error(`Could not find the accounts site for ${apiUrl}: ${why}. Set SUPATYPE_ACCOUNTS_URL to its address and run: supatype login`)
}

/**
 * Where the accounts site is: `SUPATYPE_ACCOUNTS_URL` when set, else what the control plane says at
 * `/api/v1/cli/login/config`. Never a guess from the API URL's name: when it cannot be found this
 * throws, naming the API URL.
 */
export async function accountsUrl(apiUrl: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const named = env["SUPATYPE_ACCOUNTS_URL"]?.trim()
  if (named) return trimApiUrl(named)
  const res = await fetchWithin(`${trimApiUrl(apiUrl)}/api/v1/cli/login/config`, FETCH_TIMEOUT_MS).catch((err: unknown) => {
    throw accountsUnknown(apiUrl, `it did not answer (${errorMessage(err)})`)
  })
  if (!res.ok) throw accountsUnknown(apiUrl, `it answered ${res.status}`)
  const body: unknown = await res.json().catch(() => undefined)
  const found = isLoginConfig(body) ? webUrl(body.accounts_url) : undefined
  if (found === undefined) throw accountsUnknown(apiUrl, "it did not give an http(s) accounts_url")
  return found
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
  const url = `${trimApiUrl(apiUrl)}/api/v1/cli/login/${encodeURIComponent(sessionId)}?device_code=${encodeURIComponent(deviceCode)}`
  const res = await fetchWithin(url, FETCH_TIMEOUT_MS)
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
