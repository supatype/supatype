import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import { describe, expect, it } from "vitest"

const CLI = join(import.meta.dirname, "../bin/supatype.js")

function runIn(dir: string, args: string[]): { out: string; code: number } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: dir,
    encoding: "utf8",
    timeout: 60_000,
  })
  if (r.signal) throw new Error(`CLI killed by ${r.signal}, usually machine contention`)
  return { out: `${r.stdout ?? ""}${r.stderr ?? ""}`, code: r.status ?? 1 }
}

describe("a config that cannot be read", () => {
  // A broken config used to be indistinguishable from no config: the call sites that catch
  // loadConfig so the CLI works outside a project swallowed both. That is why a standalone
  // binary which could read no config at all still looked like it was working, for a whole
  // release.
  it("is reported, rather than treated as absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-broken-config-"))
    writeFileSync(
      join(dir, "supatype.config.ts"),
      'throw new Error("deliberately broken")\n',
      "utf8",
    )
    const { out, code } = runIn(dir, ["db", "check"])
    expect(out).toContain("Failed to load supatype.config.ts")
    expect(out).not.toContain("No connection. Pass --connection")
    expect(code).not.toBe(0)
  })

  it("does not stop the CLI working with no config at all", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-no-config-"))
    mkdirSync(join(dir, "empty"), { recursive: true })
    const { out } = runIn(join(dir, "empty"), ["db", "check"])
    expect(out).toContain("No connection. Pass --connection")
    expect(out).not.toContain("Failed to load")
  })
})
