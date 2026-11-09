import { describe, expect, it } from "vitest"
import { buildKongDeclarative, type KongDeclarativeOptions } from "../src/kong-config.js"

/**
 * 0.9.1 release test RB2 (#298): Kong resolves "." and ".." parts and merges "//" before it routes
 * and proxies, so `/storage/v1/object/b/x/../a` reached the object "a" and `/studio/../auth/v1/...`
 * reached auth. Every Supatype route in the rendered `kong.yml` must refuse a raw path with such a
 * part, after routing, so the route that matched is the one that refuses. The app's own route is
 * left alone: what its paths mean is the app's business, and it gets them as it always did.
 *
 * Read as text (the CLI ships no YAML parser). The pattern is taken out of the rendered Lua and
 * run here as a JavaScript regex: it is written in the subset where PCRE (ngx.re) and JavaScript
 * agree, so what it matches here is what Kong matches.
 */

const LAYOUTS: { name: string; opts: KongDeclarativeOptions; app: boolean }[] = [
  { name: "self-host and dev (unified gateway)", opts: { unifiedGateway: true }, app: true },
  {
    name: "dev with Studio's dev server on the host",
    opts: { unifiedGateway: true, studioServiceUrl: "http://host.docker.internal:5173", studioStripPath: false },
    app: true,
  },
  {
    name: "self-host with automatic TLS",
    opts: { unifiedGateway: true, acme: { email: "ops@example.com", domain: "api.example.com", redisHost: "db" } },
    app: true,
  },
  { name: "split stack with an app", opts: { appUpstream: "http://app:3000", engineGatewayKey: "k" }, app: true },
  { name: "split stack without an app", opts: {}, app: false },
]

/** Raw request paths, exactly as a client can send them, that name a part of the path structure. */
const REFUSED = [
  "/storage/v1/object/b/x/../a",
  "/storage/v1/object/b/./a",
  "/storage/v1/object/b/x//a",
  "/storage/v1/object/b/x/a/..",
  "/storage/v1/object/b///a",
  "/storage/v1/object/b/%2E/a",
  "/storage/v1/object/b/%2e/a",
  "/storage/v1/object/b/x/./a",
  "/storage/v1/object/b/x/%2E%2E/a",
  "/storage/v1/object/b/x/.%2e/a",
  "/studio/../auth/v1/admin/users",
  "//rest/v1/note",
  "/rest/v1//note",
  "/x/..",
  "/.",
]

/** Paths that must still pass: names with dots in them, a trailing "/", the root. */
const ACCEPTED = [
  "/",
  "/rest/v1/",
  "/rest/v1/note",
  "/storage/v1/object/b/a.b/c",
  "/storage/v1/object/b/.hidden",
  "/storage/v1/object/b/a..b",
  "/storage/v1/object/b/...",
  "/storage/v1/object/b/x.%2E",
  // The client's spelling of the name "%2E/a" (each part encoded): a name, not a step.
  "/storage/v1/object/b/%252E/a",
  "/storage/v1/object/b/with%20space.txt",
  "/studio/models/post",
  "/realtime/v1/websocket",
]

interface RenderedRoute {
  name: string
  block: string
}

/** Each route of a rendered `kong.yml`, with the text of its block up to the next route. */
function renderedRoutes(yml: string): RenderedRoute[] {
  const start = yml.indexOf("\nservices:\n")
  const end = yml.indexOf("\nplugins:\n", start)
  return yml
    .slice(start, end === -1 ? undefined : end)
    .split(/\n(?= {6}- name: )/)
    .slice(1)
    .map((block) => ({ name: /^ {6}- name: (\S+)/.exec(block)?.[1] ?? "", block }))
}

/** Whether a route's block carries the raw path check, in the access phase (after routing). */
function guarded(route: RenderedRoute): boolean {
  return /^ {10}- name: pre-function\n {12}config:\n {14}access:\n/m.test(route.block)
}

function guardPattern(yml: string): RegExp {
  const call = /ngx\.re\.find\(path, \[\[(.+?)\]\], "(\w+)"\)/.exec(yml)
  expect(call, "an ngx.re.find on the raw path").not.toBeNull()
  expect(call?.[2]).toBe("joi")
  return new RegExp(call?.[1] ?? "", "i")
}

describe("kong.yml: a raw path with an empty, \".\" or \"..\" part is refused on every Supatype route", () => {
  for (const layout of LAYOUTS) {
    const yml = buildKongDeclarative(layout.opts)
    const routes = renderedRoutes(yml)

    it(`${layout.name}: every route but the app's carries the check, and nothing global does`, () => {
      expect(routes.length).toBeGreaterThan(5)
      expect(routes.filter((r) => r.name !== "app-root" && !guarded(r)).map((r) => r.name)).toEqual([])
      expect(routes.filter((r) => r.name === "app-root" && guarded(r)).map((r) => r.name)).toEqual([])
      expect(routes.some((r) => r.name === "app-root")).toBe(layout.app)
      expect(yml).not.toMatch(/^ {2}- name: pre-function/m)
    })
    it(`${layout.name}: each route names one plugins list`, () => {
      for (const route of routes) expect(route.block.match(/^ {8}plugins:$/gm)?.length ?? 0).toBeLessThanOrEqual(1)
    })
    it(`${layout.name}: reads the raw path and answers 400`, () => {
      expect(yml).toContain("local path = kong.request.get_raw_path()")
      expect(yml).toContain("kong.response.exit(400,")
    })
    it.each(REFUSED)(`${layout.name}: refuses %s`, (path) => {
      expect(guardPattern(yml).test(path)).toBe(true)
    })
    it.each(ACCEPTED)(`${layout.name}: lets %s through`, (path) => {
      expect(guardPattern(yml).test(path)).toBe(false)
    })
  }

  it("keeps the engine key check and the GraphQL header beside the guard", () => {
    const routes = renderedRoutes(buildKongDeclarative({ engineGatewayKey: "k" }))
    const sql = routes.find((r) => r.name === "sql-route")
    const graphql = routes.find((r) => r.name === "graphql-v1")
    expect(sql?.block).toMatch(/^ {10}- name: key-auth$/m)
    expect(graphql?.block).toMatch(/^ {10}- name: request-transformer$/m)
    expect(sql !== undefined && guarded(sql)).toBe(true)
    expect(graphql !== undefined && guarded(graphql)).toBe(true)
  })

  it("keeps the automatic TLS plugin global", () => {
    const yml = buildKongDeclarative({ unifiedGateway: true, acme: { email: "a@b.c", domain: "d.e", redisHost: "db" } })
    expect(yml).toMatch(/\nplugins:\n {2}- name: acme\n/)
  })
})
