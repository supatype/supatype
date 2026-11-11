/**
 * 0.9.2 release test (N-RB3): a new Expo Router app built with `expo export --platform web` had no
 * API address or anon key at load. An Expo Router app has no `index.html`; its page comes from
 * `app/+html.tsx` (or `src/app/+html.tsx`), so that is where init puts the `/supatype-env.js` script,
 * as it does in a Vite app's `index.html` and a Next.js app's root layout.
 *
 * A missing `+html.tsx` is made from the template the app's own Expo installed (what `npx expo
 * customize +html.tsx` writes), since the template changes between SDKs: SDK 58's imports
 * `useServerDocumentContext`, which an older `expo-router/html` does not export.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { defaultScaffoldOptions, scaffold } from "../src/commands/init.js"

/** `@expo/cli`'s `static/template/+html.tsx` as SDK 58 ships it. */
const SDK58_TEMPLATE = `// Learn more https://docs.expo.dev/router/reference/static-rendering/#root-html

import { ScrollViewStyleReset, useServerDocumentContext } from 'expo-router/html';

// This file is web-only and used to configure the root HTML for every
// web page during static rendering.
// The contents of this function only run in Node.js environments and
// do not have access to the DOM or browser APIs.
export default function Root({ children }: { children: React.ReactNode }) {
  // This is only required for server-side rendering.
  const { bodyAttributes, bodyNodes, htmlAttributes, headNodes } = useServerDocumentContext();

  return (
    <html lang="en" {...htmlAttributes}>
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no" />

        {/*
          Disable body scrolling on web. This makes ScrollView components work closer to how they do on native.
          However, body scrolling is often nice to have for mobile web. If you want to enable it, remove this line.
        */}
        <ScrollViewStyleReset />

        {headNodes}

        {/* Add any additional <head> elements that you want globally available on web... */}
      </head>
      <body {...bodyAttributes}>
        {children}
        {bodyNodes}
      </body>
    </html>
  );
}
`

/** An SDK 52 app's own `+html.tsx`, with a header of its own, in CRLF as Windows checks it out. */
const OWN_HTML = [
  "import { ScrollViewStyleReset } from 'expo-router/html';",
  "import { type PropsWithChildren } from 'react';",
  "",
  "export default function Root({ children }: PropsWithChildren) {",
  "  return (",
  '    <html lang="en">',
  "      <head>",
  '        <meta charSet="utf-8" />',
  "        <ScrollViewStyleReset />",
  "      </head>",
  "      <body>{children}</body>",
  "    </html>",
  "  );",
  "}",
  "",
].join("\r\n")

/**
 * 0.9.2 release test round 2 (R2-S9): an unconditional tag made every new Expo app log a 404 and a
 * MIME error under `expo start --web`, since Metro serves no `/supatype-env.js`. In development the
 * app has its values from `.env.development.local`, so the page loads the script only when built.
 */
const SCRIPT_LINE = '{__DEV__ ? null : <script src="/supatype-env.js" />}'

let dir: string
let printed: string[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "b-init-expo-"))
  printed = []
  const record = (...args: unknown[]): void => void printed.push(args.map(String).join(" "))
  vi.spyOn(console, "log").mockImplementation(record)
  vi.spyOn(console, "warn").mockImplementation(record)
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

function put(rel: string, content: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true })
  writeFileSync(join(dir, rel), content, "utf8")
}

