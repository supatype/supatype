/**
 * 0.9.2 release test round 2 (N-S15, frameworks RB9): init kept an app's own `index.html` and printed
 * only "skipped index.html (already exists)". A page Supatype serves reads its API address and anon
 * key from `/supatype-env.js`, so a production build of that page threw MissingClientValuesError
 * until the developer found the tag in the docs. Init now says to add it, unless the page has it.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { defaultScaffoldOptions, scaffold, type ScaffoldOptions } from "../src/commands/init.js"

const TAG = '<script src="/supatype-env.js" vite-ignore></script>'
const VITE_PAGE = '<!doctype html>\n<html>\n  <head>\n    <title>shop</title>\n  </head>\n  <body><div id="app"></div></body>\n</html>\n'

let dir: string
let printed: string[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "b-init-index-html-"))
  printed = []
  const record = (...args: unknown[]): void => void printed.push(args.map(String).join(" "))
  vi.spyOn(console, "log").mockImplementation(record)
  vi.spyOn(console, "warn").mockImplementation(record)
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

/** A Vite app whose build Supatype serves, with `page` as its own `index.html`. */
function scaffoldViteApp(page: string, app: Partial<ScaffoldOptions["app"]> = {}): string {
  writeFileSync(join(dir, "index.html"), page, "utf8")
  writeFileSync(join(dir, "vite.config.ts"), "export default {}\n", "utf8")
  const options = defaultScaffoldOptions("shop")
  scaffold(dir, { ...options, app: { mode: "static", staticDir: "./dist", viteDevUrl: "http://localhost:5173", ...app } })
  return printed.join("\n")
}

describe("init with an app's own index.html", () => {
  it("says to add the /supatype-env.js tag to the page's head", () => {
    const out = scaffoldViteApp(VITE_PAGE)
    expect(out).toContain("skipped  index.html (already exists)")
    expect(out).toContain(`add ${TAG} to its <head>`)
  })

  it("says nothing more when the page already loads the script", () => {
    const out = scaffoldViteApp(VITE_PAGE.replace("</head>", `  ${TAG}\n  </head>`))
    expect(out).toContain("skipped  index.html (already exists)")
    expect(out).not.toContain("supatype-env.js")
  })

  it("says nothing for an app its own server serves, which never answers the script", () => {
    const out = scaffoldViteApp(VITE_PAGE, { mode: "proxy", upstream: "http://localhost:5173" })
    expect(out).toContain("skipped  index.html (already exists)")
    expect(out).not.toContain("supatype-env.js")
  })
})
