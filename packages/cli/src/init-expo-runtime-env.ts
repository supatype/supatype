/**
 * `/supatype-env.js` in an Expo Router app's web page: the script in `app/+html.tsx`'s `<head>`.
 *
 * 0.9.2 release test (N-RB3): `expo export --platform web` runs in production mode, which never reads
 * `.env.development.local`, so a new Expo app's web build had no API address or anon key and threw
 * on load. A Vite app gets them from the script tag init puts in `index.html`, and a Next.js app from
 * its root layout (init-next-runtime-env.ts). An Expo Router app has neither: its page is rendered
 * from `+html.tsx` in the routes folder (`src/app` when it exists, else `app`, as Expo decides).
 * The server that hosts the export answers the script, whatever the app mode.
 *
 * A missing `+html.tsx` is made from the template the app's own Expo ships, which is what
 * `npx expo customize +html.tsx` writes: it changes between SDKs (SDK 58's imports
 * `useServerDocumentContext`, which an older `expo-router/html` does not export), so no copy kept
 * here would be right for every app. Without an installed Expo, init says what to add instead.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import { readPackageJson } from "./init-project-detect.js"
import { withFirstChildren } from "./jsx-first-child.js"
import { isJsonObject, parseJsonObject } from "@supatype/shared"
import { file, info, plain } from "./ui/messages.js"

const SCRIPT_SRC = "/supatype-env.js"

/**
 * The script, left out of a development page. 0.9.2 release test round 2 (R2-S9): unconditional, it
 * made every new Expo app log a 404 and a MIME error under `expo start --web`, since Metro serves no
 * `/supatype-env.js`; a development build has the values from `.env.development.local` anyway.
 */
const SCRIPT_LINE = `{__DEV__ ? null : <script src="${SCRIPT_SRC}" />}`

/** The lines init adds, first in `<head>`, so the script runs before the app's own. */
export const EXPO_RUNTIME_ENV_LINES = [
  "{/* The deployment's API address and anon key, from the server that hosts the export; a development build reads .env.development.local (supatype init). */}",
  SCRIPT_LINE,
] as const

const HTML_NAMES = ["+html.tsx", "+html.jsx", "+html.js"] as const

type Write = (rel: string, content: string) => void

/** Whether `dir`'s package.json lists `expo-router`, which is what renders `+html.tsx`. */
function usesExpoRouter(dir: string): boolean {
  const pkg = readPackageJson(dir)
  return pkg !== undefined && "expo-router" in { ...pkg.dependencies, ...pkg.devDependencies }
}

/**
 * Load `/supatype-env.js` in the `<head>` of an Expo Router app's `+html.tsx`, making the file from
 * the installed template when there is none. Does nothing for an app without Expo Router.
 */
export function scaffoldExpoRuntimeEnv(dir: string, write: Write): void {
  if (!usesExpoRouter(dir)) return
  const routes = existsSync(join(dir, "src", "app")) ? "src/app" : "app"
  const existing = HTML_NAMES.map((name) => `${routes}/${name}`).find((rel) => existsSync(join(dir, rel)))
  const rel = existing ?? `${routes}/+html.tsx`
  const source = existing === undefined ? installedHtmlTemplate(dir) : readFileSync(join(dir, existing), "utf8")
  if (source === undefined) printHtmlSteps(rel, "there is none, and no installed Expo to make it from (after installing, `npx expo customize +html.tsx` makes it)")
  else if (source.includes(SCRIPT_SRC)) file("skipped", `${rel} (already loads ${SCRIPT_SRC})`)
  else writeHtml(dir, rel, source, existing === undefined ? write : undefined)
  warnUnlessHtmlIsUsed(dir, rel)
}

/** Write `source` with the script, through `create` for a new file; or say what to add. */
function writeHtml(dir: string, rel: string, source: string, create: Write | undefined): void {
  const edited = withFirstChildren(source, "head", EXPO_RUNTIME_ENV_LINES)
  if (edited === undefined) printHtmlSteps(rel, "init could not edit it safely")
  else if (create !== undefined) create(rel, edited)
  else {
    writeFileSync(join(dir, rel), edited, "utf8")
    file("updated", `${rel} (loads ${SCRIPT_SRC} before the app)`)
  }
}

/** The `+html.tsx` template of the Expo installed for `dir`, or undefined when it cannot be read. */
function installedHtmlTemplate(dir: string): string | undefined {
  try {
    const expo = createRequire(join(dir, "package.json")).resolve("expo/package.json")
    return readFileSync(createRequire(expo).resolve("@expo/cli/static/template/+html.tsx"), "utf8")
  } catch {
    return undefined
  }
}

/** What to add by hand, and why init did not. */
function printHtmlSteps(rel: string, why: string): void {
  info(`${rel} does not load ${SCRIPT_SRC} yet: ${why}. Add this first inside its <head>:`)
  plain(`  ${SCRIPT_LINE}`)
}

/**
 * Expo renders `+html.tsx` only for `web.output` "static" or "server". With "single", the default,
 * it serves `public/index.html`, which takes the script tag instead.
 */
function warnUnlessHtmlIsUsed(dir: string, rel: string): void {
  const output = appJsonWebOutput(dir)
  if (output === undefined || output === "static" || output === "server") return
  info(`app.json's web.output is "${output}", which does not render ${rel}. Add <script src="${SCRIPT_SRC}"></script> to the <head> of public/index.html instead.`)
}

const APP_CONFIG_NAMES = ["app.config.ts", "app.config.js", "app.config.mjs", "app.config.cjs"] as const

/**
 * `expo.web.output` as `dir`'s app.json sets it, "single" when it sets none. Undefined when there is
 * no app.json, or an `app.config` that may change it: init never runs the app's code.
 */
function appJsonWebOutput(dir: string): string | undefined {
  const path = join(dir, "app.json")
  if (!existsSync(path) || APP_CONFIG_NAMES.some((name) => existsSync(join(dir, name)))) return undefined
  const parsed = parseJsonObject(readFileSync(path, "utf8"))
  const expo = parsed.ok ? parsed.value["expo"] : undefined
  const web = isJsonObject(expo) ? expo["web"] : undefined
  const output = isJsonObject(web) ? web["output"] : undefined
  return typeof output === "string" ? output : "single"
}
