import { describe, expect, it } from "vitest"
import { targetFunctions, type DeployTarget } from "../src/resolve-target.js"
import type { ProjectLink } from "../src/link.js"

/**
 * A Cloud project's functions are served on the environment's own URL, which the link records from
 * the control plane. The invoke address used to be built from a fixed host, so any environment not
 * on that host (a self-run Cloud, a local one) was told a URL that does not answer.
 */
const CLOUD_API = "https://api.cloud.example.test"

function cloudTarget(environments: ProjectLink["environments"], environment = "production"): DeployTarget {
  const link: ProjectLink = {
    version: 1,
    kind: "cloud",
    projectRef: "ref123",
    defaultEnvironment: "production",
    cloudApiUrl: CLOUD_API,
    environments,
  }
  return { mode: "cloud", environment, projectRef: "ref123", apiBaseUrl: CLOUD_API, apiPrefix: "/api/v1", token: "tok", link }
}

const env = (name: string, apiUrl: string): ProjectLink["environments"][string] => ({ name, apiUrl, linkedAt: "2026-11-01T00:00:00Z" })

describe("a Cloud project's invoke URL", () => {
  it("comes from the environment URL the link holds", () => {
    const target = cloudTarget({ production: env("production", "http://ref123.lvh.me:18680") })
    expect(targetFunctions(target).invokeBase).toBe("http://ref123.lvh.me:18680/functions/v1")
  })

  it("follows the environment the command is aimed at", () => {
    const target = cloudTarget(
      { production: env("production", "https://ref123.supatype.dev"), staging: env("staging", "https://ref123-staging.supatype.dev/") },
      "staging",
    )
    expect(targetFunctions(target).invokeBase).toBe("https://ref123-staging.supatype.dev/functions/v1")
  })

  it("falls back to the project's supatype.dev host when the link holds only the control plane URL", () => {
    const target = cloudTarget({ production: env("production", CLOUD_API) })
    expect(targetFunctions(target).invokeBase).toBe("https://ref123.supatype.dev/functions/v1")
  })

  it("falls back the same way when the link names no such environment", () => {
    const target = cloudTarget({}, "production")
    expect(targetFunctions(target).invokeBase).toBe("https://ref123.supatype.dev/functions/v1")
  })
})
