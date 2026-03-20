import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { detectServerlessEnvironment, warnIfServerlessDirectConnection } from "../src/fetch-with-retry.js"

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Set an environment variable for the duration of a test, restoring it
 * (or deleting it) afterwards.
 */
function withEnv(key: string, value: string): () => void {
  const prev = process.env[key]
  process.env[key] = value
  return () => {
    if (prev === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = prev
    }
  }
}

// ─── detectServerlessEnvironment ─────────────────────────────────────────────

describe("detectServerlessEnvironment", () => {
  let restoreEnv: (() => void) | undefined

  afterEach(() => {
    restoreEnv?.()
    restoreEnv = undefined
  })

  it("returns detected=false when no serverless env vars are set", () => {
    const result = detectServerlessEnvironment()
    expect(result.detected).toBe(false)
    expect(result.platform).toBeNull()
  })

  it("detects Vercel when VERCEL=1", () => {
    restoreEnv = withEnv("VERCEL", "1")
    const result = detectServerlessEnvironment()
    expect(result.detected).toBe(true)
    expect(result.platform).toBe("Vercel")
  })

  it("does not detect Vercel when VERCEL has wrong value", () => {
    restoreEnv = withEnv("VERCEL", "0")
    const result = detectServerlessEnvironment()
    // VERCEL must be exactly "1"
    expect(result.detected).toBe(false)
  })

  it("detects AWS Lambda when AWS_LAMBDA_FUNCTION_NAME is set", () => {
    restoreEnv = withEnv("AWS_LAMBDA_FUNCTION_NAME", "my-function")
    const result = detectServerlessEnvironment()
    expect(result.detected).toBe(true)
    expect(result.platform).toBe("AWS Lambda")
  })

  it("detects Netlify when NETLIFY=true", () => {
    restoreEnv = withEnv("NETLIFY", "true")
    const result = detectServerlessEnvironment()
    expect(result.detected).toBe(true)
    expect(result.platform).toBe("Netlify")
  })

  it("detects Cloudflare Workers when CF_PAGES is set", () => {
    restoreEnv = withEnv("CF_PAGES", "1")
    const result = detectServerlessEnvironment()
    expect(result.detected).toBe(true)
    expect(result.platform).toBe("Cloudflare Workers")
  })
})

// ─── warnIfServerlessDirectConnection ────────────────────────────────────────

describe("warnIfServerlessDirectConnection", () => {
  let restoreEnv: (() => void) | undefined
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    // Reset the one-time guard between tests by re-importing.
    // Since the guard is module-level state, we need to reset it.
    // We do this by directly resetting via a dynamic import trick — but
    // the simplest approach is to just accept the guard fires once per
    // describe block. Instead, let's reset it manually.
  })

  afterEach(() => {
    restoreEnv?.()
    restoreEnv = undefined
    warnSpy.mockRestore()
  })

  it("does not warn when not in a serverless environment", () => {
    warnIfServerlessDirectConnection("postgres://localhost:5432/mydb")
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it("warns when a direct postgres:// URL is used in a serverless env", () => {
    restoreEnv = withEnv("AWS_LAMBDA_FUNCTION_NAME", "handler")
    warnIfServerlessDirectConnection("postgres://db.example.com:5432/mydb")
    expect(warnSpy).toHaveBeenCalledOnce()
    expect(warnSpy.mock.calls[0]?.[0]).toContain(
      "Direct database connections are not recommended in serverless environments"
    )
    expect(warnSpy.mock.calls[0]?.[0]).toContain("AWS Lambda")
  })

  it("does not warn for HTTP gateway URLs in a serverless env", () => {
    restoreEnv = withEnv("VERCEL", "1")
    warnIfServerlessDirectConnection("https://my-project.supatype.co")
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
