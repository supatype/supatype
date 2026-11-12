import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { defaultScaffoldOptions, scaffold } from "../src/commands/init.js"

/**
 * In a Next.js app, init serves `/supatype-env.js` from a route and loads it in the root layout.
 *
 * `next build` prerenders without the deployment's values; the route answers each page load with
 * the running server's `SUPATYPE_URL` and `SUPATYPE_ANON_KEY`, and the layout's `beforeInteractive`
 * script runs it before any of the app's modules, so the client finds them at its first request.
 * A layout init cannot edit safely is left alone and the two lines to add are printed instead.
 */
const ROUTE = [
  "// The deployment's API address and anon key for the browser client, read from SUPATYPE_URL and",
  "// SUPATYPE_ANON_KEY on the server at each page load. The root layout loads it before the app.",
  "// No segment config: GET reads the request, which keeps it out of the build's prerender on every",
  "// Next version, and Next 16 with cacheComponents refuses a `dynamic` export.",
  'export { GET } from "@supatype/ssr/next"',
  "",
].join("\n")
const SCRIPT_TAG = '<Script src="/supatype-env.js" strategy="beforeInteractive" />'
const SCRIPT_IMPORT = 'import Script from "next/script"'

/** create-next-app's root layout, trimmed. */
const CREATE_NEXT_APP_LAYOUT = `import type { Metadata } from "next"
import "./globals.css"

export const metadata: Metadata = { title: "Create Next App" }

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
      </body>
    </html>
  )
}
`

const dirs: string[] = []
let printed: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A project with `files`, scaffolded by init; returns a reader for what is there afterwards. */
function initIn(files: Record<string, string>): { read: (rel: string) => string | undefined; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "supatype-next-env-"))
  dirs.push(dir)
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), content, "utf8")
  }
  printed = []
  const record = (...args: unknown[]): void => { printed.push(args.map(String).join(" ")) }
  vi.spyOn(console, "log").mockImplementation(record)
  vi.spyOn(console, "warn").mockImplementation(record)
  scaffold(dir, defaultScaffoldOptions("acme"))
  return { dir, read: (rel) => (existsSync(join(dir, rel)) ? readFileSync(join(dir, rel), "utf8") : undefined) }
}

const NEXT_PACKAGE = JSON.stringify({ name: "acme", dependencies: { next: "15.5.0", react: "19.0.0" } })

