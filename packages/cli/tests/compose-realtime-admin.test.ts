import { describe, expect, it } from "vitest"
import { renderSelfHostCompose } from "../src/self-host-compose.js"
import type { SupatypeProjectConfig } from "../src/project-config.js"
import { DENO_RELEASE_PIN } from "../src/release-pins.js"

/**
 * The Realtime Inspector's wiring on a self-host stack: realtime opens its admin listener on 4001,
 * and only the control plane is told where it is and given the key it answers to.
 *
 * The gateway routes every path under `/realtime/v1` to realtime's port 4000. The admin API is a
 * separate port so that nothing routes to it: not published to the host, and not named to the
 * server.
 */

const base: SupatypeProjectConfig = {
  project: { name: "acme" },
  database: { provider: "docker" },
  server: { mode: "dev" },
  app: { mode: "none" },
  versions: { engine: "0.4.2", server: "0.1.0", postgres: "17.2", deno: DENO_RELEASE_PIN },
}

const realtimeOff: SupatypeProjectConfig = {
  ...base,
  database: { provider: "docker", external: { url: "postgresql://u:p@db.example.test:5432/app", realtime: false } },
}

/** One service's block, ending at the next service or at a top-level key. */
function serviceBlock(compose: string, name: string): string {
  const lines = compose.split("\n")
  const start = lines.indexOf(`  ${name}:`)
  if (start === -1) return ""
  const after = lines.slice(start + 1).findIndex((l) => /^ {2}[a-z][a-z0-9-]*:$/.test(l) || /^[a-z]/.test(l))
  return lines.slice(start, after === -1 ? lines.length : start + 1 + after).join("\n")
}

/** Every entry of every `ports:` list in the file. */
function publishedPorts(compose: string): string[] {
  const lines = compose.split("\n")
  const ports: string[] = []
  lines.forEach((line, i) => {
    if (!/^ {4}ports:$/.test(line)) return
    for (const entry of lines.slice(i + 1)) {
      const match = /^ {6}- (.+)$/.exec(entry)
      if (!match?.[1]) break
      ports.push(match[1])
    }
  })
  return ports
}

describe("the realtime admin listener", () => {
  const compose = renderSelfHostCompose(base, process.cwd())

  it("is opened on 4001 inside the stack", () => {
    const realtime = serviceBlock(compose, "realtime")
    expect(realtime).toContain('ADMIN_PORT: "4001"')
    expect(realtime).toMatch(/expose:\n(?: {6}- "\d+"\n)*? {6}- "4001"/)
  })

  it("is not published to the host", () => {
    expect(publishedPorts(compose).some((p) => p.includes("4001"))).toBe(false)
  })

  it("is named to the control plane, with the key realtime verifies", () => {
    const controlPlane = serviceBlock(compose, "control-plane")
    expect(controlPlane).toContain("REALTIME_ADMIN_URL: http://realtime:4001")
    expect(controlPlane).toMatch(/SUPATYPE_SERVICE_ROLE_KEY: \$\{SERVICE_ROLE_KEY:\?[^}]+\}/)
  })

  it("is named to nothing else", () => {
    for (const service of ["server", "kong", "functions-worker", "studio"]) {
      expect(serviceBlock(compose, service)).not.toContain(":4001")
    }
  })

  it("sets no connection limit on self-host", () => {
    expect(compose).not.toContain("CONNECTION_LIMIT")
  })
})

describe("with realtime turned off", () => {
  const compose = renderSelfHostCompose(realtimeOff, process.cwd())

  it("tells the control plane nothing about realtime, so it answers 501", () => {
    const controlPlane = serviceBlock(compose, "control-plane")
    expect(controlPlane).not.toContain("REALTIME_ADMIN_URL")
    expect(controlPlane).toMatch(/SUPATYPE_SERVICE_ROLE_KEY:/)
  })
})
