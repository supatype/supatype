import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { freePort, SECRET } from "./fixtures/socket.js"

/**
 * Local test round 3b N12: the released realtime binary for Windows exited at once with code 0.
 * index.ts started the server only when `process.argv[1]` ended in index.js or index.ts, and in the
 * `pkg` binary it is the bundle's snapshot path (`C:\snapshot\release-bundle\supatype-realtime-bundle.cjs`).
 * The process entry starts whatever name it runs under; it is declared once, in package.json's
 * `supatype.entry`, and every way of running the service uses it.
 */
const root = resolve(import.meta.dirname, "..")
const children: ChildProcess[] = []
const dirs: string[] = []

afterEach(() => {
  for (const child of children.splice(0)) child.kill()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** package.json's `supatype.entry`, e.g. `dist/main.js`, or "" when it declares none. */
function declaredEntry(): string {
  const pkg: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  const declared = typeof pkg === "object" && pkg !== null && "supatype" in pkg ? pkg.supatype : undefined
  const entry = typeof declared === "object" && declared !== null && "entry" in declared ? declared.entry : undefined
  return typeof entry === "string" ? entry : ""
}

/** Whether /health answers on `port` within `ms`. */
async function healthWithin(port: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const ok = await fetch(`http://127.0.0.1:${port}/health`).then((res) => res.ok, () => false)
    if (ok) return true
    await new Promise((done) => setTimeout(done, 200))
  }
  return false
}

describe("the realtime process entry", () => {
  it("is declared in package.json", () => {
    expect(declaredEntry()).toBe("dist/main.js")
  })

  it("starts the server when loaded under another file name, as the pkg snapshot runs it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "realtime-entry-"))
    dirs.push(dir)
    const source = join(root, declaredEntry().replace(/^dist\//, "src/").replace(/\.js$/, ".ts"))
    const renamed = join(dir, "supatype-realtime-bundle.mts")
    writeFileSync(renamed, `import ${JSON.stringify(pathToFileURL(source).href)}\n`)
    const port = await freePort()
    const env = { ...process.env, PORT: String(port), DATABASE_URL: "postgres://x:y@127.0.0.1:1/none", JWT_SECRET: SECRET }
    const tsx = join(root, "node_modules", "tsx", "dist", "cli.mjs")
    children.push(spawn(process.execPath, [tsx, renamed], { env, stdio: "ignore" }))
    expect(await healthWithin(port, 15_000)).toBe(true)
  }, 30_000)

  it("is what the image, `start` and the release bundle run", () => {
    const entry = declaredEntry()
    expect(readFileSync(join(root, "Dockerfile"), "utf8")).toContain(`CMD ["node", "${entry}"]`)
    expect(readFileSync(join(root, "package.json"), "utf8")).toContain(`"start": "node ${entry}"`)
    expect(readFileSync(join(root, "scripts", "build-release-bundle.mjs"), "utf8")).toContain("supatype.entry")
  })
})
