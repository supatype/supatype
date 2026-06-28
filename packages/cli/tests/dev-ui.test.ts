import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
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
  const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit)
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

  it("warns on second interrupt then force-exits on third", async () => {
    vi.resetModules()
    const { registerDevShutdown, requestDevShutdown } = await import("../src/dev-shutdown.js")
    registerDevShutdown(async () => {
      await new Promise(() => undefined)
    })
    requestDevShutdown()
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledTimes(0))
    requestDevShutdown()
    expect(stderrSpy).toHaveBeenCalled()
    expect(exitSpy).toHaveBeenCalledTimes(0)
    requestDevShutdown()
    expect(exitSpy).toHaveBeenCalledWith(130)
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
