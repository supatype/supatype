import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("../src/target-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/target-client.js")>()),
  targetFetch: async () => {
    throw new Error("Route not found")
  },
}))

const { uploadHooks } = await import("../src/commands/push.js")

/**
 * Local test round 4 (N23): a push to a project linked to self-host applied its schema, then ended
 * with `Deploying 2 hook(s)...` and `Route not found`, which said neither that the schema had gone
 * in nor what had failed.
 */
afterEach(() => vi.restoreAllMocks())

describe("a hook upload the target refuses", () => {
  it("says the schema was applied and the hooks were not, naming the target and its answer", async () => {
    const said: string[] = []
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void said.push(args.join(" ")))
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void said.push(args.join(" ")))
    vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new Error(`exit ${String(code)}`)
    })
    const target = { mode: "self-host", environment: "production", projectRef: "demo", apiBaseUrl: "https://stack.example.test", apiPrefix: "/platform/v1", token: "key", link: null } as const

    await expect(uploadHooks(target, { handlers: [], map: {} }, 2)).rejects.toThrow("exit 1")

    const text = said.join("\n")
    expect(text).toContain("The schema was applied, but its 2 hook(s) were not deployed to https://stack.example.test")
    expect(text).toContain("Route not found")
  })
})
