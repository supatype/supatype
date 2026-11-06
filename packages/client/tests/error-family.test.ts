/**
 * One error family. `SupatypeError` is the class of every error a result carries, imported as a
 * value and a type from the main entry. The errors the SDK throws are `SupatypeCodedError`s: the
 * same class with a required `code` and a `helpUrl`, so `instanceof SupatypeError` names them too.
 * A status is `status` everywhere; there is no second name for it.
 */

import { describe, expect, it, vi } from "vitest"
import {
  AuthError,
  createClient,
  getErrorDocumentation,
  MissingClientValuesError,
  NetworkError,
  PostgrestError,
  RateLimitError,
  StorageError,
  SupatypeCodedError,
  SupatypeError,
} from "../src/index.js"

describe("SupatypeError, the class every result error is", () => {
  it("is what a request that failed in transit resolves with", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("fetch failed")))
    const { error } = await createClient({ url: "http://127.0.0.1:9", anonKey: "x", retry: false }).from("posts").select("id")
    vi.unstubAllGlobals()

    expect(error).toBeInstanceOf(SupatypeError)
    expect(error).toBeInstanceOf(NetworkError)
    expect(String(error)).toBe("NetworkError: fetch failed")
  })

  it("is a value: built from a result's fields, its JSON and spread are exactly those fields", () => {
    const error: SupatypeError = new SupatypeError({ message: "refused", status: 403, code: "42501", hint: "ask" })

    expect(error.message).toBe("refused")
    expect({ ...error }).toEqual({ message: "refused", status: 403, code: "42501", hint: "ask" })
    expect(JSON.parse(JSON.stringify(error))).toEqual({ message: "refused", status: 403, code: "42501", hint: "ask" })
  })
})

describe("SupatypeCodedError, the errors the SDK throws", () => {
  it.each([
    ["NetworkError", new NetworkError("offline")],
    ["RateLimitError", new RateLimitError(3)],
    ["AuthError", new AuthError("no")],
    ["StorageError", new StorageError("no", "STORAGE_ERROR", 413)],
    ["PostgrestError", new PostgrestError("no")],
  ])("%s is a SupatypeCodedError and a SupatypeError", (_name, thrown) => {
    expect(thrown).toBeInstanceOf(SupatypeCodedError)
    expect(thrown).toBeInstanceOf(SupatypeError)
    expect(thrown.helpUrl).toBe(`https://docs.supatype.com/errors#${thrown.code.toLowerCase()}`)
  })

  it("carries its HTTP status as status, the one name for it", () => {
    expect(new RateLimitError(3).status).toBe(429)
    expect(new StorageError("too big", "STORAGE_FILE_TOO_LARGE", 413).status).toBe(413)
    expect(PostgrestError.fromResponse({ message: "denied", code: "42501" }, 403).status).toBe(403)
    expect(JSON.parse(JSON.stringify(new RateLimitError(3)))).toEqual({
      message: "Rate limited. Retry after 3 seconds.",
      code: "RATE_LIMITED",
      status: 429,
    })
  })

  it("leaves a PostgREST hint and details absent, not null, when the server gave none", () => {
    const error = new PostgrestError("no")
    expect(error.hint).toBeUndefined()
    expect(error.details).toBeUndefined()
  })

  it("counts a client with no address or anon key among them", () => {
    const error = new MissingClientValuesError("no values", ["url"])
    expect(error).toBeInstanceOf(SupatypeCodedError)
    expect(error).toBeInstanceOf(SupatypeError)
    expect(error.code).toBe("MISSING_CLIENT_VALUES")
    expect(getErrorDocumentation(error.code)?.category).toBe("setup")
  })
})
