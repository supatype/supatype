import { afterEach, describe, expect, it, vi } from "vitest"
import { functionsAdminFetch } from "../src/lib/functions-admin.js"
import { testClient } from "./support.js"

/**
 * Studio's function administration (the list, logs and env of each function) goes to the admin
 * API's own address, /admin/v1/functions. It used to call /functions/v1/admin, where the admin API
 * sat over the whole prefix and made a project function named "admin" impossible to call.
 */
afterEach(() => {
  vi.unstubAllGlobals()
})

describe("functionsAdminFetch", () => {
  it("calls the functions admin API under /admin/v1/functions, as the signed-in user", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"))
    vi.stubGlobal("fetch", fetchMock)
    const client = testClient({ url: "http://localhost:18473/studio/proxy", token: "user-token" })

    await functionsAdminFetch(client, "/hello/env", { method: "POST" })

    expect(fetchMock).toHaveBeenCalledWith("http://localhost:18473/studio/proxy/admin/v1/functions/hello/env", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer user-token", apikey: "user-token" },
    })
  })
})
