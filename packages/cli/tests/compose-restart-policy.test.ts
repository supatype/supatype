import { describe, expect, it } from "vitest"
import { renderSelfHostCompose } from "../src/self-host-compose.js"
import { validateProjectConfig, type SupatypeProjectConfig } from "../src/project-config.js"
import { DENO_RELEASE_PIN } from "../src/release-pins.js"
import { composeServiceBlocks } from "./support/compose-services.js"

/**
 * 0.9.2 release test (N-FF11): only `server` had a restart policy. A storage service that refused its
 * S3 settings exited 1 with policy `no` and stayed down, and a service that failed on a transient
 * error (a store or database not answering yet) never came back. Every long-running service now
 * restarts on failure, bounded as the server's always was, so a real misconfiguration still ends
 * exited, with its reason in its log, instead of looping for ever. A one-shot tool is never
 * restarted.
 */

const base = {
  project: { name: "acme" },
  server: { mode: "standalone" as const },
  app: { mode: "none" as const },
  versions: { engine: "0.4.2", server: "0.1.0", postgres: "17.2", deno: DENO_RELEASE_PIN },
}

const project = (extra: Record<string, unknown>): SupatypeProjectConfig =>
  validateProjectConfig({ database: { provider: "docker" }, ...base, ...extra }, "supatype.config.ts")

const VARIANTS: Array<[string, SupatypeProjectConfig, boolean]> = [
  ["self-host", project({}), false],
  ["self-host on the project's own S3 bucket", project({ storage: { provider: "local", production: "s3" } }), false],
  ["self-host with a valkey sidecar", project({ cache: { provider: "valkey" } }), false],
  ["docker dev", project({}), true],
]

/** Services that run once and exit, which a restart policy would rerun. */
const ONE_SHOT = new Set(["schema-engine"])

const RESTART = "    restart: on-failure:5"

describe("restart policies", () => {
  for (const [label, config, devLocal] of VARIANTS) {
    describe(label, () => {
      const found = composeServiceBlocks(renderSelfHostCompose(config, process.cwd(), { devLocal }))

      it("restarts every long-running service on failure, a bounded number of times", () => {
        expect(found.size, "no services parsed").toBeGreaterThan(5)
        expect([...found.keys()]).toContain("storage")
        for (const [name, block] of found) {
          if (ONE_SHOT.has(name)) continue
          expect(block, `${name} has no restart policy`).toContain(RESTART)
          expect(block.filter((line) => line.trim().startsWith("restart:")), `${name} has two`).toHaveLength(1)
        }
      })

      it("never restarts a one-shot tool", () => {
        for (const name of ONE_SHOT) {
          expect(found.get(name)?.some((line) => line.trim().startsWith("restart:")), name).toBe(false)
        }
      })
    })
  }
})
