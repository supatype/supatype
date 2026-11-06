import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { isJsonObject, isString } from "@supatype/shared"
import { buildSpawn } from "../src/build-spawn.js"
import { isCompiledBinary } from "../src/cli-install-method.js"
import { runFrontendBuild } from "../src/commands/build.js"
import { FrontendValuesRefused } from "../src/frontend-values.js"
import { signJwt } from "../src/jwt.js"
import { tempProject } from "./support/command-run.js"
import { parseJsonAs } from "./support/json.js"

/**
 * `supatype build` runs the app's production build with the deployment's API URL and anon key under
 * every front-end name, refusing before the build starts when either is missing (issue 29). A fake
 * build script writes the environment it was given to a file, which is what these read.
 */
const SECRET = "build-command-test-secret-32-chars!!!!"
const ANON = signJwt({ iss: "supatype", role: "anon" }, SECRET)
const SERVICE = signJwt({ iss: "supatype", role: "service_role" }, SECRET)
const API = "https://api.example.com"
const NAMES = ["VITE_", "PUBLIC_", "NEXT_PUBLIC_", "EXPO_PUBLIC_"]
const CLI_BIN = resolve(dirname(fileURLToPath(import.meta.url)), "../bin/supatype.js")

const PRINT_ENV = `import { writeFileSync } from "node:fs"
writeFileSync("env-out.json", JSON.stringify(process.env))
process.exit(Number(process.env.FAKE_BUILD_EXIT ?? "0"))
`

let project: { dir: string; remove: () => void }

beforeEach(() => {
  project = tempProject("build-command")
  writeFileSync(join(project.dir, "print-env.mjs"), PRINT_ENV)
  writeFileSync(join(project.dir, "package.json"), JSON.stringify({ name: "app", scripts: { build: "node print-env.mjs" } }))
  writeFileSync(join(project.dir, ".env"), `API_EXTERNAL_URL=${API}\nANON_KEY=${ANON}\nSERVICE_ROLE_KEY=${SERVICE}\n`)
})

afterEach(() => {
  vi.unstubAllEnvs()
  project.remove()
})

/** The environment the fake build ran with, or undefined when it never ran. */
function builtEnv(): Record<string, string> | undefined {
  const file = join(project.dir, "env-out.json")
  if (!existsSync(file)) return undefined
  const env = parseJsonAs(readFileSync(file, "utf8"), isJsonObject)
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => isString(entry[1])))
}

function expectFrontendValues(env: Record<string, string> | undefined): void {
  for (const prefix of NAMES) {
    expect(env?.[`${prefix}SUPATYPE_URL`], `${prefix}SUPATYPE_URL`).toBe(API)
    expect(env?.[`${prefix}SUPATYPE_ANON_KEY`], `${prefix}SUPATYPE_ANON_KEY`).toBe(ANON)
  }
  expect(Object.values(env ?? {})).not.toContain(SERVICE)
}

