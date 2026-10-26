import { afterEach, describe, expect, it } from "vitest"
import { devSessionLockFor } from "../src/dev-session-lock.js"
import { applyProjectNameOverride, PROJECT_NAME_ENV } from "../src/project-name-override.js"
import type { SupatypeProjectConfig } from "../src/project-config.js"

// `.supatype/dev-session.json` names the project as well as the compose project. Under
// `--project-name` / SUPATYPE_PROJECT_NAME it recorded the run's name as the project's, the one
// place left that did after `environment.json` was fixed, so the two disagreed about which project
// the directory holds.

const saved = process.env[PROJECT_NAME_ENV]
afterEach(() => {
  if (saved === undefined) delete process.env[PROJECT_NAME_ENV]
  else process.env[PROJECT_NAME_ENV] = saved
})

const stack = { composeProject: "supatype-run-b", composePath: "/p/.supatype/self-host/docker-compose.yml", kongPort: 18473 }

describe("the dev session record", () => {
  it("names the project in the config, under a run's own name", () => {
    process.env[PROJECT_NAME_ENV] = "run-b"
    const config = applyProjectNameOverride({ project: { name: "acme" } } as SupatypeProjectConfig)
    const lock = devSessionLockFor(config, stack, new Date(0))
    expect(lock.projectRef).toBe("acme")
    expect(lock.composeProject).toBe("supatype-run-b")
  })

  it("names the project when no run name is set", () => {
    delete process.env[PROJECT_NAME_ENV]
    const lock = devSessionLockFor({ project: { name: "acme" } } as SupatypeProjectConfig, stack, new Date(0))
    expect(lock).toEqual({ ...stack, projectRef: "acme", startedAt: "1970-01-01T00:00:00.000Z" })
  })
})
