/**
 * `/supatype-env.js` in a Next.js app: the route that serves it, and the root layout's script.
 *
 * `next build` prerenders the static pages without the deployment's values, so init has the app
 * serve them when a page loads instead. The route, `@supatype/ssr/next`'s `GET`, answers with
 * `SUPATYPE_URL` and `SUPATYPE_ANON_KEY` as the running server has them; the root layout loads it
 * with `next/script`'s `beforeInteractive`, which Next runs before it requires any of the app's
 * modules, so the client has the values by its first request.
 *
 * The App Router only: route handlers live in `app/`. A Pages Router app is told what to add, since
 * init would have to create an `app/` directory beside it and edit `pages/_document`, which it does
 * not own. A layout init cannot edit safely is left as it is, and the two lines are printed instead.
 */

import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, join, sep } from "node:path"
import semver from "semver"
import { detectFramework } from "./app/framework.js"
import { errorMessage } from "./error-message.js"
import { file, info, plain, warn } from "./ui/messages.js"
import { parsePackageJson } from "./package-json.js"
import { isJsonObject, parseJsonObject } from "@supatype/shared"

const SSR_PACKAGE = "@supatype/ssr"
const SCRIPT_SRC = "/supatype-env.js"
const SCRIPT_IMPORT = 'import Script from "next/script"'
const LAYOUT_NAMES = ["layout.tsx", "layout.jsx", "layout.js", "layout.ts"] as const

/**
 * The route file. It has no segment config: `GET` reads the request, which keeps it per request on
 * every Next version, and a `dynamic` export makes Next 16 with `cacheComponents` (create-next-app's
 * default) answer the route with a 500 (0.9.1 release test, RB6).
 */
export const NEXT_RUNTIME_ENV_ROUTE = [
  "// The deployment's API address and anon key for the browser client, read from SUPATYPE_URL and",
  "// SUPATYPE_ANON_KEY on the server at each page load. The root layout loads it before the app.",
  "// No segment config: GET reads the request, which keeps it out of the build's prerender on every",
  "// Next version, and Next 16 with cacheComponents refuses a `dynamic` export.",
  `export { GET } from "${SSR_PACKAGE}/next"`,
  "",
].join("\n")

/** The routes earlier releases of init wrote, which are safe to replace: 0.9.1's, the only one before. */
const EARLIER_ROUTES: readonly string[] = [
  [
    "// The deployment's API address and anon key for the browser client, read from SUPATYPE_URL and",
    "// SUPATYPE_ANON_KEY on the server at each page load. The root layout loads it before the app.",
    `export { GET } from "${SSR_PACKAGE}/next"`,
    "// Written here rather than re-exported: Next reads a route's segment config from this file only.",
    'export const dynamic = "force-dynamic"',
    "",
  ].join("\n"),
]

/** Every place init writes the route: `app/` or `src/app/`, TypeScript or not. */
const ROUTE_PATHS = ["app", "src/app"].flatMap((appDir) => ["ts", "js"].map((ext) => `${appDir}/supatype-env.js/route.${ext}`))

const DYNAMIC_EXPORT = /^\s*export\s+const\s+dynamic\b/m

/**
 * Bring the route an earlier init wrote up to date: one still as init wrote it is replaced, keeping
 * its line endings; one changed since that still exports `dynamic` is left alone, with one warning.
 *
 * 0.9.1 release test (RB6): 0.9.1's route exports `dynamic`, which Next 16 with `cacheComponents`
 * answers with a 500, and init skips a route that exists. `supatype generate` runs this, since every
 * install runs `generate` through the project's `prepare`, so an upgrade fixes the route by itself.
 */
