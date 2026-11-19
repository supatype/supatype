import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { isJsonObject, isString } from "@supatype/shared"
import type { SupatypeProjectConfig } from "../src/project-config.js"
import { tempProject } from "./support/command-run.js"
import { parseJsonAs } from "./support/json.js"
import { projectConfig } from "./support/project-config.js"

/** `supatype build` gives the app's build the site's public values under every front-end prefix. */
let config: SupatypeProjectConfig = projectConfig()
vi.mock("../src/config.js", async (importOriginal) => ({ ...(await importOriginal<object>()), loadConfig: () => config }))

const { runFrontendBuild } = await import("../src/commands/build.js")

const PRINT_ENV = `import { writeFileSync } from "node:fs"
writeFileSync("env-out.json", JSON.stringify(process.env))
`
let project: { dir: string; remove: () => void }

beforeEach(() => {
  project = tempProject("build-command-public-env")
  writeFileSync(join(project.dir, "print-env.mjs"), PRINT_ENV)
  writeFileSync(join(project.dir, "package.json"), JSON.stringify({ name: "app", scripts: { build: "node print-env.mjs" } }))
  writeFileSync(join(project.dir, "supatype.config.ts"), "export default {}\n")
  writeFileSync(join(project.dir, ".env"), "API_EXTERNAL_URL=https://api.example.com\nANON_KEY=anon-key-value\n")
})
afterEach(() => project.remove())

function builtEnv(): Record<string, string> | undefined {
  const file = join(project.dir, "env-out.json")
  if (!existsSync(file)) return undefined
  const env = parseJsonAs(readFileSync(file, "utf8"), isJsonObject)
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => isString(entry[1])))
}

describe("runFrontendBuild with build.publicEnv", () => {
  it("passes each value under every prefix, beside the address and anon key", async () => {
    config = projectConfig({ build: { publicEnv: { MAPS_KEY: "m1", STRIPE: { production: "pk_prod" } } } })
    expect(await runFrontendBuild(project.dir, [], { processEnv: {}, env: "production" })).toBe(0)
    const env = builtEnv()
    for (const prefix of ["VITE_", "PUBLIC_", "NEXT_PUBLIC_", "EXPO_PUBLIC_"]) {
      expect(env?.[`${prefix}MAPS_KEY`], `${prefix}MAPS_KEY`).toBe("m1")
      expect(env?.[`${prefix}STRIPE`], `${prefix}STRIPE`).toBe("pk_prod")
      expect(env?.[`${prefix}SUPATYPE_ANON_KEY`]).toBe("anon-key-value")
    }
  })

  it("passes none for a project that sets none", async () => {
    config = projectConfig()
    await runFrontendBuild(project.dir, [], { processEnv: {} })
    expect(Object.keys(builtEnv() ?? {}).filter((name) => name.startsWith("VITE_") && !name.startsWith("VITE_SUPATYPE_"))).toEqual([])
  })
})
