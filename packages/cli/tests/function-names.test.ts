/**
 * CT1: the control plane accepts a function name only when it matches `^[a-z0-9][a-z0-9_-]*$`. The
 * CLI took any folder name, so `functions/sendEmail/` ran under `functions serve` and `dev`, was
 * listed by `functions deploy --dry-run`, and only the server refused it. The CLI now checks the
 * same rule (`@supatype/shared`), naming the folder and the rule.
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { discoverTsFunctionsInDir } from "../src/functions-discovery.js"
import { errorMessage } from "../src/error-message.js"

const CLI_BIN = resolve(dirname(fileURLToPath(import.meta.url)), "../bin/supatype.js")
const RULE = 'use lowercase letters, digits, "-" and "_", starting with a letter or digit'
const HANDLER = "export default async () => new Response('ok')\n"

let root = ""

afterEach(() => {
  if (root !== "") rmSync(root, { recursive: true, force: true })
  root = ""
})

/** A project with `functions/<name>/index.ts` for each folder, and `functions/<name>.ts` for each file. */
function project(folders: string[], files: string[] = []): string {
  root = mkdtempSync(join(tmpdir(), "supatype-fn-names-"))
  writeFileSync(join(root, "supatype.config.ts"), 'export default { project: { name: "fn-names" } }\n')
  const fnDir = join(root, "functions")
  mkdirSync(fnDir, { recursive: true })
  for (const name of folders) {
    mkdirSync(join(fnDir, name), { recursive: true })
    writeFileSync(join(fnDir, name, "index.ts"), HANDLER)
  }
  for (const name of files) writeFileSync(join(fnDir, `${name}.ts`), HANDLER)
  return root
}

function runCli(args: string[], cwd: string): { output: string; exitCode: number } {
  const result = spawnSync(process.execPath, [CLI_BIN, ...args], { cwd, encoding: "utf8", timeout: 60_000 })
  return { output: `${result.stdout ?? ""}${result.stderr ?? ""}`, exitCode: result.status ?? 1 }
}

describe("function discovery", () => {
  it("refuses a folder the server would refuse, naming it and the rule", () => {
    const dir = join(project(["hello", "sendEmail"], ["Webhook"]), "functions")
    let thrown: unknown
    try {
      discoverTsFunctionsInDir(dir)
    } catch (err: unknown) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Error)
    const message = errorMessage(thrown)
    expect(message).toContain("sendEmail")
    expect(message).toContain("Webhook.ts")
    expect(message).not.toContain('"hello"')
    expect(message).toContain(RULE)
    expect(message).toContain("send-email")
  })

  it("accepts every name the server accepts", () => {
    const dir = join(project(["hello", "send-email", "send_email", "v2"]), "functions")
    const names = discoverTsFunctionsInDir(dir).map((fn) => fn.name)
    expect([...names].sort()).toEqual(["hello", "send-email", "send_email", "v2"].sort())
  })
})

describe("supatype functions", () => {
  it("`new` refuses a name the server would refuse, and creates nothing", () => {
    const cwd = project([])
    const { output, exitCode } = runCli(["functions", "new", "sendEmail"], cwd)
    expect(exitCode).toBe(1)
    expect(output).toContain("sendEmail")
    expect(output).toContain(RULE)
    expect(existsSync(join(cwd, "functions", "sendEmail"))).toBe(false)
  })

  it("`deploy` names the folder and the rule before deploying anything", () => {
    const cwd = project(["hello", "sendEmail"])
    const { output, exitCode } = runCli(["functions", "deploy", "--dry-run"], cwd)
    expect(exitCode).toBe(1)
    expect(output).toContain("sendEmail")
    expect(output).toContain(RULE)
    expect(output).not.toContain("would be deployed")
  })
})