export function upgradeNextRuntimeEnvRoute(dir: string): void {
  const routes = ROUTE_PATHS.filter((rel) => existsSync(join(dir, rel)))
  const changed: string[] = []
  for (const rel of routes) {
    const path = join(dir, rel)
    const source = readFileSync(path, "utf8")
    const text = source.replace(/\r\n/g, "\n")
    if (EARLIER_ROUTES.includes(text)) replaceRoute(path, rel, source.includes("\r\n") ? "\r\n" : "\n")
    else if (DYNAMIC_EXPORT.test(text)) changed.push(rel)
  }
  if (changed.length > 0) {
    warn(
      `${changed.join(" and ")} ${changed.length === 1 ? "has" : "have"} an \`export const dynamic\` line, which Next.js refuses ` +
        `with a 500 when cacheComponents is on (a new create-next-app's default). Remove it: GET from ${SSR_PACKAGE}/next ` +
        "keeps the route per request by itself.",
    )
  }
  if (routes.length > 0) warnOldSsr(dir)
}

/** The first `@supatype/ssr` whose `GET` reads the request, which the current route relies on. */
const SSR_ROUTE_FLOOR = "0.9.2"

/**
 * Warn when the `@supatype/ssr` the route imports is older than {@link SSR_ROUTE_FLOOR}: its `GET`
 * does not read the request, so Next prerenders the route and serves it with no values.
 */
function warnOldSsr(dir: string): void {
  const version = installedSsrVersion(dir)
  // A prerelease of the floor has the fix; one of an earlier version does not.
  if (version === undefined || !semver.lt(version, `${SSR_ROUTE_FLOOR}-0`)) return
  warn(
    `${SSR_PACKAGE} ${version} is installed. Upgrade it to ${SSR_ROUTE_FLOOR} or later, or Next.js prerenders ` +
      `${SCRIPT_SRC} at build time and serves it with no values.`,
  )
}

/**
 * The version of the `@supatype/ssr` Node would load from `dir`: the nearest
 * `node_modules/@supatype/ssr`, in `dir` or a folder above, where a workspace hoists it. Undefined
 * when there is none, when it cannot be read, or when it is linked to a source checkout outside
 * any `node_modules` (a workspace package), whose version field is not a release's.
 */
function installedSsrVersion(dir: string): string | undefined {
  for (let at = dir; ; at = dirname(at)) {
    const pkgDir = join(at, "node_modules", "@supatype", "ssr")
    if (existsSync(join(pkgDir, "package.json"))) return releasedVersion(pkgDir)
    if (dirname(at) === at) return undefined
  }
}

/** The version in `pkgDir`'s package.json, when it is an installed release. */
function releasedVersion(pkgDir: string): string | undefined {
  try {
    if (!realpathSync(pkgDir).split(sep).includes("node_modules")) return undefined
    const { version } = parsePackageJson(readFileSync(join(pkgDir, "package.json"), "utf8"))
    return version !== undefined && semver.valid(version) !== null ? version : undefined
  } catch {
    return undefined
  }
}

/** Write the current route over one init wrote, or say why it could not be. */
function replaceRoute(path: string, rel: string, eol: string): void {
  try {
    writeFileSync(path, NEXT_RUNTIME_ENV_ROUTE.replace(/\n/g, eol), "utf8")
    file("updated", `${rel} (removed export const dynamic, which Next.js refuses under cacheComponents)`)
  } catch (err) {
    warn(`Could not update ${rel}: ${errorMessage(err)}. Remove its \`export const dynamic\` line by hand.`)
  }
}

const NEXT_CONFIG_NAMES = ["next.config.ts", "next.config.mts", "next.config.mjs", "next.config.js", "next.config.cjs"] as const

