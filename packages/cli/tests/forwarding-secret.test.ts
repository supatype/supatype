import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { buildKongDeclarative, type KongDeclarativeOptions } from "../src/kong-config.js"
import { ensureForwardingSecret, FORWARDING_SECRET_ENV } from "../src/local-secrets.js"
import { renderSelfHostCompose } from "../src/self-host-compose.js"
import { validateProjectConfig, type SupatypeProjectConfig } from "../src/project-config.js"
import { DENO_RELEASE_PIN } from "../src/release-pins.js"

/**
 * D14 option 2b: the auth server believes a forwarded end-user address only on a request that
 * carries a secret held by our own components. Kong removes whatever a client sent under the two
 * forwarding headers on every route and adds the secret on requests to the server; the compose file
 * hands the one per-project secret to the server, Kong and the functions worker, and to nothing else.
 */
const LAYOUTS: { name: string; opts: KongDeclarativeOptions }[] = [
  { name: "unified gateway", opts: { unifiedGateway: true } },
  { name: "unified gateway, Studio on the host", opts: { unifiedGateway: true, studioServiceUrl: "http://host.docker.internal:5173", studioStripPath: false } },
  { name: "split stack with an app", opts: { appUpstream: "http://app:3000", engineGatewayKey: "k" } },
]

interface RenderedRoute {
  name: string
  url: string
  block: string
}

function renderedRoutes(yml: string): RenderedRoute[] {
  const start = yml.indexOf("\nservices:\n")
  const end = yml.indexOf("\nplugins:\n", start)
  return yml
    .slice(start, end === -1 ? undefined : end)
    .split(/\n(?= {2}- name: )/)
    .slice(1)
    .map((block) => ({
      name: /^ {6}- name: (\S+)/m.exec(block)?.[1] ?? "",
      url: /^ {4}url: (\S+)$/m.exec(block)?.[1] ?? "",
      block,
    }))
}

const clears = (r: RenderedRoute, header: string): boolean => r.block.includes(`clear_header("${header}")`)
const setsSecret = (r: RenderedRoute): boolean => r.block.includes(`set_header("St-Forwarding-Secret"`)

describe("Kong forwarding headers", () => {
  it.each(LAYOUTS)("removes both headers a client sent on every route ($name)", ({ opts }) => {
    const routes = renderedRoutes(buildKongDeclarative(opts))
    expect(routes.length).toBeGreaterThan(5)
    for (const route of routes) {
      expect(clears(route, "St-Forwarded-For"), route.name).toBe(true)
      expect(clears(route, "St-Forwarding-Secret"), route.name).toBe(true)
    }
  })

  it("adds the secret, by vault reference, on every route to the server and on no other", () => {
    const routes = renderedRoutes(buildKongDeclarative({ unifiedGateway: true }))
    const toServer = routes.filter((r) => r.url === "http://server:9999")
    expect(toServer.length).toBeGreaterThan(5)
    for (const route of routes) expect(setsSecret(route), route.name).toBe(route.url === "http://server:9999")
    const yml = buildKongDeclarative({ unifiedGateway: true })
    expect(yml).toContain("{vault://env/supatype-forwarding-secret}")
  })

  it("strips before adding, so the client's value never survives", () => {
    const route = renderedRoutes(buildKongDeclarative({ unifiedGateway: true })).find((r) => r.name === "auth-v1")!
    expect(route.block.indexOf('clear_header("St-Forwarding-Secret")')).toBeLessThan(
      route.block.indexOf('set_header("St-Forwarding-Secret"'),
    )
  })
})

const config = (mode: "standalone" | "dev"): SupatypeProjectConfig =>
  validateProjectConfig(
    {
      project: { name: "acme" },
      server: { mode },
      app: { mode: "none" as const },
      database: { provider: "docker" as const },
      versions: { postgres: "17.2", deno: DENO_RELEASE_PIN },
    },
    "supatype.config.ts",
  )

function serviceBlock(compose: string, service: string): string {
  const lines = compose.split("\n")
  const start = lines.indexOf(`  ${service}:`)
  if (start === -1) return ""
  const after = lines.slice(start + 1)
  const end = after.findIndex((l) => /^( {2}[a-z][a-z-]*:|volumes:|networks:)/.test(l))
  return after.slice(0, end === -1 ? undefined : end).join("\n")
}

