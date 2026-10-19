import { afterEach, describe, expect, it, vi } from "vitest"
import { duplicateRecord, nextFreeCopy, uniqueViolationColumns } from "../src/lib/duplicate-record.js"
import { isJsonObject } from "../src/lib/json.js"
import { testClient, testField, testModel } from "./support.js"

/**
 * Duplicate copied every value, unique ones included, so on a model with a unique slug (Talk,
 * Speaker, Page in kitchen-sink) it answered 409 `talk_slug_key` and made no copy. A collided slug
 * now moves to the next free `-copy` value; any other collided unique value is left for the editor
 * to fill in on the create form.
 */

const URL_BASE = "http://localhost:8000"

const MODEL = testModel({
  name: "talk",
  tableName: "talk",
  fields: [
    testField({ name: "title" }),
    testField({ name: "slug", label: "Slug", widget: "slug" }),
    testField({ name: "code", label: "Code" }),
  ],
})

/** PostgREST's answer to an insert whose `column` value already exists. */
function conflict(column: string, value: string): Response {
  const details = `Key (${column})=(${value}) already exists.`
  return Response.json({ code: "23505", details, message: `duplicate key value violates unique constraint "talk_${column}_key"` }, { status: 409 })
}

interface Store {
  inserts: Record<string, unknown>[]
  likes: string[]
}

/** A table holding `existing` rows, refusing any insert that repeats one of their unique values. */
function stubTable(existing: Record<string, string>[], store: Store): void {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    if (init?.method === "POST") {
      const sent: unknown = JSON.parse(String(init.body))
      if (!isJsonObject(sent)) throw new Error("expected a row")
      store.inserts.push(sent)
      for (const column of ["slug", "code"]) {
        const value = sent[column]
        if (value !== undefined && existing.some((r) => r[column] === value)) return conflict(column, String(value))
      }
      return Response.json([{ id: "copy-id", ...sent }], { status: 201 })
    }
    const like = url.searchParams.get("slug") ?? ""
    store.likes.push(like)
    const prefix = like.replace(/^like\./, "").replace(/%$/, "")
    return Response.json(existing.filter((r) => (r["slug"] ?? "").startsWith(prefix)).map((r) => ({ slug: r["slug"] })))
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("Duplicate", () => {
  it("gives a copy of a record with a unique slug the next free -copy slug", async () => {
    const store: Store = { inserts: [], likes: [] }
    stubTable([{ slug: "rls-in-anger" }, { slug: "rls-in-anger-copy" }], store)
    const outcome = await duplicateRecord(testClient({ url: URL_BASE }), MODEL, { id: "t1", title: "RLS in anger", slug: "rls-in-anger" })
    expect(outcome).toEqual({ kind: "created", id: "copy-id" })
    expect(store.inserts.map((r) => r["slug"])).toEqual(["rls-in-anger", "rls-in-anger-copy-2"])
  })

  it("opens the create form with any other collided unique field cleared and marked", async () => {
    const store: Store = { inserts: [], likes: [] }
    stubTable([{ code: "T-1" }], store)
    const outcome = await duplicateRecord(testClient({ url: URL_BASE }), MODEL, { id: "t1", title: "A", code: "T-1" })
    expect(outcome).toEqual({
      kind: "needsInput",
      draft: { values: { title: "A" }, fieldErrors: { code: "Code must be unique. Enter a new value for the copy." } },
    })
  })

  it("passes any other refusal through as it came", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ code: "42501", message: "permission denied" }, { status: 403 }))
    const outcome = await duplicateRecord(testClient({ url: URL_BASE }), MODEL, { id: "t1", title: "A" })
    expect(outcome).toEqual({ kind: "failed", message: "permission denied" })
  })
})

describe("the pieces", () => {
  it("reads the columns of a unique violation, quoted or not", () => {
    expect(uniqueViolationColumns({ message: "", code: "23505", details: 'Key (slug)=(a) already exists.' })).toEqual(["slug"])
    expect(uniqueViolationColumns({ message: "", code: "23505", details: 'Key ("contactPhone", org)=(1, 2) already exists.' })).toEqual(["contactPhone", "org"])
    expect(uniqueViolationColumns({ message: "", code: "23503", details: "Key (a)=(b) is not present." })).toEqual([])
  })

  it("picks the first -copy value nobody has", () => {
    expect(nextFreeCopy("a", new Set())).toBe("a-copy")
    expect(nextFreeCopy("a", new Set(["a-copy", "a-copy-2"]))).toBe("a-copy-3")
  })
})
