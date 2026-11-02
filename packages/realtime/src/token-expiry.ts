import type { JwtClaims } from "./auth.js"

/** The close code for a socket whose token expired: 4000 plus the HTTP status, as 4400 and 4429 are. */
export const TOKEN_EXPIRED_CLOSE = 4401

/** The longest delay a timer holds; anything later is reached in steps of this. */
const MAX_TIMER_MS = 2 ** 31 - 1

interface Watched {
  /** What to do when the token runs out: close the socket. */
  expired: () => void
  timer: ReturnType<typeof setTimeout> | null
}

/**
 * One timer per socket, firing when the token it authenticated with expires.
 *
 * A token is verified once, at the upgrade or on an `auth` message, and the claims it yields are
 * what every later delivery is judged by. Nothing read `exp` after that, so a socket kept its
 * user's view of the data for as long as it stayed open. New claims replace the timer, so a client
 * that sends a fresh token before the old one runs out is not closed.
 */
export class TokenExpiry {
  private readonly sockets = new Map<string, Watched>()

  /** Register a socket, with what to do when whatever token it holds expires. */
  add(id: string, expired: () => void): void {
    this.sockets.set(id, { expired, timer: null })
  }

  /** Fire `id`'s expiry at `claims.exp`, replacing any earlier one. Claims with no `exp` never expire. */
  watch(id: string, claims: JwtClaims): void {
    const socket = this.sockets.get(id)
    if (socket === undefined) return
    this.cancel(socket)
    if (typeof claims.exp === "number") this.schedule(socket, claims.exp * 1000)
  }

  /** Stop watching `id`, for a socket that closed. */
  remove(id: string): void {
    const socket = this.sockets.get(id)
    if (socket !== undefined) this.cancel(socket)
    this.sockets.delete(id)
  }

  /** Stop watching every socket, for a server shutting down. */
  clear(): void {
    for (const id of [...this.sockets.keys()]) this.remove(id)
  }

  private cancel(socket: Watched): void {
    if (socket.timer !== null) clearTimeout(socket.timer)
    socket.timer = null
  }

  private schedule(socket: Watched, expiresAtMs: number): void {
    const remaining = expiresAtMs - Date.now()
    socket.timer = setTimeout(() => {
      socket.timer = null
      // A timer can fire a little early, and one longer than a timer can hold is reached in
      // steps; either way, check again rather than close a socket whose token is still in date.
      if (Date.now() < expiresAtMs) this.schedule(socket, expiresAtMs)
      else socket.expired()
    }, Math.max(0, Math.min(remaining, MAX_TIMER_MS)))
  }
}