describe("runFrontendBuild", () => {
  it("runs the package.json build script with the values under every prefix", async () => {
    expect(await runFrontendBuild(project.dir, [], { processEnv: {} })).toBe(0)
    expectFrontendValues(builtEnv())
  })

  it("runs the command it is given", async () => {
    expect(await runFrontendBuild(project.dir, ["node", "print-env.mjs"], { processEnv: {} })).toBe(0)
    expectFrontendValues(builtEnv())
  })

  it("refuses before the build starts when the anon key is missing", async () => {
    writeFileSync(join(project.dir, ".env"), `API_EXTERNAL_URL=${API}\n`)
    await expect(runFrontendBuild(project.dir, [], { processEnv: {} })).rejects.toBeInstanceOf(FrontendValuesRefused)
    expect(builtEnv()).toBeUndefined()
  })

  it("returns the build's own exit code", async () => {
    vi.stubEnv("FAKE_BUILD_EXIT", "7")
    expect(await runFrontendBuild(project.dir, ["node", "print-env.mjs"], { processEnv: {} })).toBe(7)
  })

  it("marks the build's environment, so a build script calling supatype build can be told apart", async () => {
    expect(await runFrontendBuild(project.dir, [], { processEnv: {} })).toBe(0)
    expect(builtEnv()?.["SUPATYPE_BUILD_ACTIVE"]).toBe("1")
  })

  it("refuses a bare build inside a build, which would run the build script again forever", async () => {
    await expect(runFrontendBuild(project.dir, [], { processEnv: { SUPATYPE_BUILD_ACTIVE: "1" } }))
      .rejects.toThrow(/build script calls .supatype build. itself.*after --/s)
    expect(builtEnv()).toBeUndefined()
  })

  it("runs a command given after -- inside a build, once", async () => {
    expect(await runFrontendBuild(project.dir, ["node", "print-env.mjs"], { processEnv: { SUPATYPE_BUILD_ACTIVE: "1" } })).toBe(0)
    expectFrontendValues(builtEnv())
  })

  it("refuses a project with no build script, naming the way to pass one", async () => {
    writeFileSync(join(project.dir, "package.json"), JSON.stringify({ name: "app" }))
    await expect(runFrontendBuild(project.dir, [], { processEnv: {} })).rejects.toThrow(/no "build" script.*supatype build -- <command>/s)
  })

  it("never runs the build with the program running it, which is the CLI itself when compiled (#28)", async () => {
    const argv1 = process.argv[1] ?? ""
    process.argv[1] = "/$bunfs/root/supatype"
    try {
      expect(isCompiledBinary()).toBe(true)
      for (const command of [[], ["node", "print-env.mjs"]]) {
        for (const platform of ["win32", "linux"] as const) {
          expect(buildSpawn(project.dir, command, platform).file).not.toContain(process.execPath)
        }
      }
      expect(await runFrontendBuild(project.dir, [], { processEnv: {} })).toBe(0)
      expectFrontendValues(builtEnv())
    } finally {
      process.argv[1] = argv1
    }
  })
})

describe("buildSpawn", () => {
  it("runs the build script through the project's package manager", () => {
    writeFileSync(join(project.dir, "pnpm-lock.yaml"), "")
    expect(buildSpawn(project.dir, [], "linux")).toMatchObject({ file: "pnpm", args: ["run", "build"], shell: false })
    expect(buildSpawn(project.dir, [], "win32")).toMatchObject({ file: "pnpm run build", args: [], shell: true })
  })

  it("runs a command as given on POSIX, and through cmd.exe, quoted, on Windows", () => {
    expect(buildSpawn(project.dir, ["next", "build", "--debug"], "linux")).toMatchObject({ file: "next", args: ["build", "--debug"], shell: false })
    expect(buildSpawn(project.dir, ["node", "my build.mjs", "a&b"], "win32")).toMatchObject({
      file: 'node "my build.mjs" "a&b"',
      args: [],
      shell: true,
    })
  })
})

function runCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const name of Object.keys(env)) if (/SUPATYPE_(URL|ANON_KEY)$/.test(name)) delete env[name]
  const result = spawnSync(process.execPath, [CLI_BIN, ...args], { cwd: project.dir, env, encoding: "utf8", timeout: 60_000 })
  return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? ""), exitCode: result.status ?? 1 }
}

describe("supatype build (CLI subprocess, requires built dist/)", () => {
  it("builds, and exits with the build's code", () => {
    const ok = runCli(["build", "--", "node", "print-env.mjs"])
    expect(ok.exitCode, ok.stderr).toBe(0)
    expectFrontendValues(builtEnv())
  })

  it("exits non-zero before the build runs when a value is missing, naming what it tried", () => {
    writeFileSync(join(project.dir, ".env"), `API_EXTERNAL_URL=http://localhost:8000\nANON_KEY=${ANON}\n`)
    const refused = runCli(["build"])
    expect(refused.exitCode).toBe(1)
    expect(builtEnv()).toBeUndefined()
    expect(refused.stdout + refused.stderr).toContain("--allow-local")
  })

  it("stops, rather than recursing, when the build script is supatype build", () => {
    writeFileSync(join(project.dir, "package.json"), JSON.stringify({ name: "app", scripts: { build: `node "${CLI_BIN}" build` } }))
    const nested = runCli(["build"])
    expect(nested.exitCode).toBe(1)
    expect(nested.stdout + nested.stderr).toContain("calls `supatype build` itself")
  })
})
