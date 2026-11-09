/**
 * A production bundle built with no address or anon key still says why it cannot start.
 *
 * The formflow report: `vite build` with neither value replaced both with `undefined`, folded the
 * app's own `if (!key) throw` into an unconditional throw, and dropped everything after it, so the
 * page was blank and the cause was gone from the bundle. The check that replaces it lives in the
 * client and runs on the first request, reading the page at that moment, which no bundler can fold
 * away. Built here with Vite, the bundler that report used, minified, and then run.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build, type Rollup } from "vite"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"

const CLIENT_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "../src/index.ts")

/** What an app's own setup file says, with nothing defined for either name. */
const APP_SOURCE = [
  `import { createClient } from ${JSON.stringify(CLIENT_ENTRY.replace(/\\/g, "/"))}`,
  "export const supatype = createClient({",
  "  url: import.meta.env.VITE_SUPATYPE_URL,",
  "  anonKey: import.meta.env.VITE_SUPATYPE_ANON_KEY,",
  "})",
  "globalThis.started = true",
  "globalThis.firstRequest = () => supatype.from(\"posts\").select()",
].join("\n")

let workDir = ""
let bundle = ""

/** The one chunk a single-entry build writes. */
function onlyChunk(output: Rollup.RollupOutput | Rollup.RollupOutput[] | Rollup.RollupWatcher): string {
  const outputs = Array.isArray(output) ? output : [output]
  const chunk = outputs.flatMap((o) => ("output" in o ? o.output : [])).find((item) => item.type === "chunk")
  if (chunk === undefined) throw new Error("vite build wrote no chunk")
  return chunk.code
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "supatype-client-bundle-"))
  const entry = join(workDir, "main.js")
  writeFileSync(entry, APP_SOURCE, "utf8")
  const output = await build({
    root: workDir,
    configFile: false,
    logLevel: "silent",
    mode: "production",
    build: { write: false, minify: true, rollupOptions: { input: entry } },
  })
  bundle = onlyChunk(output)
}, 60_000)

let runs = 0

/**
 * The bundle, imported as the page would load it. Each run is a file of its own, since a module
 * is evaluated once per URL and each run needs its createClient call made again.
 */
async function runBundle(): Promise<void> {
  vi.stubGlobal("started", undefined)
  vi.stubGlobal("firstRequest", undefined)
  runs += 1
  const file = join(workDir, `bundle-${runs}.mjs`)
  writeFileSync(file, bundle, "utf8")
  await import(pathToFileURL(file).href)
}

/** Every address the bundle sends to, answered with an empty list. */
function stubFetch(): string[] {
  const sent: string[] = []
  vi.stubGlobal("fetch", async (url: string) => {
    sent.push(url)
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } })
  })
  return sent
}

/** The request the bundle's app set up, made now. */
function firstRequest(): Promise<unknown> {
  const run: unknown = Reflect.get(globalThis, "firstRequest")
  if (typeof run !== "function") throw new Error("the bundle set up no request")
  const request: unknown = Reflect.apply(run, undefined, [])
  return Promise.resolve(request)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

afterAll(() => {
  if (workDir !== "") rmSync(workDir, { recursive: true, force: true })
})

describe("a production bundle with no address or anon key", () => {
  it("keeps the error that names the fix", () => {
    // The frontend names are put together from prefix and name, so the bundle holds the parts.
    expect(bundle).toContain("SUPATYPE_ANON_KEY")
    expect(bundle).toContain("NEXT_PUBLIC_")
    expect(bundle).toContain("supatype build")
    expect(bundle).toContain("/supatype-env.js")
  })

  it("starts, and throws that error on its first request rather than sending one with no key", async () => {
    const sent = stubFetch()
    await runBundle()
    expect(Reflect.get(globalThis, "started")).toBe(true)
    await expect(firstRequest()).rejects.toThrow(/VITE_SUPATYPE_ANON_KEY/)
    expect(sent).toEqual([])
  })

  it("sends with the values the page sets, the same build on any deployment", async () => {
    const sent = stubFetch()
    await runBundle()
    vi.stubGlobal("__SUPATYPE_ENV__", { url: "https://api.example.com", anonKey: "deployed-anon-key" })
    await firstRequest()
    expect(sent[0]?.startsWith("https://api.example.com/rest/v1/posts")).toBe(true)
  })
})
