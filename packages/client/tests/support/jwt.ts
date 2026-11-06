/** An unsigned JWT carrying `payload`: the client only ever decodes the payload, never checks the signature. */
export function fakeJwt(payload: Record<string, unknown>): string {
  return `${btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${btoa(JSON.stringify(payload))}.sig`
}

/** A fake access token that expires in an hour. */
export function liveAccessToken(): string {
  return fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 })
}