/** `output: "export"` in any quotes, the one setting that makes `next build` a static export. */
const STATIC_EXPORT_OUTPUT = /\boutput\s*:\s*(["'`])export\1/

/**
 * Whether the app's `next.config` makes it a static export, read as text: init never runs the
 * app's config. A static export cannot serve a route, and `next build` refuses a dynamic one.
 */
function isStaticExport(dir: string): boolean {
  return NEXT_CONFIG_NAMES.some((name) => {
    const path = join(dir, name)
    return existsSync(path) && STATIC_EXPORT_OUTPUT.test(readFileSync(path, "utf8"))
  })
}

/** A static export takes its values at build time, or from the server that hosts its files. */
function printStaticExportSteps(): void {
  info(`This Next.js app is a static export (output: "export"), which cannot serve a route, so init added no ${SCRIPT_SRC} route or layout script.`)
  plain("  A static export takes its values at build time: build it with `supatype build -- next build`.")
  plain(`  Or let Supatype hosting serve it, which answers ${SCRIPT_SRC} itself; ${scriptTag("Script")} in the root layout then loads it.`)
}

/** The script element, under whatever name the layout imports `next/script` as. */
function scriptTag(name: string): string {
  return `<${name} src="${SCRIPT_SRC}" strategy="beforeInteractive" />`
}

/** The first of `candidates` (relative to `dir`) that exists. */
function firstExisting(dir: string, candidates: readonly string[]): string | undefined {
  return candidates.find((rel) => existsSync(join(dir, rel)))
}

type Write = (rel: string, content: string) => void

/**
 * Serve `/supatype-env.js` from a Next.js app in `dir`, and load it in its root layout. Does
 * nothing for an app that is not Next.js. `ssrRange` is the version range `@supatype/ssr` is added
 * at, when the app does not list it.
 */
export function scaffoldNextRuntimeEnv(dir: string, write: Write, ssrRange: string): void {
  if (detectFramework(dir) !== "nextjs") return
  if (isStaticExport(dir)) {
    printStaticExportSteps()
    return
  }
  const appDir = firstExisting(dir, ["app", "src/app"])
  if (appDir === undefined) {
    printPagesRouterSteps(firstExisting(dir, ["pages", "src/pages"]) ?? "pages")
    return
  }
  const routeExt = existsSync(join(dir, "tsconfig.json")) ? "ts" : "js"
  const routeRel = `${appDir}/supatype-env.js/route.${routeExt}`
  if (existsSync(join(dir, routeRel))) file("skipped", `${routeRel} (already exists)`)
  else write(routeRel, NEXT_RUNTIME_ENV_ROUTE)
  addSsrDependency(dir, ssrRange)
  loadInRootLayout(dir, appDir)
}

/** Add the script to the root layout, or say what to add when it cannot be done safely. */
function loadInRootLayout(dir: string, appDir: string): void {
  const layoutRel = firstExisting(dir, LAYOUT_NAMES.map((name) => `${appDir}/${name}`))
  if (layoutRel === undefined) {
    printLayoutLines(`${appDir}/layout.tsx`, "there is no root layout")
    return
  }
  const source = readFileSync(join(dir, layoutRel), "utf8")
  if (source.includes(SCRIPT_SRC)) {
    file("skipped", `${layoutRel} (already loads ${SCRIPT_SRC})`)
    return
  }
  const edited = withRuntimeEnvScript(source)
  if (edited === undefined) {
    printLayoutLines(layoutRel, "init could not edit it safely")
    return
  }
  writeFileSync(join(dir, layoutRel), edited, "utf8")
  file("updated", `${layoutRel} (loads ${SCRIPT_SRC} before the app)`)
}

/**
 * `source` with the script as the first thing in its one `<body>`, importing `next/script` when it
 * does not already. Undefined when that cannot be done without guessing: no `<body>` or more than
 * one, a `<body>` whose attributes hold a `>`, or a `Script` that is something else.
 */
export function withRuntimeEnvScript(source: string): string | undefined {
  const eol = source.includes("\r\n") ? "\r\n" : "\n"
  const text = source.replace(/\r\n/g, "\n")
  const bodies = [...text.matchAll(/<body\b[^>]*>/g)]
  const body = bodies[0]
  if (bodies.length !== 1 || body === undefined || body[0].endsWith("/>") || !balancedBraces(body[0])) return undefined
  const imported = /^import\s+([A-Za-z_$][\w$]*)\s+from\s+["']next\/script["']/m.exec(text)?.[1]
  if (imported === undefined && /\bScript\b/.test(text)) return undefined
  const name = imported ?? "Script"
  const end = body.index + body[0].length
  const tag = `\n${childIndent(text, body.index, end)}${scriptTag(name)}`
  const withTag = text.slice(0, end) + tag + text.slice(end)
  const result = imported === undefined ? withImport(withTag) : withTag
  return result.replace(/\n/g, eol)
}

/** Whether every `{` in a tag's attributes is closed in it, so its `>` really ends the tag. */
function balancedBraces(tag: string): boolean {
  let depth = 0
  for (const ch of tag) depth += ch === "{" ? 1 : ch === "}" ? -1 : 0
  return depth === 0
}

/** The indentation of the line after `<body>` when deeper than its own, else its own plus two. */
function childIndent(text: string, tagStart: number, tagEnd: number): string {
  const lineStart = text.lastIndexOf("\n", tagStart) + 1
  const own = /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? ""
  const next = /^\n([ \t]*)\S/.exec(text.slice(tagEnd))?.[1]
  return next !== undefined && next.length > own.length ? next : `${own}  `
}

/** `text` importing `next/script` first, below a leading `"use client"` style directive. */
function withImport(text: string): string {
  const directive = /^(["'])use [a-z]+\1;?[ \t]*\n(\n)?/.exec(text)
  if (directive === null) return `${SCRIPT_IMPORT}\n${text}`
  const at = directive[0].length
  return `${text.slice(0, at)}${SCRIPT_IMPORT}\n${text.slice(at)}`
}

/** The two lines to add by hand, and why init did not add them. */
function printLayoutLines(layoutRel: string, why: string): void {
  info(`${layoutRel} does not load ${SCRIPT_SRC} yet: ${why}. Add these two lines:`)
  plain(`  ${SCRIPT_IMPORT}`)
  plain(`  ${scriptTag("Script")}   (inside <body>, before anything else)`)
}

/** A Pages Router app: what to add, since init writes nothing into it. */
function printPagesRouterSteps(pagesDir: string): void {
  info(`This Next.js app uses the Pages Router (${pagesDir}/), so init added nothing to it. To load the deployment's values when a page loads:`)
  plain(`  1. Create app/supatype-env.js/route.ts (route handlers live in app/, beside ${pagesDir}/):`)
  for (const line of NEXT_RUNTIME_ENV_ROUTE.trimEnd().split("\n")) plain(`       ${line}`)
  plain(`  2. In ${pagesDir}/_document.tsx, import Script from "next/script" and add, inside <Head>:`)
  plain(`       ${scriptTag("Script")}`)
  plain(`  3. Add ${SSR_PACKAGE} to the app's dependencies, and set SUPATYPE_URL and SUPATYPE_ANON_KEY where it runs.`)
}

/** List `@supatype/ssr` in the app's dependencies, which the route imports, when it is not there. */
function addSsrDependency(dir: string, range: string): void {
  const pkgPath = join(dir, "package.json")
  const parsed = parseJsonObject(readFileSync(pkgPath, "utf8"))
  if (!parsed.ok) return
  const pkg = parsed.value
  const deps = isJsonObject(pkg["dependencies"]) ? pkg["dependencies"] : {}
  const devDeps = isJsonObject(pkg["devDependencies"]) ? pkg["devDependencies"] : {}
  if (SSR_PACKAGE in deps || SSR_PACKAGE in devDeps) return
  pkg["dependencies"] = { ...deps, [SSR_PACKAGE]: range }
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8")
  file("updated", `package.json (added ${SSR_PACKAGE}, which serves ${SCRIPT_SRC})`)
}
