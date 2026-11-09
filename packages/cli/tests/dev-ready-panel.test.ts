import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { devReadyPanelCompactRowCount, devReadyPanelRowCount, publishDevReady } from "../src/dev-ready-panel.js"
import { secretFingerprint } from "../src/local-secrets.js"

describe("devReadyPanelRowCount", () => {
  it("accounts for border, keys block, and hints", () => {
    const rows = devReadyPanelRowCount({
      title: "Services running",
      links: [
        { label: "API", url: "http://localhost:1" },
        { label: "Studio", url: "http://localhost:1/studio/" },
      ],
      hints: ["Demo data: pnpm seed"],
      anonKey: "anon-jwt",
      serviceRoleKeyNote: "#00000000 (SERVICE_ROLE_KEY in .env)",
    })

    // border(2) + title(1) + links(2) + hint(1) + keys header(1) + anon(1) + svc(1) + margin(1)
    expect(rows).toBe(10)
  })
})

describe("devReadyPanelCompactRowCount", () => {
  it("uses a shorter layout than the full panel", () => {
    const panel = {
      title: "Services running",
      links: [
        { label: "API", url: "http://localhost:1" },
        { label: "REST", url: "http://localhost:1/rest/v1/" },
        { label: "Studio", url: "http://localhost:1/studio/" },
      ],
      hints: ["Demo data: pnpm seed"],
      anonKey: "anon-jwt",
      serviceRoleKeyNote: "#00000000 (SERVICE_ROLE_KEY in .env)",
    }
    expect(devReadyPanelCompactRowCount(panel)).toBeLessThan(devReadyPanelRowCount(panel))
  })
})

/**
 * 0.9.1 release test (FF17, S37): the ready panel printed the Postgres password in its connection
 * string and the whole service_role key, so both landed in every CI log that ran `dev`.
 */
describe("publishDevReady", () => {
  const serviceRoleKey = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2VydmljZS1zaWduYXR1cmU"
  const password = "s3cretPassw0rd"
  let dir: string
  let printed: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "supatype-ready-panel-"))
    printed = ""
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      printed += `${args.map(String).join(" ")}\n`
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  function publish(): void {
    publishDevReady({
      cwd: dir,
      title: "Services running",
      links: [{ label: "API", url: "http://localhost:1" }],
      anonKey: "anon-jwt",
      serviceRoleKey,
      databaseUrl: `postgres://postgres:${password}@127.0.0.1:55432/app?sslmode=disable`,
    })
  }

  it("masks the Postgres password the way status does", () => {
    publish()
    expect(printed).not.toContain(password)
    expect(printed).toContain("Postgres postgres://postgres:***@127.0.0.1:55432/app?sslmode=disable")
  })

  it("prints a fingerprint of the service_role key, never the key", () => {
    writeFileSync(join(dir, ".env"), `SERVICE_ROLE_KEY=${serviceRoleKey}\n`)
    publish()
    expect(printed).not.toContain(serviceRoleKey)
    expect(printed).not.toContain(serviceRoleKey.split(".")[2])
    expect(printed).toContain(`#${secretFingerprint(serviceRoleKey)} (SERVICE_ROLE_KEY in .env)`)
    expect(printed).toContain("anon-jwt")
  })

  it("names the file native dev keeps the key in when .env holds another", () => {
    writeFileSync(join(dir, ".env"), "SERVICE_ROLE_KEY=an-older-key\n")
    publish()
    expect(printed).not.toContain(serviceRoleKey)
    expect(printed).toContain(`#${secretFingerprint(serviceRoleKey)} (in .supatype/service-role-key while dev runs)`)
  })
})
