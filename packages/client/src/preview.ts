/**
 * A preview link's credential, and the exchange that turns it into a usable token.
 *
 * # Why there is an exchange at all
 *
 * The link used to *be* the token: a signed JWT carrying the preview claim, pasted into a URL. That
 * worked, and it had two costs. The URL ran to about 400 characters, and a signed token cannot be
 * recalled, so withdrawing one link meant bumping a counter that stranded every other link in the
 * project at the same time.
 *
 * So the link is now a short code naming a row, and the server hands back a token that lives about
 * a minute. Revoking the row stops the next exchange, which is what makes per-link revocation mean
 * anything. The token is still what the database sees, so no policy changed.
 *
 * # Why the token is cached here
 *
 * A page render issues several queries. Exchanging per query would multiply a page load by the
 * number of tables it touches, for a credential that does not change between them. One exchange is
 * shared, and a second caller arriving mid-flight waits on the same promise rather than starting
 * its own.
 */

/** Seconds of slack before expiry at which the token is treated as spent. */
const REFRESH_SKEW_MS = 5_000

/**
 * Thrown when a code will not resolve, for any reason.
 *
 * The server does not say which reason and neither does this: distinguishing "revoked" from "never
 * existed" would confirm to a stranger that a draft is there to be found. The message is written
 * for the person holding the link rather than for the developer, because it is usually shown to
 * them directly.
 */
export class PreviewLinkError extends Error {
  constructor(message = "This preview link is not valid. It may have expired, or been revoked.") {
    super(message)
    this.name = "PreviewLinkError"
  }
}

interface ExchangeResponse {
  token?: unknown
  expiresAt?: unknown
}

/**
 * Holds one preview code and the short-lived token most recently bought with it.
 *
 * A class rather than a closure on purpose: a closure here would capture the whole client config
 * for as long as any request is outstanding, and this needs two strings.
 */
export class PreviewCredential {
  readonly #endpoint: string
  readonly #code: string
  #token: string | null = null
  #expiresAtMs = 0
  #inFlight: Promise<string> | null = null

  constructor(baseUrl: string, code: string) {
    this.#endpoint = `${baseUrl.replace(/\/$/, "")}/preview-links/resolve`
    this.#code = code
  }

  /** A token good right now, exchanging first if the one in hand is spent. */
  async token(): Promise<string> {
    if (this.#token !== null && Date.now() < this.#expiresAtMs - REFRESH_SKEW_MS) {
      return this.#token
    }
    // Whoever gets here first does the exchange; everyone else waits on it.
    this.#inFlight ??= this.#exchange().finally(() => {
      this.#inFlight = null
    })
    return this.#inFlight
  }

  async #exchange(): Promise<string> {
    let response: Response
    try {
      response = await fetch(this.#endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: this.#code }),
      })
    } catch {
      // A network failure is not an invalid link, and saying so would send the reader to ask for a
      // replacement that would work no better.
      throw new PreviewLinkError("Could not reach the server to check this preview link.")
    }

    if (!response.ok) throw new PreviewLinkError()

    const body = (await response.json().catch(() => ({}))) as ExchangeResponse
    if (typeof body.token !== "string" || body.token === "") throw new PreviewLinkError()

    const expiresAt = typeof body.expiresAt === "string" ? Date.parse(body.expiresAt) : NaN
    this.#token = body.token
    // An unparseable expiry means exchanging again next time rather than trusting a token for an
    // unknown length of time.
    this.#expiresAtMs = Number.isNaN(expiresAt) ? 0 : expiresAt
    return body.token
  }
}
