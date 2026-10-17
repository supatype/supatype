// @vitest-environment jsdom
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { readSqlResponse } from "../src/hooks/useProjectProxy.js"
import { useApiQuery, type ApiQueryResult } from "../src/hooks/useApiQuery.js"
import { sqlstateOf } from "../src/lib/database-error.js"

/**
 * Studio tells database failures apart by Postgres's SQLSTATE, not by the wording of the message:
 * the wording changes with the server's language and between Postgres versions, the code does not.
 * So the code has to survive every layer between the SQL proxy's answer and the screen.
 */

function answer(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

async function failureOf(res: Response): Promise<unknown> {
  return readSqlResponse(res).then(
    () => {
      throw new Error("expected the SQL call to fail")
    },
    (err: unknown) => err,
  )
}

/** The message of a failure that has to be an `Error`. */
function messageOf(err: unknown): string {
  if (!(err instanceof Error)) throw new Error(`expected an Error, got ${String(err)}`)
  return err.message
}

describe("readSqlResponse()", () => {
  it("keeps the SQLSTATE the proxy sent beside its message", async () => {
    const err = await failureOf(answer(422, { error: "permission denied for table managed_objects", code: "42501" }))
    expect(err).toBeInstanceOf(Error)
    expect(messageOf(err)).toBe("permission denied for table managed_objects")
    expect(sqlstateOf(err)).toBe("42501")
  })

  it("reads the message from Cloud's shape, where `error` is a category", async () => {
    const err = await failureOf(answer(400, { error: "sql_error", message: 'relation "x" does not exist', code: "42P01" }))
    expect(messageOf(err)).toBe('relation "x" does not exist')
    expect(sqlstateOf(err)).toBe("42P01")
  })

  it("has no SQLSTATE when the proxy sent none, or sent something that is not one", async () => {
    expect(sqlstateOf(await failureOf(answer(422, { error: "boom" })))).toBeNull()
    expect(sqlstateOf(await failureOf(answer(422, { error: "boom", code: "sql_error" })))).toBeNull()
  })

  it("reads the SQLSTATE the server appends to its message, when it sends no code of its own", async () => {
    // The self-host server's answer, verbatim from a running stack: pgx's error text, which ends
    // with the SQLSTATE in a fixed form.
    const err = await failureOf(
      answer(500, { error: 'ERROR: relation "_supatype.no_such_ledger" does not exist (SQLSTATE 42P01)' }),
    )
    expect(sqlstateOf(err)).toBe("42P01")
    // A code the proxy sent wins over anything in the text.
    const both = await failureOf(answer(422, { error: "x (SQLSTATE 42P01)", code: "42501" }))
    expect(sqlstateOf(both)).toBe("42501")
  })

  it("returns the rows of a query that worked", async () => {
    const result = await readSqlResponse(answer(200, { rows: [{ a: 1 }], rowCount: 1 }))
    expect(result).toEqual({ rows: [{ a: 1 }], rowCount: 1 })
  })
})

describe("useApiQuery()", () => {
  let container: HTMLDivElement
  let root: Root
  let seen: ApiQueryResult<number> | null

  function Probe({ fail }: { fail: () => Promise<number> }): null {
    seen = useApiQuery(fail, [fail])
    return null
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    seen = null
    container = document.createElement("div")
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
  })

  async function run(fail: () => Promise<number>): Promise<ApiQueryResult<number>> {
    await act(async () => root.render(<Probe fail={fail} />))
    await act(async () => {
      await Promise.resolve()
    })
    return seen!
  }

  it("passes the SQLSTATE of a failure on beside its message", async () => {
    const result = await run(async () => {
      throw Object.assign(new Error("permission denied for table managed_objects"), { code: "42501" })
    })
    expect(result.error).toBe("permission denied for table managed_objects")
    expect(result.failure?.code).toBe("42501")
  })

  it("has no SQLSTATE for a failure that carried none, nor once a query succeeds", async () => {
    expect((await run(async () => Promise.reject(new Error("offline")))).failure?.code).toBeNull()
    expect((await run(async () => 1)).failure).toBeNull()
  })
})
