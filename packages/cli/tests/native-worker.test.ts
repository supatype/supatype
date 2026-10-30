import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { projectConfig } from "./support/project-config.js"

vi.mock("../src/ensure-binary.js", () => ({ ensureBinary: async () => "/cache/deno/2.2.0/deno" }))
vi.mock("../src/binary-cache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/binary-cache.js")>()),
  resolveVersionFor: async () => "2.2.0",
}))

const { prepareNativeWorker } = await import("../src/native-worker.js")

/**
 * Local test round 3d (N19): native dev started no functions worker in a project with no functions/
 * and no hooks/, and the server's environment is fixed at spawn, so the first hook declared while
 * dev ran answered 503 and the first function 404 until dev was restarted. The worker is set up on
 * every start, with or without a route yet.
 */
let cwd = ""
const logs: string[] = []

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "supatype-native-worker-"))
  logs.length = 0
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void logs.push(args.join(" ")))
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(cwd, { recursive: true, force: true })
})

describe("native dev's functions worker", () => {
  it("is set up in a project with no functions and no hooks yet, on the directories it would have", async () => {
    const worker = await prepareNativeWorker(cwd, projectConfig({ provider: "native" }))
    expect(worker).toMatchObject({ functionsDir: join(cwd, "functions"), hooksDir: join(cwd, "hooks"), routes: [], denoBin: "/cache/deno/2.2.0/deno" })
    expect(existsSync(worker.entry)).toBe(true)
    expect(readFileSync(worker.entry, "utf8")).toContain(`import "file:///`)
    expect(logs.join("\n")).toContain("no functions or hooks yet; one added while dev runs is served")
  })

  it("names the routes it found", async () => {
    mkdirSync(join(cwd, "hooks", "audit"), { recursive: true })
    writeFileSync(join(cwd, "hooks", "audit", "index.ts"), "export default () => new Response('ok')\n")
    const worker = await prepareNativeWorker(cwd, projectConfig({ provider: "native" }))
    expect(worker.routes).toEqual(["hooks/audit"])
    expect(readFileSync(worker.entry, "utf8")).toContain("// Routes: hooks/audit")
  })
})
