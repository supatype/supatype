import { createHash, timingSafeEqual } from "node:crypto"
import type { IncomingMessage } from "node:http"

/**
 * The variable holding the secret shared with the gateway, and nothing else on the network.
 *
 * The control plane listens on the compose network, and so does the functions worker, which runs
 * user code. The gateway checks the service role before forwarding, but a caller on the network
 * could skip the gateway and call this directly. The secret is what tells the two apart.
 */
export const CONTROL_PLANE_SECRET_ENV = "SUPATYPE_CONTROL_PLANE_SECRET"

/** The header the gateway presents the secret in. Node lowercases incoming header names. */
export const CONTROL_PLANE_SECRET_HEADER = "x-supatype-control-plane-secret"

/** The configured secret, or "" when there is none. */
export function controlPlaneSecretFromEnv(): string {
  return process.env[CONTROL_PLANE_SECRET_ENV]?.trim() ?? ""
}

/**
 * A check of whether a request presents `secret`, hashed once here rather than per request.
 *
 * Fails closed: with no secret configured nothing is accepted, so a control plane started without
 * one refuses everybody rather than serving everybody. Both sides are hashed so the compare runs
 * over equal lengths in constant time, and the length of the secret is not given away either.
 */
export function secretCheck(secret: string): (req: IncomingMessage) => boolean {
  if (secret === "") return () => false
  const expected = digest(secret)
  return (req) => {
    const presented = req.headers[CONTROL_PLANE_SECRET_HEADER]
    if (typeof presented !== "string" || presented === "") return false
    return timingSafeEqual(digest(presented), expected)
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest()
}
