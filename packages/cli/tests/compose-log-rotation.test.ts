import { describe, expect, it } from "vitest"
import { renderSelfHostCompose } from "../src/self-host-compose.js"
import { validateProjectConfig, type SupatypeProjectConfig } from "../src/project-config.js"
import { DENO_RELEASE_PIN } from "../src/release-pins.js"
import { composeServiceBlocks } from "./support/compose-services.js"

/**
 * 0.9.1 release test RB8: the compose file set no logging options, so every container logged to
 * Docker's default driver with no limit. On a Linux server that is `json-file`, which never
 * rotates, and an idle stack's Postgres alone wrote about 0.8 GB a day. The disk fills and the
 * database stops. Every service now names a rotating log, sized from `.env`.
 */

const base = {
  project: { name: "acme" },
  server: { mode: "dev" as const },
  app: { mode: "none" as const },
  versions: { engine: "0.4.2", server: "0.1.0", postgres: "17.2", deno: DENO_RELEASE_PIN },
}

const project = (extra: Record<string, unknown>): SupatypeProjectConfig =>
  validateProjectConfig({ database: { provider: "docker" }, ...base, ...extra }, "supatype.config.ts")

const VARIANTS: Array<[string, SupatypeProjectConfig, boolean]> = [
  ["docker dev", project({}), true],
  ["self-host", project({}), false],
  ["self-host with a valkey sidecar", project({ cache: { provider: "valkey" } }), false],
  ["self-host with the keyspace in postgres", project({ cache: { provider: "pg_keyspace" } }), false],
  [
    "an external database without realtime",
    project({ database: { external: { url: "postgres://o:p@db.example.com:5432/app", realtime: false } } }),
    false,
  ],
  ["docker dev with a host studio", project({ overrides: { studio: "../studio" } }), true],
]

describe("container log rotation", () => {
  for (const [label, config, devLocal] of VARIANTS) {
    describe(label, () => {
      const compose = renderSelfHostCompose(config, process.cwd(), { devLocal })

      it("defines one rotating json-file log, sized from .env", () => {
        expect(compose).toContain(
          [
            "x-logging: &default-logging",
            "  driver: json-file",
            "  options:",
            '    max-size: "${SUPATYPE_LOG_MAX_SIZE:-10m}"',
            '    max-file: "${SUPATYPE_LOG_MAX_FILE:-5}"',
          ].join("\n"),
        )
      })

      it("gives it to every service", () => {
        const found = composeServiceBlocks(compose)
        expect(found.size, "no services parsed").toBeGreaterThan(5)
        for (const [name, block] of found) {
          expect(block, `${name} has no logging options`).toContain("    logging: *default-logging")
        }
      })
    })
  }
})
