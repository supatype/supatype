import { describe, expect, it } from "vitest"
import { renderSelfHostCompose } from "../src/self-host-compose.js"
import { validateProjectConfig, type SupatypeProjectConfig } from "../src/project-config.js"
import { DENO_RELEASE_PIN } from "../src/release-pins.js"

/**
 * 0.9.2, Nic's decision: a project whose production storage is its own S3 bucket
 * (`storage.production: "s3"`, which init writes from its "Production storage?" answer) self-hosts
 * with the storage service in single-bucket mode on that bucket, and no SeaweedFS. The compose
 * file used to run SeaweedFS for every project and never read the project's S3 settings at all.
 * The Docker dev stack comes from the same generator and keeps SeaweedFS: dev is not production.
 */
const config = (storage?: SupatypeProjectConfig["storage"]): SupatypeProjectConfig =>
  validateProjectConfig(
    {
      project: { name: "acme" },
      server: { mode: "standalone" as const },
      app: { mode: "none" as const },
      database: { provider: "docker" as const },
      versions: { postgres: "17.2", deno: DENO_RELEASE_PIN },
      ...(storage !== undefined && { storage }),
    },
    "supatype.config.ts",
  )

/** The storage service's block, its lines trimmed. */
function storageLines(compose: string): string[] {
  const block = /^ {2}storage:\n([\s\S]*?)(?=^ {2}[a-z][a-z-]*:\n)/m.exec(compose)?.[1] ?? ""
  return block.split("\n").map((line) => line.trim())
}

const ON_S3 = config({ provider: "local", production: "s3" })

describe("self-host compose for a project whose production storage is S3", () => {
  it("runs the storage service on the project's bucket, requiring S3_BUCKET from .env", () => {
    const lines = storageLines(renderSelfHostCompose(ON_S3))
    expect(lines).toContain('S3_BUCKET: "${S3_BUCKET:?S3_BUCKET is missing from .env, and storage.production is s3 in supatype.config.ts}"')
    for (const name of ["S3_REGION", "S3_ENDPOINT", "S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_FORCE_PATH_STYLE", "S3_PUBLIC_URL"]) {
      expect(lines).toContain(`${name}: "\${${name}:-}"`)
    }
    expect(lines.join("\n")).not.toContain("seaweedfs")
  })

  it("leaves SeaweedFS and its volume out of the stack", () => {
    const compose = renderSelfHostCompose(ON_S3)
    expect(compose).not.toMatch(/^ {2}seaweedfs:/m)
    expect(compose).not.toMatch(/^ {2}storage-data:/m)
  })

  it("keeps SeaweedFS in the Docker dev stack, which follows the dev setting", () => {
    const compose = renderSelfHostCompose(ON_S3, process.cwd(), { devLocal: true })
    expect(compose).toMatch(/^ {2}seaweedfs:/m)
    expect(storageLines(compose)).toContain("S3_ENDPOINT: http://seaweedfs:8333")
  })

  it("is unchanged for a project that names no production storage, or names local", () => {
    const before = renderSelfHostCompose(config())
    expect(before).toMatch(/^ {2}seaweedfs:/m)
    expect(storageLines(before)).toContain("S3_ENDPOINT: http://seaweedfs:8333")
    expect(renderSelfHostCompose(config({ provider: "s3", production: "local" }))).toBe(renderSelfHostCompose(config({ provider: "s3" })))
  })
})
