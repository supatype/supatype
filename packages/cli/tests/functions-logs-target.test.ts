import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runCommand, tempProject } from "./support/command-run.js"
import { registerFunctions } from "../src/commands/functions.js"

/**
 * `functions logs` on a project linked to a self-hosted server. It asked Supatype Cloud
 * (api.supatype.com) whatever the link named, and read once, so a self-host user saw a login
 * error or nothing. It tails the linked server's relay of the worker's log stream instead.
 */
let project: { dir: string; remove: () => void }
let requests: { url: string; auth: string | null; signal: AbortSignal | undefined }[] = []

const event = (fn: string, message: string): string =>
  `data: ${JSON.stringify({ timestamp: "2026-10-30T12:00:01.000Z", level: "info", service: "functions-worker", project_ref: "acme", function: fn, message })}\n\n`

beforeEach(() => {
  project = tempProject("functions-logs")
  writeFileSync(
    join(project.dir, "supatype.config.ts"),
    `export default { project: { name: "acme" }, database: { provider: "docker" }, server: { mode: "dev" }, app: { mode: "none" } }\n`,
  )
  mkdirSync(join(project.dir, ".supatype"), { recursive: true })
  writeFileSync(join(project.dir, ".supatype", "link.json"), JSON.stringify({
    version: 1,
    kind: "self-host",
    projectRef: "acme",
    defaultEnvironment: "production",
    environments: { production: { name: "production", apiUrl: "https://sh.example.test", token: "svc-key", linkedAt: "2026-01-01T00:00:00Z" } },
  }))
  requests = []
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    requests.push({ url: String(url), auth: new Headers(init?.headers).get("Authorization"), signal: init?.signal ?? undefined })
    const body = "retry: 2000\n\n" + event("hello", "first") + event("other", "not this one") + event("hello", "second")
    return Promise.resolve(new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }))
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  project.remove()
})

describe("functions logs on a self-host link", () => {
  it("tails the linked server with its service-role key, showing only that function", async () => {
    const run = await runCommand(registerFunctions, ["functions", "logs", "hello"], project.dir)
    expect(requests.map(({ url, auth }) => ({ url, auth }))).toEqual([{ url: "https://sh.example.test/admin/v1/functions/logs/tail", auth: "Bearer svc-key" }])
    // A tail runs until Ctrl+C: the limit is on the answer starting, and nothing cuts the body off.
    expect(requests[0]?.signal?.aborted).toBe(false)
    expect(run.output).toContain("first")
    expect(run.output).toContain("second")
    expect(run.output).not.toContain("not this one")
  })

  // Review of round 7, item C10: the tail's request had no time limit, so a server that never
  // answered left `functions logs` waiting forever, with nothing said.
  it("gives up when the server does not start answering, saying so", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    let asked = false
    vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
      asked = true
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))
      })
    })
    try {
      const running = runCommand(registerFunctions, ["functions", "logs", "hello"], project.dir)
      while (!asked) await new Promise((resolve) => setImmediate(resolve))
      await vi.advanceTimersByTimeAsync(10_000)
      const run = await running
      expect(run.exitCode).toBe(1)
      expect(run.output).toContain("Failed to tail logs: GET https://sh.example.test/admin/v1/functions/logs/tail did not answer within 10 s")
    } finally {
      vi.useRealTimers()
    }
  })
})

// Every functions command resolves the same linked target. invoke used to send a self-host-linked
// project to https://<ref>.supatype.dev with the Cloud token.
describe("functions invoke on a self-host link", () => {
  it("calls the linked server, never Supatype Cloud, and never sends the Cloud token", async () => {
    vi.stubEnv("SUPATYPE_ACCESS_TOKEN", "cloud-token")
    try {
      await runCommand(registerFunctions, ["functions", "invoke", "hello"], project.dir)
    } finally {
      vi.unstubAllEnvs()
    }
    expect(requests.map((r) => r.url)).toEqual(["https://sh.example.test/functions/v1/hello"])
    expect(requests.some((r) => r.url.includes("supatype.dev") || r.auth === "Bearer cloud-token")).toBe(false)
  })
})

// Review of round 5: with no token of its own for a self-hosted server, `invoke --auth` sent the
// placeholder JWT meant for local testing to that server.
describe("functions invoke --auth on a self-host link", () => {
  it("refuses, sending nothing, rather than send a placeholder token to the server", async () => {
    const run = await runCommand(registerFunctions, ["functions", "invoke", "hello", "--auth"], project.dir)
    expect(run.exitCode).toBe(1)
    expect(run.output).toContain("--auth")
    expect(requests).toEqual([])
  })
})

