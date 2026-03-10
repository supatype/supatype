import { createHmac } from "node:crypto"

export function signJwt(payload: Record<string, unknown>, secret: string): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = base64url(JSON.stringify(payload))
  const sig = createHmac("sha256", secret)
    .update(`${header}.${body}`)
    .digest("base64url")
  return `${header}.${body}.${sig}`
}

export function base64url(str: string): string {
  return Buffer.from(str, "utf8").toString("base64url")
}