describe("init in a Next.js App Router app", () => {
  it("writes the route that serves /supatype-env.js", () => {
    const { read } = initIn({ "package.json": NEXT_PACKAGE, "tsconfig.json": "{}", "app/layout.tsx": CREATE_NEXT_APP_LAYOUT })
    expect(read("app/supatype-env.js/route.ts")).toBe(ROUTE)
  })

  // 0.9.1 release test (RB6): create-next-app turns on cacheComponents, and Next then answers 500 for
  // a route that exports `dynamic`. The route stays per request by reading the request.
  it("writes no route segment config, which Next 16 refuses under cacheComponents", () => {
    const { read } = initIn({ "package.json": NEXT_PACKAGE, "tsconfig.json": "{}", "app/layout.tsx": CREATE_NEXT_APP_LAYOUT })
    expect(read("app/supatype-env.js/route.ts")).not.toMatch(/export\s+const\s+(dynamic|revalidate|fetchCache|dynamicParams)\b/)
  })

  it("loads it first thing in the root layout's body, with next/script before the app", () => {
    const { read } = initIn({ "package.json": NEXT_PACKAGE, "tsconfig.json": "{}", "app/layout.tsx": CREATE_NEXT_APP_LAYOUT })
    const layout = read("app/layout.tsx") ?? ""

    expect(layout).toContain(SCRIPT_IMPORT)
    expect(layout).toContain(`      <body className="antialiased">\n        ${SCRIPT_TAG}\n        {children}`)
    expect(layout.replace(`${SCRIPT_IMPORT}\n`, "").replace(`        ${SCRIPT_TAG}\n`, "")).toBe(CREATE_NEXT_APP_LAYOUT)
  })

  it("adds @supatype/ssr, which the route imports, to the app's dependencies", () => {
    const { read } = initIn({ "package.json": NEXT_PACKAGE, "tsconfig.json": "{}", "app/layout.tsx": CREATE_NEXT_APP_LAYOUT })
    const pkg: unknown = JSON.parse(read("package.json") ?? "{}")
    const deps: unknown = typeof pkg === "object" && pkg !== null ? Reflect.get(pkg, "dependencies") : undefined
    const range: unknown = typeof deps === "object" && deps !== null ? Reflect.get(deps, "@supatype/ssr") : undefined
    expect(range).toMatch(/^\^\d/)
  })

  it("keeps the import below a 'use client' directive, which must stay first", () => {
    const layout = `"use client"\n\nimport React from "react"\n\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html lang="en">\n      <body>\n        {children}\n      </body>\n    </html>\n  )\n}\n`
    const { read } = initIn({ "package.json": NEXT_PACKAGE, "tsconfig.json": "{}", "app/layout.tsx": layout })
    const edited = read("app/layout.tsx") ?? ""

    expect(edited.startsWith(`"use client"\n\n${SCRIPT_IMPORT}\nimport React from "react"`)).toBe(true)
    expect(edited).toContain(`      <body>\n        ${SCRIPT_TAG}\n`)
  })

  it("uses the app's own name for next/script when it already imports it", () => {
    const layout = CREATE_NEXT_APP_LAYOUT.replace('import "./globals.css"', 'import "./globals.css"\nimport NextScript from "next/script"')
    const { read } = initIn({ "package.json": NEXT_PACKAGE, "tsconfig.json": "{}", "app/layout.tsx": layout })
    const edited = read("app/layout.tsx") ?? ""

    expect(edited).not.toContain(SCRIPT_IMPORT)
    expect(edited).toContain('<NextScript src="/supatype-env.js" strategy="beforeInteractive" />')
  })

  it("writes into src/app for an app kept there, as a JavaScript route without a tsconfig", () => {
    const { read } = initIn({ "package.json": NEXT_PACKAGE, "src/app/layout.jsx": CREATE_NEXT_APP_LAYOUT.replace(/: Readonly<.*?>\)/, ")") })
    expect(read("src/app/supatype-env.js/route.js")).toBe(ROUTE)
    expect(read("src/app/layout.jsx")).toContain(SCRIPT_TAG)
  })

  it("leaves a route and a layout that already load it as they are", () => {
    const own = 'export { GET } from "@supatype/ssr/next"\nexport const dynamic = "force-dynamic"\n// mine\n'
    const layout = CREATE_NEXT_APP_LAYOUT.replace("{children}", `${SCRIPT_TAG}\n        {children}`)
    const { read } = initIn({
      "package.json": NEXT_PACKAGE,
      "tsconfig.json": "{}",
      "app/layout.tsx": layout,
      "app/supatype-env.js/route.ts": own,
    })

    expect(read("app/supatype-env.js/route.ts")).toBe(own)
    expect(read("app/layout.tsx")).toBe(layout)
  })

  it.each([
    ["no <body>", CREATE_NEXT_APP_LAYOUT.replace(/<body className="antialiased">|<\/body>/g, "")],
    ["two <body> tags", CREATE_NEXT_APP_LAYOUT.replace("{children}", "<body></body>{children}")],
    ["a Script of its own that is not next/script", `import Script from "./my-script"\n${CREATE_NEXT_APP_LAYOUT}`],
  ])("prints the two lines rather than edit a layout with %s", (_label, layout) => {
    const { read } = initIn({ "package.json": NEXT_PACKAGE, "tsconfig.json": "{}", "app/layout.tsx": layout })

    expect(read("app/layout.tsx")).toBe(layout)
    expect(read("app/supatype-env.js/route.ts")).toBe(ROUTE)
    const out = printed.join("\n")
    expect(out).toContain(SCRIPT_IMPORT)
    expect(out).toContain(SCRIPT_TAG)
  })

  it("prints the two lines when there is no root layout to edit", () => {
    const { read } = initIn({ "package.json": NEXT_PACKAGE, "tsconfig.json": "{}", "app/page.tsx": "export default function P() { return null }\n" })

    expect(read("app/supatype-env.js/route.ts")).toBe(ROUTE)
    expect(read("app/layout.tsx")).toBeUndefined()
    expect(printed.join("\n")).toContain(SCRIPT_TAG)
  })
})

