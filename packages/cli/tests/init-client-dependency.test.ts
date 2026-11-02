import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { isJsonObject } from "@supatype/shared"
import { defaultScaffoldOptions, scaffold } from "../src/commands/init.js"
import { resolveInitDependencyVersions } from "../src/init-dependency-versions.js"
import { mergeSupatypePackageJson } from "../src/init-package-json.js"

/**
 * The generated `supatype/generated/client.ts` imports `@supatype/client`, at runtime, and init
 * never added it, so a fresh project's first import of its own client failed to resolve.
 */

const dirs: string[] = []
afterEach(() => {
  vi.unstubAllGlobals()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const DEPS = { cli: "0.7.0", types: "0.7.0", client: "0.7.0" }

function section(pkg: unknown, key: string): Record<string, unknown> {
  const value = isJsonObject(pkg) ? pkg[key] : undefined
  return isJsonObject(value) ? value : {}
}

describe("init's @supatype/client dependency", () => {
  it("is a runtime dependency of a new project, pinned like the other packages", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-init-client-"))
    dirs.push(dir)
    scaffold(dir, defaultScaffoldOptions("client-app"), DEPS)
    const pkg: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
    expect(section(pkg, "dependencies")["@supatype/client"]).toBe("^0.7.0")
    expect(section(pkg, "devDependencies")["@supatype/types"]).toBe("^0.7.0")
  })

  it("is added to an existing package.json", () => {
    const merged = mergeSupatypePackageJson(
      { name: "existing" },
      { projectName: "existing", app: { mode: "none" }, helloFunction: false },
      DEPS,
    )
    expect(merged.dependencies?.["@supatype/client"]).toBe("^0.7.0")
  })

  it("is resolved against the registry like cli and types", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const versions = url.includes("client") ? { "0.6.0": {} } : { "0.7.0": {} }
        const latest = url.includes("client") ? "0.6.0" : "0.7.0"
        return Response.json({ versions, "dist-tags": { latest } })
      }),
    )
    expect((await resolveInitDependencyVersions()).client).toBe("0.6.0")
  })
})
