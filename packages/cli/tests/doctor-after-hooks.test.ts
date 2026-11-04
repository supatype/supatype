import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { linkPath } from "../src/link.js"
import { projectConfig } from "./support/project-config.js"
import type { HooksReport } from "../src/model-hooks.js"
import { afterHooksSourceCheck } from "../src/db-preflight.js"

// `doctor` reaches this section only after talking to the engine, so the printing is exercised here.
const lines: string[] = []
vi.mock("../src/ui/messages.js", () => ({
  plain: (line?: string) => lines.push(line ?? ""),
  info: () => {},
  error: () => {},
}))

const { declaresAfterHook, printAfterHooksSource, probeAfterHooksSource } = await import("../src/commands/doctor.js")

beforeEach(() => {
  lines.length = 0
})

function report(events: string[]): HooksReport {
  return {
    declared: events.map((event) => ({ model: "Post", event, function: "fn" })),
    missing: [],
    functionsDisabled: false,
    mapMissing: false,
    validators: [],
    validatorsMissing: [],
    validatorMapMissing: false,
  }
}

const check = { id: "wal-level", title: "wal_level = logical", severity: "pass" as const, detail: 'wal_level is "logical"' }

describe("doctor: where after-hooks read writes from", () => {
  it("probes the database only when an after-hook is declared", () => {
    expect(declaresAfterHook(report(["beforeChange", "beforeDelete"]))).toBe(false)
    expect(declaresAfterHook(report(["beforeChange", "afterDelete"]))).toBe(true)
  })

  it("says the change log when the database can decode", () => {
    printAfterHooksSource({ checked: true, source: afterHooksSourceCheck([check]) })
    expect(lines.join("\n")).toContain("change log")
  })

  it("says the request path, why, and what it misses, as db check words it", () => {
    const blocked = { ...check, severity: "degrade" as const, detail: 'wal_level is "replica", not logical' }
    printAfterHooksSource({ checked: true, source: afterHooksSourceCheck([blocked]) })
    const out = lines.join("\n")
    expect(out).toContain("request path")
    expect(out).toContain('wal_level is "replica"')
    expect(out).toContain("outside the API")
    expect(out).toContain("supatype db check")
  })

  it("prints the running server's own answer when it gave one", () => {
    printAfterHooksSource({ checked: true, health: { path: "request", slot: "supatype_hooks", reason: "no REPLICATION" } })
    const out = lines.join("\n")
    expect(out).toContain("request path, because no REPLICATION")
    expect(out).toContain("outside the API")
  })

  it("reports a link file it cannot read as why it could not tell, rather than rejecting", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "supatype-doctor-link-"))
    try {
      mkdirSync(dirname(linkPath(cwd)), { recursive: true })
      writeFileSync(linkPath(cwd), "{ not json")
      const outcome = await probeAfterHooksSource(cwd, projectConfig(), undefined)
      expect(outcome.checked).toBe(false)
      expect("reason" in outcome && outcome.reason).toMatch(/JSON/)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("says why it could not tell, rather than guessing", () => {
    printAfterHooksSource({ checked: false, reason: "no database" })
    const out = lines.join("\n")
    expect(out).toContain("no database")
    expect(out).not.toContain("change log")
  })
})
