/**
 * Where the expo-auth example finds its API address and anon key.
 *
 * 0.9.1 release test (FF43): `pnpm smoke` failed with `Missing ANON_KEY` after `supatype keys`. The
 * keys command writes the local stack's front-end values to `.env.development.local`, the template
 * left a blank `EXPO_PUBLIC_SUPATYPE_ANON_KEY=` in `.env`, and the smoke read only `.env` with `??`,
 * so the blank won over `ANON_KEY`.
 *
 * RB9: `expo export --platform web` runs in production mode and never reads
 * `.env.development.local`, so the web export had neither value. Its page now loads
 * `/supatype-env.js` from the server that serves it, as the Vite examples do.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const EXAMPLE = resolve(import.meta.dirname, "../../../examples/expo-auth")

/**
 * The example's own module, loaded by address so this package's typecheck leaves it to the
 * example's tsconfig. Its result is checked here instead.
 */
const loaded: unknown = await import(pathToFileURL(join(EXAMPLE, "scripts/smoke-target.mts")).href)
const exported: unknown = typeof loaded === "object" && loaded !== null ? Reflect.get(loaded, "smokeTarget") : undefined
if (typeof exported !== "function") throw new Error("scripts/smoke-target.mts exports no smokeTarget")
const run = exported

function smokeTarget(root: string, env: NodeJS.ProcessEnv): { gateway: unknown; anonKey: unknown } {
  const target: unknown = Reflect.apply(run, undefined, [root, env])
  if (typeof target !== "object" || target === null) throw new Error("smokeTarget returned no target")
  return { gateway: Reflect.get(target, "gateway"), anonKey: Reflect.get(target, "anonKey") }
}

describe("the expo-auth smoke's target", () => {
  let dir = ""
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "supatype-expo-smoke-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("passes over a blank EXPO_PUBLIC_SUPATYPE_ANON_KEY in .env for ANON_KEY", () => {
    writeFileSync(join(dir, ".env"), "ANON_KEY=minted.anon.key\nEXPO_PUBLIC_SUPATYPE_ANON_KEY=\n")
    expect(smokeTarget(dir, {}).anonKey).toBe("minted.anon.key")
  })

  it("reads the values `supatype keys` and `dev` write to .env.development.local first", () => {
    writeFileSync(join(dir, ".env"), "PUBLIC_SUPATYPE_URL=http://localhost:18473\n")
    writeFileSync(
      join(dir, ".env.development.local"),
      "EXPO_PUBLIC_SUPATYPE_URL=http://localhost:18490\nEXPO_PUBLIC_SUPATYPE_ANON_KEY=dev.anon.key\n",
    )
    expect(smokeTarget(dir, {})).toEqual({ gateway: "http://localhost:18490", anonKey: "dev.anon.key" })
  })

  it("takes SUPATYPE_URL and SUPATYPE_ANON_KEY from the environment over both files", () => {
    writeFileSync(join(dir, ".env.development.local"), "EXPO_PUBLIC_SUPATYPE_ANON_KEY=dev.anon.key\n")
    const env = { SUPATYPE_URL: "http://127.0.0.1:9000", SUPATYPE_ANON_KEY: "given.key" }
    expect(smokeTarget(dir, env)).toEqual({ gateway: "http://127.0.0.1:9000", anonKey: "given.key" })
  })
})

describe("the expo-auth web export's page", () => {
  it("is the project's own public/index.html, loading /supatype-env.js in the head", () => {
    // Expo's web export uses public/index.html as its template when there is one.
    const html = readFileSync(join(EXAMPLE, "public/index.html"), "utf8")
    const head = html.slice(0, html.indexOf("</head>"))
    // A plain script, so it runs before the bundle Expo appends to the body.
    expect(head).toMatch(/<script src="\/supatype-env\.js"><\/script>/)
    // Expo fills these in, and mounts the app on #root.
    expect(html).toContain("%WEB_TITLE%")
    expect(html).toContain('<div id="root"></div>')
  })
})

describe("the expo-auth .env template", () => {
  it("leaves out the front-end names the CLI writes to .env.development.local", () => {
    const template = readFileSync(join(EXAMPLE, ".env.example"), "utf8")
    expect(template).not.toMatch(/^EXPO_PUBLIC_SUPATYPE_(URL|ANON_KEY)=/m)
  })
})
