import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { scaffold } from "../src/commands/init.js"

let tmpRoot: string

beforeEach(() => {
  tmpRoot = join(tmpdir(), `dt-init-test-${Date.now()}`)
  mkdirSync(tmpRoot, { recursive: true })
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe("scaffold()", () => {
  it("creates all expected files", () => {
    scaffold(tmpRoot, "my-app")

    const expected = [
      "supatype.config.ts",
      "schema/index.ts",
      ".env",
      "docker-compose.yml",
      ".supatype/kong.yml",
      "seed.ts",
      ".gitignore",
    ]
    for (const rel of expected) {
      expect(existsSync(join(tmpRoot, rel)), `${rel} should exist`).toBe(true)
    }
  })

  it("supatype.config.ts embeds the project name and exports defineConfig", () => {
    scaffold(tmpRoot, "blog-app")
    const content = readFileSync(join(tmpRoot, "supatype.config.ts"), "utf8")
    expect(content).toContain("blog-app")
    expect(content).toContain("defineConfig")
    expect(content).toContain("schema:")
    expect(content).toContain("output:")
  })

  it("docker-compose.yml references project name, correct images, and health check", () => {
    scaffold(tmpRoot, "shop")
    const content = readFileSync(join(tmpRoot, "docker-compose.yml"), "utf8")
    expect(content).toContain("shop")
    expect(content).toContain("supabase/postgres")
    expect(content).toContain("postgrest/postgrest")
    expect(content).toContain("kong:")
    expect(content).toContain("service_healthy")
  })

  it(".env contains DATABASE_URL, JWT_SECRET, POSTGRES_PASSWORD, POSTGRES_DB", () => {
    scaffold(tmpRoot, "my-app")
    const content = readFileSync(join(tmpRoot, ".env"), "utf8")
    expect(content).toContain("DATABASE_URL=")
    expect(content).toContain("JWT_SECRET=")
    expect(content).toContain("POSTGRES_PASSWORD=")
    expect(content).toContain("POSTGRES_DB=")
  })

  it("schema/index.ts exports a User model with field builders and access rules", () => {
    scaffold(tmpRoot, "my-app")
    const content = readFileSync(join(tmpRoot, "schema/index.ts"), "utf8")
    expect(content).toContain("export const User")
    expect(content).toContain("model(")
    expect(content).toContain("field.")
    expect(content).toContain("access.")
    expect(content).toContain("options: { timestamps: true }")
  })

  it(".supatype/kong.yml declares REST and GraphQL routes", () => {
    scaffold(tmpRoot, "my-app")
    const content = readFileSync(join(tmpRoot, ".supatype/kong.yml"), "utf8")
    expect(content).toContain("/rest/v1/")
    expect(content).toContain("/graphql/v1")
    expect(content).toContain("postgrest")
  })

  it(".gitignore excludes .env, node_modules, and engine binary", () => {
    scaffold(tmpRoot, "my-app")
    const content = readFileSync(join(tmpRoot, ".gitignore"), "utf8")
    expect(content).toContain(".env")
    expect(content).toContain("node_modules/")
    expect(content).toContain(".supatype/engine/")
  })

  it("seed.ts references the project name", () => {
    scaffold(tmpRoot, "acme")
    const content = readFileSync(join(tmpRoot, "seed.ts"), "utf8")
    expect(content).toContain("acme")
  })

  it("different project names produce different connection strings", () => {
    scaffold(tmpRoot, "alpha")
    const alpha = readFileSync(join(tmpRoot, "supatype.config.ts"), "utf8")

    const tmp2 = join(tmpdir(), `dt-init-test2-${Date.now()}`)
    mkdirSync(tmp2, { recursive: true })
    try {
      scaffold(tmp2, "beta")
      const beta = readFileSync(join(tmp2, "supatype.config.ts"), "utf8")
      expect(alpha).toContain("alpha")
      expect(beta).toContain("beta")
      expect(alpha).not.toContain("beta")
      expect(beta).not.toContain("alpha")
    } finally {
      rmSync(tmp2, { recursive: true, force: true })
    }
  })
})
