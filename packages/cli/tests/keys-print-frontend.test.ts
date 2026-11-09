import { spawnSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { signJwt } from "../src/jwt.js"
import { tempProject } from "./support/command-run.js"

/**
 * `supatype keys --print frontend` prints a deployment's front-end names and values, one
 * `NAME=value` per line and nothing else on stdout, for a host's settings or `$GITHUB_ENV`. Same
 * resolver and local refusal as `supatype build`. Bare `--print` keeps printing the key pair.
 * Subprocess tests: they need the built dist/.
 */
const CLI_BIN = resolve(dirname(fileURLToPath(import.meta.url)), "../bin/supatype.js")
const SECRET = "keys-print-frontend-secret-32-chars!!!"
const ANON = signJwt({ iss: "supatype", role: "anon" }, SECRET)
const SERVICE = signJwt({ iss: "supatype", role: "service_role" }, SECRET)
const API = "https://api.example.com"

let project: { dir: string; remove: () => void }

beforeEach(() => {
  project = tempProject("keys-print-frontend")
})

afterEach(() => project.remove())

function runKeys(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const name of Object.keys(env)) if (/SUPATYPE_(URL|ANON_KEY)$|^JWT_SECRET$/.test(name)) delete env[name]
  const result = spawnSync(process.execPath, [CLI_BIN, "keys", ...args], { cwd: project.dir, env, encoding: "utf8", timeout: 60_000 })
  return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? ""), exitCode: result.status ?? 1 }
}

describe("supatype keys --print frontend", () => {
  it("prints every front-end name for the deployment, and nothing else on stdout", () => {
    writeFileSync(join(project.dir, ".env"), `JWT_SECRET=${SECRET}\nAPI_EXTERNAL_URL=${API}\nANON_KEY=${ANON}\nSERVICE_ROLE_KEY=${SERVICE}\n`)
    const { stdout, stderr, exitCode } = runKeys(["--print", "frontend"])
    expect(exitCode, stderr).toBe(0)
    expect(stdout.trim().split(/\r?\n/)).toEqual([
      `VITE_SUPATYPE_URL=${API}`,
      `PUBLIC_SUPATYPE_URL=${API}`,
      `NEXT_PUBLIC_SUPATYPE_URL=${API}`,
      `EXPO_PUBLIC_SUPATYPE_URL=${API}`,
      `VITE_SUPATYPE_ANON_KEY=${ANON}`,
      `PUBLIC_SUPATYPE_ANON_KEY=${ANON}`,
      `NEXT_PUBLIC_SUPATYPE_ANON_KEY=${ANON}`,
      `EXPO_PUBLIC_SUPATYPE_ANON_KEY=${ANON}`,
    ])
    expect(stdout + stderr).not.toContain(SERVICE)
  })

  it("refuses a local address, printing nothing on stdout", () => {
    writeFileSync(join(project.dir, ".env"), `API_EXTERNAL_URL=http://localhost:8000\nANON_KEY=${ANON}\n`)
    const { stdout, stderr, exitCode } = runKeys(["--print", "frontend"])
    expect(exitCode).toBe(1)
    expect(stdout).toBe("")
    expect(stderr).toContain("local address")
    expect(stderr).toContain("supatype keys --print frontend --env <name>")
  })

  it("refuses a target it does not know, listing the ones it does", () => {
    const { stderr, exitCode } = runKeys(["--print", "backend"])
    expect(exitCode).toBe(1)
    expect(stderr).toMatch(/Unknown --print target "backend".*frontend/)
  })

  it("refuses --env without --print frontend, which is the only thing it applies to", () => {
    const { stderr, exitCode } = runKeys(["--print", "--env", "staging"])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("--env")
  })

  it("takes a local address with --allow-local, as supatype build does", () => {
    writeFileSync(join(project.dir, ".env"), `API_EXTERNAL_URL=http://localhost:8000
ANON_KEY=${ANON}
`)
    const { stdout, stderr, exitCode } = runKeys(["--print", "frontend", "--allow-local"])
    expect(exitCode, stderr).toBe(0)
    expect(stdout).toContain("VITE_SUPATYPE_URL=http://localhost:8000")
    expect(stdout).toContain(`EXPO_PUBLIC_SUPATYPE_ANON_KEY=${ANON}`)
  })

  it("refuses --allow-local without --print frontend, which is the only thing it applies to", () => {
    writeFileSync(join(project.dir, ".env"), `JWT_SECRET=${SECRET}
`)
    const { stdout, stderr, exitCode } = runKeys(["--print", "--allow-local"])
    expect(exitCode).toBe(1)
    expect(stdout).not.toContain("ANON_KEY=")
    expect(stderr).toContain("--allow-local applies only to --print frontend")
  })

  it("says the expiry default once in --help", () => {
    const { stdout } = runKeys(["--help"])
    expect(stdout).toMatch(/Token expiry in years/)
    expect(stdout).not.toContain("(default: 10) (default")
  })

  it("bare --print still prints the key pair signed with .env's secret", () => {
    writeFileSync(join(project.dir, ".env"), `JWT_SECRET=${SECRET}\n`)
    const { stdout, exitCode } = runKeys(["--print"])
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/^ANON_KEY=ey/m)
    expect(stdout).toMatch(/^SERVICE_ROLE_KEY=ey/m)
  })
})
