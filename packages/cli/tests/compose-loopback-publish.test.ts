import { describe, expect, it } from "vitest"
import { renderSelfHostCompose } from "../src/self-host-compose.js"
import type { SupatypeProjectConfig } from "../src/project-config.js"
import { DENO_RELEASE_PIN } from "../src/release-pins.js"

/**
 * Fresh-user test C8: a self-host stack published Postgres, the API server and SeaweedFS on every
 * interface by default, so a server with no firewall in front of it exposed its database to the
 * internet. They are reached through Kong or from the host, so loopback is the default, and
 * `SUPATYPE_PUBLISH_ADDRESS` is the one switch that exposes them. Kong stays public: it is the
 * front door.
 */

const config: SupatypeProjectConfig = {
  project: { name: "acme" },
  database: { provider: "docker" },
  server: { mode: "dev" },
  app: { mode: "none" },
  versions: { engine: "0.4.2", server: "0.1.0", postgres: "17.2", deno: DENO_RELEASE_PIN },
}

const loopback = "${SUPATYPE_PUBLISH_ADDRESS:-127.0.0.1}:"

describe("self-host compose port publishing", () => {
  const compose = renderSelfHostCompose(config, process.cwd(), { devLocal: false })

  it("binds Postgres, the server and SeaweedFS to loopback unless told otherwise", () => {
    expect(compose).toContain(`- "${loopback}\${SUPATYPE_DB_PORT:-5432}:5432"`)
    expect(compose).toContain(`- "${loopback}\${SUPATYPE_SERVER_PORT:-9999}:9999"`)
    expect(compose).toContain(`- "${loopback}\${SUPATYPE_SEAWEEDFS_PORT:-8333}:8333"`)
  })

  it("leaves no database, server or object store port on every interface", () => {
    const published = [...compose.matchAll(/^ {6}- "([^"]+)"$/gm)].map((m) => m[1] ?? "")
    expect(published.filter((p) => /^\$\{SUPATYPE_(DB|SERVER|SEAWEEDFS)_PORT/.test(p))).toEqual([])
  })

  it("keeps the dev stack's database on 127.0.0.1", () => {
    const dev = renderSelfHostCompose(config, process.cwd(), { devLocal: true })
    expect(dev).toContain(`- "127.0.0.1:\${SUPATYPE_DEV_DB_PORT:-54329}:5432"`)
  })
})
