import { describe, expect, it } from "vitest"
import { MIN_JWT_SECRET_LENGTH, jwtSecretTooShort } from "../src/jwt-secret-length.js"
import { FALLBACK_JWT_SECRET } from "../src/local-secrets.js"

/**
 * PostgREST 13 and later refuse to start when the JWT secret is shorter than 32 characters. The
 * stack would come up with every service but the REST API, which restarts in a loop and says why
 * only in its own log, so the CLI checks the secret before it starts anything.
 */
describe("JWT secret length", () => {
  it("is the floor PostgREST enforces", () => {
    expect(MIN_JWT_SECRET_LENGTH).toBe(32)
  })

  it("refuses a secret one character short, and says how long it is", () => {
    const problem = jwtSecretTooShort("x".repeat(31))
    expect(problem).toContain("31 characters")
    expect(problem).toContain("at least 32")
  })

  it("accepts a secret of exactly the floor", () => {
    expect(jwtSecretTooShort("x".repeat(32))).toBeNull()
  })

  it("accepts the fallback a project without .env runs with", () => {
    expect(jwtSecretTooShort(FALLBACK_JWT_SECRET)).toBeNull()
  })
})
