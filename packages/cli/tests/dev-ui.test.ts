import { describe, expect, it, vi, beforeEach, afterEach, afterAll } from "vitest"
import { mkdtempSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

vi.mock("ink", () => ({
  render: vi.fn(() => ({ unmount: vi.fn() })),
}))
import { DevLogBus } from "../src/dev-log-bus.js"
import { filterCommandLogLine, filterDevSubprocessLine, filterStackLogLine, formatConsoleArgs, stripAnsi } from "../src/dev-log-filter.js"
import { appendDevTaskLog, beginDevSession, endDevSession, getActiveDevSession, resolveDevUiMode, withDevSessionSuspended } from "../src/dev-session.js"
import {
  layoutLogoBlock,
  logoRowCount,
  pickLogoLines,
  SUPATYPE_ASCII_LOGO_WORDMARK,
} from "../src/dev-logo.js"
import { normalizeStackLogLine, taskColor } from "../src/dev-task-colors.js"
import { recordExit } from "./support/process-exit.js"

describe("filterDevSubprocessLine()", () => {
  it("filters npm script banners and vite network URLs for app", () => {
    expect(filterDevSubprocessLine("app", "> vite")).toBe(false)
    expect(filterDevSubprocessLine("app", "  ➜  Network: http://10.0.0.1:5173/")).toBe(false)
    expect(filterDevSubprocessLine("app", "  ➜  Local:   http://localhost:5173/")).toBe(true)
  })

  it("does not filter stack logs", () => {
    expect(filterDevSubprocessLine("stack", "> vite")).toBe(true)
  })
})

describe("filterStackLogLine()", () => {
  it("drops docker build progress but keeps supatype messages", () => {
    expect(filterStackLogLine("#1 [internal] load build definition from Dockerfile")).toBe(false)
    expect(filterStackLogLine(" Container supatype-demo-db-1 Running")).toBe(false)
    expect(filterStackLogLine("[supatype] Waiting for Postgres (compose)...")).toBe(true)
    expect(filterStackLogLine("Services running.")).toBe(true)
    expect(filterStackLogLine("  API (Kong)       http://localhost:18473")).toBe(true)
  })

  it("keeps override banner lines", () => {
    expect(filterStackLogLine("  engine       → ../supatype-schema-engine/bin/engine")).toBe(true)
  })
})

describe("filterCommandLogLine()", () => {
  it("keeps diff output but drops docker container progress", () => {
    expect(filterCommandLogLine("  [+] add_column users.email")).toBe(true)
    expect(filterCommandLogLine(" Container supatype-demo-db-1 Running")).toBe(false)
    expect(filterCommandLogLine("[supatype] Schema pushed.")).toBe(true)
  })
})

describe("stripAnsi()", () => {
  it("removes colour codes", () => {
    expect(stripAnsi("\x1b[33mhello\x1b[0m")).toBe("hello")
  })
})

describe("formatConsoleArgs()", () => {
  it("joins mixed arguments", () => {
    expect(formatConsoleArgs(["a", 1])).toBe("a 1")
  })
})

describe("DevLogBus", () => {
  it("marks non-focused tasks unread", () => {
    const bus = new DevLogBus()
    bus.registerTask("app", "app")
    bus.setFocusedTaskId("stack")
    bus.append("app", "ready")
    expect(bus.getTask("app")?.unread).toBe(true)
    bus.setFocusedTaskId("app")
    expect(bus.getTask("app")?.unread).toBe(false)
  })

  it("splits multiline append into separate rows", () => {
    const bus = new DevLogBus()
    bus.append("stack", "line one\nline two")
    expect(bus.getTask("stack")?.lines).toEqual(["line one", "line two"])
  })

  it("strips [supatype] prefix on stack task", () => {
    const bus = new DevLogBus()
    bus.append("stack", "[supatype] hello")
    expect(bus.getTask("stack")?.lines).toEqual(["hello"])
  })
})

describe("resolveDevUiMode()", () => {
  it("honours --stream", () => {
    expect(resolveDevUiMode(true)).toBe("stream")
  })
})

describe("appendDevTaskLog()", () => {
  afterEach(() => {
    endDevSession()
  })

  it("routes proxy bootstrap lines to the app task in TUI mode", () => {
    const session = beginDevSession("tui")
    appendDevTaskLog("app", "app", "Proxy mode: running npm run vite (/tmp/app)")
    expect(session.bus.getTask("app")?.lines).toEqual(["Proxy mode: running npm run vite (/tmp/app)"])
    expect(session.bus.getTask("stack")?.lines ?? []).toEqual([])
  })

  it("captures console.log to the bus before ink mounts", () => {
    beginDevSession("tui")
    console.log("[supatype] bootstrap line")
    expect(getActiveDevSession()?.bus.getTask("stack")?.lines).toEqual(["bootstrap line"])
    expect(getActiveDevSession()?.isInkMounted()).toBe(true)
  })

  it("withDevSessionSuspended is a no-op during bootstrap", async () => {
    beginDevSession("tui")
    await withDevSessionSuspended(async () => "ok")
    expect(getActiveDevSession()?.isConsoleCaptured()).toBe(true)
    expect(getActiveDevSession()?.isInkMounted()).toBe(true)
  })
})

describe("dev-logo", () => {
  it("preserves authored line spacing including trailing spaces", () => {
    const out = layoutLogoBlock(["  aa", "    bbbb ", ""])
    expect(out[0]).toBe("  aa")
    expect(out[1]).toBe("    bbbb ")
  })

  it("loads the figlet slant wordmark", () => {
    expect(pickLogoLines()).toEqual([...SUPATYPE_ASCII_LOGO_WORDMARK])
    expect(logoRowCount()).toBe(6)
    expect(SUPATYPE_ASCII_LOGO_WORDMARK[1]).toContain("_______")
  })
})

describe("dev-task-colors", () => {
  it("assigns purple to stack and green to app", () => {
    expect(taskColor("stack")).toBe("\x1b[35m")
    expect(taskColor("app")).toBe("\x1b[32m")
  })

  it("strips stack log prefix", () => {
    expect(normalizeStackLogLine("[supatype] Waiting for Postgres")).toBe("Waiting for Postgres")
  })
})

describe("dev-shutdown", () => {
  // Shutdown exits from async work, so the stand-in records the code and returns.
  const { exit: exitSpy, restore: restoreExit } = recordExit()
  afterAll(restoreExit)
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

  beforeEach(() => {
    exitSpy.mockClear()
    stderrSpy.mockClear()
  })

  afterEach(() => {
    vi.resetModules()
  })

  it("exits 0 after registered work completes", async () => {
    vi.resetModules()
    const { registerDevShutdown, requestDevShutdown } = await import("../src/dev-shutdown.js")
    let ran = false
    registerDevShutdown(async () => {
      ran = true
    })
    requestDevShutdown()
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0))
    expect(ran).toBe(true)
  })

  /** What the shutdown wrote to stderr, as one string. */
  const said = (): string => stderrSpy.mock.calls.map((call) => String(call[0])).join("")

  /** A compose stack's shutdown fallback, as Docker dev registers it. */
  function composeStack(): { cwd: string; compose: { cwd: string; composePath: string; composeProject: string } } {
    const dir = mkdtempSync(join(tmpdir(), "supatype-shutdown-"))
    const composePath = join(dir, "docker-compose.yml")
    writeFileSync(composePath, "services: {}\n", "utf8")
    return { cwd: dir, compose: { cwd: dir, composePath, composeProject: "supatype-test" } }
  }

  it("warns on second interrupt then force-exits on third, where there are Docker containers", async () => {
    vi.resetModules()
    const { registerDevShutdown, requestDevShutdown } = await import("../src/dev-shutdown.js")
    registerDevShutdown(async () => {
      await new Promise(() => undefined)
    }, composeStack())
    requestDevShutdown()
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledTimes(0))
    requestDevShutdown()
    expect(said()).toContain("press Ctrl+C again to force quit")
    expect(exitSpy).toHaveBeenCalledTimes(0)
    requestDevShutdown()
    expect(exitSpy).toHaveBeenCalledWith(130)
    expect(said()).toContain("Forced quit: Docker containers may still be running.")
  })

  // Round 6b, C10: native dev starts no Docker containers unless it runs a Valkey sidecar, so a
  // second Ctrl+C only printed a notice naming Docker, and only a third one ended it.
  it("force-exits on the second interrupt where no container was started, naming no Docker", async () => {
    vi.resetModules()
    const { registerDevShutdown, requestDevShutdown } = await import("../src/dev-shutdown.js")
    registerDevShutdown(async () => {
      await new Promise(() => undefined)
    })
    requestDevShutdown()
    requestDevShutdown()
    expect(exitSpy).toHaveBeenCalledWith(130)
    expect(said()).toContain("Forced quit.")
    expect(said()).not.toMatch(/Docker/)
  })

  it("keeps three presses for a native dev with a container, and names that container", async () => {
    vi.resetModules()
    const { pushStartUndo, registerDevShutdown, requestDevShutdown } = await import("../src/dev-shutdown.js")
    pushStartUndo(() => new Promise(() => undefined), { container: "the Valkey sidecar container" })
    registerDevShutdown(async () => undefined)
    requestDevShutdown()
    requestDevShutdown()
    expect(exitSpy).toHaveBeenCalledTimes(0)
    expect(said()).not.toMatch(/Docker/)
    requestDevShutdown()
    expect(exitSpy).toHaveBeenCalledWith(130)
    expect(said()).toContain("Forced quit: the Valkey sidecar container may still be running.")
  })

  it("says a failed native shutdown without naming Docker", async () => {
    vi.resetModules()
    const { registerDevShutdown, requestDevShutdown } = await import("../src/dev-shutdown.js")
    registerDevShutdown(async () => {
      throw new Error("server would not stop")
    })
    requestDevShutdown()
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1))
    expect(said()).toContain("Shutdown failed: server would not stop")
    expect(said()).not.toMatch(/Docker/)
  })

  // Round 6b, C10: Postgres's stop waited for the Valkey sidecar's `docker rm -f`, about 1 s on
  // Docker Desktop, though nothing in Postgres needs the container gone first.
  it("stops Postgres once the services have stopped, without waiting for a container", async () => {
    vi.resetModules()
    const { drainStartUndo, pushStartUndo, pushStartUndoLast } = await import("../src/dev-shutdown.js")
    let postgresStopped = false
    pushStartUndo(() => new Promise(() => undefined), { container: "the Valkey sidecar container" })
    pushStartUndo(() => undefined)
    pushStartUndoLast(() => {
      postgresStopped = true
    })
    void drainStartUndo()
    await vi.waitFor(() => expect(postgresStopped).toBe(true))
  })

  it("says how long each part of the shutdown took under SUPATYPE_DEBUG=1, and nothing without it", async () => {
    vi.resetModules()
    const { drainStartUndo, pushStartUndo, pushStartUndoLast } = await import("../src/dev-shutdown.js")
    pushStartUndo(() => undefined)
    pushStartUndoLast(() => undefined)
    await drainStartUndo()
    expect(said()).not.toContain("shutdown:")
    vi.stubEnv("SUPATYPE_DEBUG", "1")
    pushStartUndo(() => undefined)
    pushStartUndo(() => undefined, { container: "a container" })
    await drainStartUndo()
    vi.unstubAllEnvs()
    expect(said()).toMatch(/shutdown: services took \d+ ms/)
    expect(said()).toMatch(/shutdown: Postgres and what else the services use took \d+ ms/)
    expect(said()).toMatch(/shutdown: containers took \d+ ms/)
  })

  it("registers compose fallback for sync exit cleanup", async () => {
    vi.resetModules()
    const { registerDevShutdown, hasComposeShutdownFallback, resetDevShutdownForTests } =
      await import("../src/dev-shutdown.js")
    resetDevShutdownForTests()
    const dir = mkdtempSync(join(tmpdir(), "supatype-shutdown-"))
    const composePath = join(dir, "docker-compose.yml")
    writeFileSync(composePath, "services: {}\n", "utf8")
    registerDevShutdown(async () => undefined, {
      cwd: dir,
      compose: { cwd: dir, composePath, composeProject: "supatype-test" },
    })
    expect(hasComposeShutdownFallback()).toBe(true)
  })
})
