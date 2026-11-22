import { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CloudCredentials } from "../src/cloud-credentials.js"

/**
 * `supatype whoami` after the session was revoked used to print the stored email and exit 0, as if
 * signed in. It now asks the control plane, and a 401 is exit 1.
 */

const credentials: CloudCredentials = {
  version: 1,
  apiUrl: "https://api.example.test",
  accessToken: "access-1",
  refreshToken: "refresh-1",
  email: "dev@example.test",
  updatedAt: "2026-11-21T00:00:00.000Z",
}

const persisted = vi.fn()
vi.mock("../src/cloud-credentials.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/cloud-credentials.js")>()),
  loadCloudCredentials: () => credentials,
  persistCloudSession: (cwd: string, params: unknown) => persisted(cwd, params),
}))
vi.mock("../src/link.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/link.js")>()),
  loadProjectLink: () => null,
}))

const lines: string[] = []
vi.mock("../src/ui/messages.js", () => ({
  info: (line: string) => lines.push(line),
  plain: (line?: string) => lines.push(line ?? ""),
  error: (line: string) => lines.push(`error: ${line}`),
}))

const { registerLogin } = await import("../src/commands/login.js")

/** Control-plane answers by path: `me` for GET /auth/me, `refresh` for POST /auth/refresh. */
function controlPlane(answers: { me: Response | Error; refresh?: Response }): () => string[] {
  const seen: string[] = []
  vi.stubGlobal("fetch", async (url: string) => {
    seen.push(url)
    const answer = url.endsWith("/auth/me") ? answers.me : answers.refresh
    if (answer === undefined) throw new Error(`unexpected request ${url}`)
    if (answer instanceof Error) throw answer
    return answer
  })
  return () => seen
}

async function whoami(): Promise<number | null> {
  const program = new Command().exitOverride()
  registerLogin(program)
  let exitCode: number | null = null
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCode = code ?? 0
    throw new Error("exit")
  }) as typeof process.exit)
  await program.parseAsync(["node", "supatype", "whoami"]).catch((err: unknown) => {
    if (!(err instanceof Error) || err.message !== "exit") throw err
  })
  return exitCode
}

beforeEach(() => {
  lines.length = 0
  persisted.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("supatype whoami", () => {
  it("exits 1 when the control plane rejects the session and its refresh token", async () => {
    controlPlane({ me: new Response("{}", { status: 401 }), refresh: new Response("{}", { status: 401 }) })
    expect(await whoami()).toBe(1)
    expect(lines.join("\n")).toContain("rejected by https://api.example.test")
    expect(lines.join("\n")).toContain("supatype login")
  })

  it("exits 0 and says the session is valid when the control plane accepts it", async () => {
    const seen = controlPlane({ me: new Response("{}", { status: 200 }) })
    expect(await whoami()).toBeNull()
    expect(seen()).toEqual(["https://api.example.test/auth/me"])
    expect(lines).toContain("Session: valid")
  })

  it("renews an expired access token with the refresh token and stores the new one", async () => {
    controlPlane({
      me: new Response("{}", { status: 401 }),
      refresh: Response.json({ access_token: "access-2", refresh_token: "refresh-2" }),
    })
    expect(await whoami()).toBeNull()
    expect(lines).toContain("Session: valid")
    expect(persisted).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ accessToken: "access-2", refreshToken: "refresh-2" }))
  })

  it("exits 2 naming the address and the error when the control plane could not be reached", async () => {
    controlPlane({ me: new Error("connect ECONNREFUSED") })
    expect(await whoami()).toBe(2)
    expect(lines.join("\n")).toContain("Session: not checked")
    expect(lines.join("\n")).toContain("https://api.example.test")
    expect(lines.join("\n")).toContain("ECONNREFUSED")
  })
})