describe("init in a Next.js app built as a static export", () => {
  it.each([
    ["next.config.ts", ['const nextConfig = { output: "export" }', "export default nextConfig", ""].join("\n")],
    ["next.config.mjs", ["export default {", "  output: 'export',", "}", ""].join("\n")],
    ["next.config.js", ["module.exports = { reactStrictMode: true, output: `export` }", ""].join("\n")],
  ])("writes no route and leaves the layout alone for %s, and says how it gets its values", (name, config) => {
    const { read } = initIn({ "package.json": NEXT_PACKAGE, "tsconfig.json": "{}", [name]: config, "app/layout.tsx": CREATE_NEXT_APP_LAYOUT })

    expect(read("app/supatype-env.js/route.ts")).toBeUndefined()
    expect(read("app/layout.tsx")).toBe(CREATE_NEXT_APP_LAYOUT)
    expect(read("package.json")).not.toContain("@supatype/ssr")
    const out = printed.join("\n")
    expect(out).toContain("static export")
    expect(out).toContain("supatype build -- next build")
  })

  it("still writes the route for a config that only mentions export elsewhere", () => {
    const config = ['import type { NextConfig } from "next"', 'const nextConfig: NextConfig = { output: "standalone" }', "export default nextConfig", ""].join("\n")
    const { read } = initIn({ "package.json": NEXT_PACKAGE, "tsconfig.json": "{}", "next.config.ts": config, "app/layout.tsx": CREATE_NEXT_APP_LAYOUT })
    expect(read("app/supatype-env.js/route.ts")).toBe(ROUTE)
  })
})

describe("init in a Next.js Pages Router app", () => {
  it("writes nothing into the app, and prints the route and the _document script to add", () => {
    const { read } = initIn({ "package.json": NEXT_PACKAGE, "tsconfig.json": "{}", "pages/index.tsx": "export default function P() { return null }\n" })

    expect(read("app/supatype-env.js/route.ts")).toBeUndefined()
    const out = printed.join("\n")
    expect(out).toContain("app/supatype-env.js/route.ts")
    expect(out).toContain("pages/_document")
    expect(out).toContain(SCRIPT_TAG)
  })
})

describe("init in an app that is not Next.js", () => {
  it("writes no route", () => {
    const { read } = initIn({ "package.json": JSON.stringify({ name: "acme", dependencies: { vite: "6.0.0" } }) })
    expect(read("app/supatype-env.js/route.ts")).toBeUndefined()
    expect(printed.join("\n")).not.toContain("supatype-env.js/route")
  })
})

describe("init's local values for the Next.js route in development", () => {
  it("writes SUPATYPE_URL to .env.development.local, which next dev loads", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-next-dev-env-"))
    dirs.push(dir)
    writeFileSync(join(dir, "package.json"), NEXT_PACKAGE, "utf8")
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    scaffold(dir, { ...defaultScaffoldOptions("acme"), kongPort: 18490 })
    expect(readFileSync(join(dir, ".env.development.local"), "utf8")).toMatch(/^SUPATYPE_URL=http:\/\/localhost:18490$/m)
  })
})