// Review of round 5: on targetFetch these commands had no timeout, and waited forever on a stalled
// target. They give up after 10 s again.
describe("a functions request to the linked target", () => {
  it("gives up after a while", async () => {
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      requests.push({ url: String(url), auth: null, signal: init?.signal ?? undefined })
      return Promise.resolve(new Response(JSON.stringify({ data: [] }), { headers: { "Content-Type": "application/json" } }))
    })
    await runCommand(registerFunctions, ["functions", "list"], project.dir)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.signal).toBeInstanceOf(AbortSignal)
  })
})

// Review of round 5: these routes restart the worker, which often takes longer than 10 s, so they
// were reported as failed while they succeeded.
describe("a functions request whose route restarts the worker", () => {
  function timeoutsAskedFor(argv: string[]): Promise<number[]> {
    const asked: number[] = []
    const real = AbortSignal.timeout.bind(AbortSignal)
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      asked.push(ms)
      return real(ms)
    })
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(JSON.stringify({ data: { key: "K", removed: true } }), {
      headers: { "Content-Type": "application/json" },
    })))
    return runCommand(registerFunctions, argv, project.dir).then(() => asked)
  }

  it("waits as long as a deploy for env set", async () => {
    expect(await timeoutsAskedFor(["functions", "env", "set", "K=v"])).toEqual([60_000])
  })

  it("waits as long as a deploy for env unset", async () => {
    expect(await timeoutsAskedFor(["functions", "env", "unset", "K"])).toEqual([60_000])
  })

  it("waits as long as a deploy for delete", async () => {
    expect(await timeoutsAskedFor(["functions", "delete", "hello"])).toEqual([60_000])
  })

  it("keeps the shorter limit for a list", async () => {
    expect(await timeoutsAskedFor(["functions", "list"])).toEqual([10_000])
  })
})

// Review of round 5: unset said "Removed" for a key the server said was never set.
describe("functions env unset of a key that was not set", () => {
  it("says it was not set", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(JSON.stringify({ data: { key: "NOPE", removed: false } }), {
      headers: { "Content-Type": "application/json" },
    })))
    const run = await runCommand(registerFunctions, ["functions", "env", "unset", "NOPE"], project.dir)
    expect(run.output).toContain("NOPE was not set")
    expect(run.output).not.toContain("Removed NOPE")
  })
})

// A link of kind "local" is this machine's own server: --auth sends the key the link holds, as a
// Cloud link sends its session. Review of round 7: it sent a placeholder test JWT, signed by nothing.
describe("functions invoke --auth on a local link", () => {
  it("sends the key the link holds", async () => {
    writeFileSync(join(project.dir, ".supatype", "link.json"), JSON.stringify({
      version: 1,
      kind: "local",
      projectRef: "acme",
      defaultEnvironment: "local",
      environments: { local: { name: "local", apiUrl: "http://localhost:18471", token: "svc-key", linkedAt: "2026-01-01T00:00:00Z" } },
    }))
    const run = await runCommand(registerFunctions, ["functions", "invoke", "hello", "--auth"], project.dir)
    expect(run.exitCode).toBeUndefined()
    expect(requests.map((r) => r.url)).toEqual(["http://localhost:18471/functions/v1/hello"])
    expect(requests[0]?.auth).toBe("Bearer svc-key")
  })
})

// Local test round 6: one Ctrl+C ended the tail, but by killing the process (0xC000013A on Windows),
// with nothing listening for it. It stops the stream and the command ends by itself.
describe("Ctrl+C during functions logs on a self-host link", () => {
  it("closes the stream and ends the command", async () => {
    let cancelled = false
    vi.stubGlobal("fetch", () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(event("hello", "first")))
        },
        cancel() {
          cancelled = true
        },
      })
      return Promise.resolve(new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }))
    })
    // Ctrl+C once the command listens for it: the tail starts after the link and config are read.
    const stop = setInterval(() => {
      if (process.listenerCount("SIGINT") === 0) return
      clearInterval(stop)
      process.emit("SIGINT")
    }, 20)
    const run = await runCommand(registerFunctions, ["functions", "logs", "hello"], project.dir)
    clearInterval(stop)
    expect(run.output).toContain("first")
    expect(run.exitCode).toBeUndefined()
    expect(cancelled).toBe(true)
    expect(process.listenerCount("SIGINT")).toBe(0)
  }, 15000)
})
