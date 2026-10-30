import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, test } from "node:test"
import { pathToFileURL } from "node:url"

/**
 * The control plane's process entry starts whatever name it runs under. server.ts decided from
 * `process.argv[1]`, which a bundle or a renamed copy does not keep, and then exited at once with
 * code 0, as the realtime binary did (local test round 3b N12). The entry is declared once, in
 * package.json's `supatype.entry`, and the image runs it.
 */
const root = resolve(import.meta.dirname, "..")

/** `supatype.entry` from package.json, as the image and `start` run it, e.g. `dist/main.js`. */
function declaredEntry(): string {
  const pkg: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  const declared = typeof pkg === "object" && pkg !== null && "supatype" in pkg ? pkg.supatype : undefined
  const entry = typeof declared === "object" && declared !== null && "entry" in declared ? declared.entry : undefined
  return typeof entry === "string" ? entry : "dist/server.js"
}

/** Waits for `child` to print `text`; false when it exits first or `ms` pass. */
function printed(child: ReturnType<typeof spawn>, text: string, ms: number): Promise<boolean> {
  return new Promise((done) => {
    let out = ""
    const timer = setTimeout(() => done(false), ms)
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString()
      if (out.includes(text)) done(true)
    })
    child.on("exit", () => {
      clearTimeout(timer)
      done(out.includes(text))
    })
  })
}

describe("the control plane's process entry", () => {
  test("starts the server when loaded under another file name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "control-plane-entry-"))
    const source = join(root, declaredEntry().replace(/^dist\//, "src/").replace(/\.js$/, ".ts"))
    const renamed = join(dir, "control-plane-bundle.mts")
    writeFileSync(renamed, `import ${JSON.stringify(pathToFileURL(source).href)}\n`)
    const env = { ...process.env, PORT: "0", SUPATYPE_CONTROL_PLANE_SECRET: "entry-test-secret" }
    const child = spawn(process.execPath, ["--import", "tsx", renamed], { cwd: root, env, stdio: ["ignore", "pipe", "ignore"] })
    try {
      assert.equal(await printed(child, "[control-plane] listening", 15_000), true)
    } finally {
      child.kill()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("is what the image runs", () => {
    assert.match(readFileSync(join(root, "Dockerfile"), "utf8"), new RegExp(`CMD \\["node", "${declaredEntry()}"\\]`))
  })
})