/** An Expo app as create-expo-app leaves it, routes in `routes`, with SDK 58's template installed. */
function expoApp(opts: { routes: "app" | "src/app"; router?: boolean; template?: boolean }): void {
  const deps = { expo: "~58.0.23", ...(opts.router === false ? {} : { "expo-router": "~58.0.30" }) }
  put("package.json", JSON.stringify({ name: "b-init-expo", main: "expo-router/entry", dependencies: deps }, null, 2))
  put(`${opts.routes}/index.tsx`, "export default function Index() { return null }\n")
  put("node_modules/expo/package.json", JSON.stringify({ name: "expo", version: "58.0.23", exports: { "./package.json": "./package.json" } }))
  if (opts.template === false) {
    // An @expo/cli that ships no template, so the lookup stops at the app's own copy. With none
    // here at all, Node goes on up the folders above the temp folder, and a template found up
    // there made this case fail on CI.
    put("node_modules/@expo/cli/package.json", JSON.stringify({ name: "@expo/cli", version: "58.1.19", exports: { "./package.json": "./package.json" } }))
    return
  }
  put(
    "node_modules/@expo/cli/package.json",
    JSON.stringify({ name: "@expo/cli", version: "58.1.19", exports: { "./static/template/*": "./static/template/*" } }),
  )
  put("node_modules/@expo/cli/static/template/+html.tsx", SDK58_TEMPLATE)
}

function read(rel: string): string {
  return readFileSync(join(dir, rel), "utf8")
}

describe("init in an Expo Router app", () => {
  it("creates src/app/+html.tsx from the installed template, loading the script first in <head>", () => {
    expoApp({ routes: "src/app" })
    scaffold(dir, defaultScaffoldOptions("b-init-expo"))
    const html = read("src/app/+html.tsx")
    const lines = html.split("\n")
    const head = lines.findIndex((line) => line.trim() === "<head>")
    expect(lines[head + 1]).toMatch(/^ {8}\{\/\*/)
    expect(lines.slice(head + 1).find((line) => line.includes("/supatype-env.js"))).toBe(`        ${SCRIPT_LINE}`)
    // Everything else is the template as Expo ships it.
    expect(html.split("\n").filter((line) => !line.includes("supatype") && !line.includes("deployment's API")).join("\n")).toBe(SDK58_TEMPLATE)
    expect(existsSync(join(dir, "app/+html.tsx"))).toBe(false)
  })

  it("uses app/ when the routes are there", () => {
    expoApp({ routes: "app" })
    scaffold(dir, defaultScaffoldOptions("b-init-expo"))
    expect(read("app/+html.tsx")).toContain(SCRIPT_LINE)
  })

  it("adds the script to an existing +html.tsx without touching the rest", () => {
    expoApp({ routes: "app" })
    put("app/+html.tsx", OWN_HTML)
    scaffold(dir, defaultScaffoldOptions("b-init-expo"))
    const after = read("app/+html.tsx")
    expect(after).toContain(`      <head>\r\n        {/*`)
    expect(after).toContain(`\r\n        ${SCRIPT_LINE}\r\n        <meta charSet="utf-8" />`)
    const kept = after.split("\r\n").filter((line) => !line.includes("supatype") && !line.includes("deployment's API"))
    expect(kept.join("\r\n")).toBe(OWN_HTML)
  })

  it("leaves a +html.tsx that already loads the script as it is", () => {
    expoApp({ routes: "app" })
    const loads = OWN_HTML.replace("<head>", `<head>\r\n        <script src="/supatype-env.js"></script>`)
    put("app/+html.tsx", loads)
    scaffold(dir, defaultScaffoldOptions("b-init-expo"))
    expect(read("app/+html.tsx")).toBe(loads)
  })

  it("prints the line to add when no template is installed to make the file from", () => {
    expoApp({ routes: "app", template: false })
    scaffold(dir, defaultScaffoldOptions("b-init-expo"))
    expect(existsSync(join(dir, "app/+html.tsx"))).toBe(false)
    expect(printed.join("\n")).toContain("npx expo customize +html.tsx")
    expect(printed.join("\n")).toContain(SCRIPT_LINE)
  })

  it("writes nothing into an Expo app without Expo Router", () => {
    expoApp({ routes: "app", router: false })
    scaffold(dir, defaultScaffoldOptions("b-init-expo"))
    expect(existsSync(join(dir, "app/+html.tsx"))).toBe(false)
  })
})
