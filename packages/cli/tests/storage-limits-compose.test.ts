import { describe, expect, it } from "vitest"
import { renderSelfHostCompose } from "../src/self-host-compose.js"
import { validateProjectConfig, type SupatypeProjectConfig } from "../src/project-config.js"
import { DENO_RELEASE_PIN } from "../src/release-pins.js"

/**
 * A self-hosted project has no plan, so its storage has no quota and no per-file limit unless
 * `.env` sets one. The storage service on its own defaults to the free tier's 1 GiB and 50 MB,
 * which a compose that passed nothing through gave every self-hosted and local project.
 */
const config = (): SupatypeProjectConfig =>
  validateProjectConfig(
    {
      project: { name: "acme" },
      server: { mode: "standalone" as const },
      app: { mode: "none" as const },
      database: { provider: "docker" as const },
      versions: { postgres: "17.2", deno: DENO_RELEASE_PIN },
    },
    "supatype.config.ts",
  )

/** The storage service's environment lines, trimmed. */
function storageEnv(compose: string): string[] {
  const block = /^ {2}storage:\n([\s\S]*?)(?=^ {2}[a-z][a-z-]*:\n)/m.exec(compose)?.[1] ?? ""
  return block.split("\n").map((line) => line.trim())
}

const PASSTHROUGHS = [
  "PROJECT_TIER: ${PROJECT_TIER:-enterprise}",
  "STORAGE_QUOTA: ${STORAGE_QUOTA:--1}",
  "TIER_MAX_UPLOAD_SIZE: ${TIER_MAX_UPLOAD_SIZE:--1}",
  "MAX_UPLOAD_SIZE: ${MAX_UPLOAD_SIZE:--1}",
]

describe("storage limits in the compose file", () => {
  it("are unlimited by default and read from .env on self-host", () => {
    expect(storageEnv(renderSelfHostCompose(config()))).toEqual(expect.arrayContaining(PASSTHROUGHS))
  })

  it("are the same for the local dev stack", () => {
    const dev = renderSelfHostCompose(config(), process.cwd(), { devLocal: true })
    expect(storageEnv(dev)).toEqual(expect.arrayContaining(PASSTHROUGHS))
  })
})