describe("compose forwarding secret", () => {
  it.each(["standalone", "dev"] as const)("gives it to the server, Kong and the worker only (%s)", (mode) => {
    const compose = renderSelfHostCompose(config(mode))
    const ref = "${SUPATYPE_FORWARDING_SECRET:?SUPATYPE_FORWARDING_SECRET is missing from .env}"
    expect(serviceBlock(compose, "server")).toContain(`SUPATYPE_SECURITY_FORWARDING_SECRET: ${ref}`)
    expect(serviceBlock(compose, "kong")).toContain(`SUPATYPE_FORWARDING_SECRET: ${ref}`)
    expect(serviceBlock(compose, "functions-worker")).toContain(`SUPATYPE_FORWARDING_SECRET: ${ref}`)
    const given = compose.split("\n").filter((l) => l.trim().startsWith("SUPATYPE_FORWARDING_SECRET:"))
    expect(given).toHaveLength(2)
  })
})

describe("Kong worker listener (port 8100)", () => {
  const listenOf = (compose: string): string => /KONG_PROXY_LISTEN: "([^"]+)"/.exec(serviceBlock(compose, "kong"))?.[1] ?? ""

  it.each(["standalone", "dev"] as const)("is listened on and never published (%s)", (mode) => {
    const compose = renderSelfHostCompose(config(mode))
    expect(listenOf(compose)).toContain("0.0.0.0:8100")
    expect(listenOf(compose)).toContain("0.0.0.0:8000")
    const ports = serviceBlock(compose, "kong").split("\n").filter((l) => /^\s+- "[^"]+:\d+"/.test(l))
    expect(ports.length).toBeGreaterThan(0)
    for (const line of ports) expect(line).not.toMatch(/8100/)
  })

  it("is listened on and never published with TLS", () => {
    const tls = validateProjectConfig(
      {
        project: { name: "acme" },
        server: { mode: "standalone", domain: "api.example.com", tls: { email: "ops@example.com" } },
        app: { mode: "none" as const },
        database: { provider: "docker" as const },
        versions: { postgres: "17.2", deno: DENO_RELEASE_PIN },
      },
      "supatype.config.ts",
    )
    const compose = renderSelfHostCompose(tls)
    expect(listenOf(compose)).toBe("0.0.0.0:8000, 0.0.0.0:8100, 0.0.0.0:8443 ssl")
    expect(serviceBlock(compose, "kong")).not.toMatch(/"\d+:8100"/)
  })

  it.each(["standalone", "dev"] as const)("is the only address the worker is given for the stack (%s)", (mode) => {
    const block = serviceBlock(renderSelfHostCompose(config(mode)), "functions-worker")
    expect(block).toContain("SUPATYPE_URL: http://kong:8100")
    expect(block).toContain("SUPATYPE_INTERNAL_URL: http://kong:8100")
    expect(block).not.toContain("kong:8000")
  })

  it.each(LAYOUTS)("keeps the headers and adds no secret on 8100, and still strips and adds on 8000 ($name)", ({ opts }) => {
    const routes = renderedRoutes(buildKongDeclarative(opts))
    for (const route of routes) {
      for (const step of route.block.split("- |").slice(1)) {
        if (step.includes("clear_header") || step.includes("set_header(\"St-Forwarding-Secret\"")) {
          // Both steps run only off the worker listener, so 8000 still strips and adds.
          expect(step, route.name).toContain("if tonumber(ngx.var.server_port) ~= 8100 then")
        }
      }
      expect(clears(route, "St-Forwarded-For"), route.name).toBe(true)
      // The path guard is not behind the port check, so it runs on 8100 too.
      if (route.block.includes("get_raw_path")) {
        const guard = route.block.split("- |").find((s) => s.includes("get_raw_path")) ?? ""
        expect(guard, route.name).not.toContain("server_port")
      }
    }
  })
})

describe("ensureForwardingSecret", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it("generates one into .env, and keeps it on every later call", () => {
    const dir = mkdtempSync(join(tmpdir(), "fwd-secret-"))
    dirs.push(dir)
    writeFileSync(join(dir, ".env"), "JWT_SECRET=abc\n")
    ensureForwardingSecret(dir)
    const first = /^SUPATYPE_FORWARDING_SECRET=(.+)$/m.exec(readFileSync(join(dir, ".env"), "utf8"))?.[1]
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/)
    ensureForwardingSecret(dir)
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain(`${FORWARDING_SECRET_ENV}=${first}`)
    expect(readFileSync(join(dir, ".env"), "utf8").match(/SUPATYPE_FORWARDING_SECRET=/g)).toHaveLength(1)
  })
})
