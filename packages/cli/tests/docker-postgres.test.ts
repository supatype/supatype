import { describe, expect, it } from "vitest"
import {
  containerName,
  dockerPgLoopbackDbUrl,
  dockerPgPostInitServing,
} from "../src/docker-postgres.js"

describe("docker-postgres", () => {
  it("derives container name from project name", () => {
    expect(containerName("supatype-integration")).toBe("supatype-supatype-integration")
  })

  it("detects post-init serving after first-boot init", () => {
    const logs = [
      "PostgreSQL init process complete; ready for start up.",
      "database system is ready to accept connections",
    ].join("\n")
    expect(dockerPgPostInitServing(logs)).toBe(true)
  })

  it("detects post-init serving on reused volume (no init banner this run)", () => {
    const logs = "database system is ready to accept connections\n"
    expect(dockerPgPostInitServing(logs)).toBe(true)
  })

  it("builds loopback DB URL for in-container migrate", () => {
    expect(dockerPgLoopbackDbUrl("my-project")).toBe(
      "postgres://supatype_admin:postgres@127.0.0.1:5432/my-project?sslmode=disable",
    )
  })

  it("rejects ready line before init complete on first boot", () => {
    const logs = [
      "database system is ready to accept connections",
      "PostgreSQL init process complete; ready for start up.",
    ].join("\n")
    expect(dockerPgPostInitServing(logs)).toBe(false)
  })
})
