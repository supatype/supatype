/**
 * What `useMutation` and `useQuery` send for a table named at run time.
 *
 * Both reach the table through the untyped client, because the generated row types do not survive
 * a dynamic table name. These pin the requests that come out, so typing that path cannot quietly
 * change a method, a filter or a body.
 */

import React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, create } from "react-test-renderer"
import { createClient, type AnyDatabase } from "@supatype/client"
import { SupatypeProvider } from "../src/context.js"
import { useMutation, type MutationOperation, type UseMutationResult } from "../src/useMutation.js"
import { useQuery, type UseQueryOptions } from "../src/useQuery.js"

interface SentRequest {
  method: string
  path: string
  body: unknown
  profile: string | null
  range: string | null
}

function stubFetch(): SentRequest[] {
  const sent: SentRequest[] = []
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    const headers = new Headers(init?.headers)
    sent.push({
      method: init?.method ?? "GET",
      path: decodeURIComponent(url.pathname + url.search),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body ?? null,
      profile: headers.get("Accept-Profile"),
      range: headers.get("Range"),
    })
    return new Response(JSON.stringify([{ id: 1 }]), { status: 200, headers: { "Content-Type": "application/json" } })
  }))
  return sent
}

function client(): ReturnType<typeof createClient<AnyDatabase>> {
  return createClient<AnyDatabase>({ url: "http://localhost:9999", anonKey: "anon" })
}

async function mutateOnce(
  operation: MutationOperation,
  ...args: Parameters<UseMutationResult<unknown>["mutate"]>
): Promise<Awaited<ReturnType<UseMutationResult<unknown>["mutate"]>>> {
  const probe: { mutation: UseMutationResult<unknown> | null } = { mutation: null }
  function Probe(): null {
    probe.mutation = useMutation<AnyDatabase>("posts", operation)
    return null
  }
  await act(async () => {
    create(<SupatypeProvider client={client()}><Probe /></SupatypeProvider>)
  })
  let result: Awaited<ReturnType<UseMutationResult<unknown>["mutate"]>> | null = null
  await act(async () => {
    result = await probe.mutation!.mutate(...args)
  })
  return result!
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("useMutation requests", () => {
  it("inserts the rows it is given and returns what the server answered", async () => {
    const sent = stubFetch()
    const result = await mutateOnce("insert", [{ title: "a" }, { title: "b" }])
    expect(sent).toEqual([{ method: "POST", path: "/rest/v1/posts", body: [{ title: "a" }, { title: "b" }], profile: null, range: null }])
    expect(result.data).toEqual([{ id: 1 }])
    expect(result.error).toBeNull()
  })

  it("upserts with the merge preference", async () => {
    const sent = stubFetch()
    await mutateOnce("upsert", { id: 1, title: "a" })
    expect(sent).toEqual([{ method: "POST", path: "/rest/v1/posts", body: { id: 1, title: "a" }, profile: null, range: null }])
  })

  it("updates only the rows the filter names", async () => {
    const sent = stubFetch()
    await mutateOnce("update", { title: "b" }, { filter: { id: 7, status: "draft" } })
    expect(sent).toEqual([
      { method: "PATCH", path: "/rest/v1/posts?id=eq.7&status=eq.draft", body: { title: "b" }, profile: null, range: null },
    ])
  })

  it("deletes only the rows the filter names, with no body", async () => {
    const sent = stubFetch()
    await mutateOnce("delete", undefined, { filter: { id: 7 } })
    expect(sent).toEqual([{ method: "DELETE", path: "/rest/v1/posts?id=eq.7", body: null, profile: null, range: null }])
  })

  // Each used to go out as a request the server could only refuse: a POST or PATCH with no body,
  // or a PATCH whose body was a list.
  const refusals: Array<[string, MutationOperation, Parameters<UseMutationResult<unknown>["mutate"]>[0], string]> = [
    ["an insert with nothing to write", "insert", undefined, "insert needs the row or rows to write"],
    ["an upsert with nothing to write", "upsert", undefined, "upsert needs the row or rows to write"],
    ["an update with no changes", "update", undefined, "update needs one object of the changes to make"],
    ["an update given a list", "update", [{ title: "a" }], "update needs one object of the changes to make"],
  ]
  it.each(refusals)("refuses %s without a request", async (_label, operation, data, message) => {
    const sent = stubFetch()
    const result = await mutateOnce(operation, data)
    expect(sent).toEqual([])
    expect(result).toEqual({ data: null, error: { message }, count: null })
  })
})

describe("useQuery requests", () => {
  async function queryOnce(options: UseQueryOptions): Promise<SentRequest[]> {
    const sent = stubFetch()
    function Probe(): null {
      useQuery<AnyDatabase>("posts", options)
      return null
    }
    await act(async () => {
      create(<SupatypeProvider client={client()}><Probe /></SupatypeProvider>)
    })
    return sent
  }

  it("applies every option to one GET", async () => {
    const sent = await queryOnce({
      select: "id,title",
      filter: { status: "published" },
      order: { column: "created_at", ascending: false },
      limit: 10,
      offset: 20,
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.method).toBe("GET")
    expect(sent[0]!.path).toBe(
      "/rest/v1/posts?select=id,title&status=eq.published&order=created_at.desc.nullslast&limit=10",
    )
    expect(sent[0]!.profile).toBeNull()
    expect(sent[0]!.range).toBe("20-29")
  })

  it("reads the draft schema when asked", async () => {
    const sent = await queryOnce({ draft: true })
    expect(sent[0]!.path).toBe("/rest/v1/posts?select=*")
    expect(sent[0]!.profile).toBe("draft")
  })
})
