import { describe, expect, it } from "vitest"
import { appPanelLinks } from "../src/app/proxy-dev-app.js"
import type { SupatypeProjectConfig } from "../src/project-config.js"

/**
 * 0.9.2 release test round 2 (docs pass): a project whose app Supatype serves as static files had
 * no App link in the dev panel, only a proxied one did, and native dev listed none at all.
 */
function withApp(app: SupatypeProjectConfig["app"]): SupatypeProjectConfig {
  return { project: { name: "acme" }, database: { provider: "docker" }, server: { mode: "dev" }, app }
}

describe("the dev panel's App link", () => {
  it.each([
    ["static", { mode: "static", static_dir: "./dist" }],
    ["proxy", { mode: "proxy", upstream: "http://127.0.0.1:5173" }],
  ] as const)("is listed for an app served as %s", (_, app) => {
    expect(appPanelLinks(withApp(app), "http://localhost:18400")).toEqual([{ label: "App", url: "http://localhost:18400/" }])
  })

  it("is not listed with no app", () => {
    expect(appPanelLinks(withApp({ mode: "none" }), "http://localhost:18400")).toEqual([])
  })
})
