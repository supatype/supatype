/**
 * The examples Supatype serves (`app.mode: "static"`) run from a plain production `vite build`.
 *
 * 0.9.1 release test (RB9): `supatype keys` and `dev` write a local stack's anon key to
 * `.env.development.local`, which a production build never reads, so a build made by the README's
 * own `vite build` had no key. Each example threw `VITE_SUPATYPE_ANON_KEY is not set` at load and
 * the page was blank. The examples now carry no key in the build: the page loads `/supatype-env.js`
 * from the server that serves it, and the client reads the key from there at its first request.
 *
 * Each example's client is built here with Vite in production mode, from a directory holding no
 * `.env` at all, then run against a page whose script set the values.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build, type Rollup } from "vite"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT_ENTRY = resolve(HERE, "../src/index.ts")
const EXAMPLES = resolve(HERE, "../../../examples")

interface ServedExample {
  name: string
  /** The module that creates the example's client, exporting it as `supatype`. */
  client: string
  /** Every page Vite builds for it. */
  pages: string[]
}

const SERVED: readonly ServedExample[] = [
  { name: "kitchen-sink", client: "kitchen-sink/apps/app/src/client.ts", pages: ["kitchen-sink/apps/app/index.html"] },
  { name: "supabucks", client: "supabucks/src/supatype.ts", pages: ["supabucks/index.html"] },
  {
    name: "framework-parity",
    client: "framework-parity/src/client.ts",
    pages: ["vue", "svelte", "solid"].map((app) => `framework-parity/src/${app}/index.html`),
  },
]

const PAGE_ORIGIN = "https://app.example.com"
const DEPLOYED_KEY = "deployed-anon-key"

let workDir = ""
let runs = 0

/** The one chunk a single-entry build writes. */
function onlyChunk(output: Rollup.RollupOutput | Rollup.RollupOutput[] | Rollup.RollupWatcher): string {
  const outputs = Array.isArray(output) ? output : [output]
  const chunk = outputs.flatMap((o) => ("output" in o ? o.output : [])).find((item) => item.type === "chunk")
  if (chunk === undefined) throw new Error("vite build wrote no chunk")
  return chunk.code
}

/** The example's client, built as `vite build` builds it, with no `.env` anywhere Vite looks. */
async function buildClient(example: ServedExample): Promise<string> {
  const dir = join(workDir, example.name)
  const entry = join(dir, "main.js")
  const client = resolve(EXAMPLES, example.client).replace(/\\/g, "/")
  writeFileSync(
    entry,
    [`import { supatype } from ${JSON.stringify(client)}`, `globalThis.firstRequest = () => supatype.from("posts").select()`].join("\n"),
    "utf8",
  )
  const output = await build({
    root: dir,
    envDir: dir,
    configFile: false,
    logLevel: "silent",
    mode: "production",
    resolve: { alias: { "@supatype/client": CLIENT_ENTRY } },
    build: { write: false, minify: true, rollupOptions: { input: entry } },
  })
  return onlyChunk(output)
}

/** Run a bundle as the page loads it: a file of its own each time, since a module runs once per URL. */
async function runBundle(bundle: string): Promise<void> {
  runs += 1
  const file = join(workDir, `bundle-${runs}.mjs`)
  writeFileSync(file, bundle, "utf8")
  await import(pathToFileURL(file).href)
}

/** The anon key each request is sent with, answered with an empty list. */
function stubFetch(): string[] {
  const keys: string[] = []
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    keys.push(new Headers(init?.headers).get("apikey") ?? "")
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } })
  })
  return keys
}

function firstRequest(): Promise<unknown> {
  const run: unknown = Reflect.get(globalThis, "firstRequest")
  if (typeof run !== "function") throw new Error("the bundle set up no request")
  return Promise.resolve(Reflect.apply(run, undefined, []))
}

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "supatype-example-bundle-"))
  for (const example of SERVED) mkdirSync(join(workDir, example.name))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

afterAll(() => {
  if (workDir !== "") rmSync(workDir, { recursive: true, force: true })
})

describe.each(SERVED)("the $name example, built with no anon key", (example) => {
  it("loads, and sends the key the server's /supatype-env.js set", async () => {
    const bundle = await buildClient(example)
    const keys = stubFetch()
    vi.stubGlobal("firstRequest", undefined)
    vi.stubGlobal("window", { location: { origin: PAGE_ORIGIN } })
    vi.stubGlobal("__SUPATYPE_ENV__", { url: PAGE_ORIGIN, anonKey: DEPLOYED_KEY })
    await runBundle(bundle)
    await firstRequest()
    expect(keys).toEqual([DEPLOYED_KEY])
  }, 60_000)

  it.each(example.pages)("%s loads /supatype-env.js in the head, before the app's own script", (page) => {
    const html = readFileSync(resolve(EXAMPLES, page), "utf8")
    const head = html.slice(0, html.indexOf("</head>"))
    // A plain script: async or defer could let it run after the app's module script.
    expect(head).toMatch(/<script src="\/supatype-env\.js" vite-ignore><\/script>/)
    expect(html.indexOf("/supatype-env.js")).toBeLessThan(html.indexOf('type="module"'))
  })
})
