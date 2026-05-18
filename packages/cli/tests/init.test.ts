import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs"
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
      "package.json",
      "supatype.config.ts",
      "schema/index.ts",
      ".env",
      "seed.ts",
      "seeds/.gitkeep",
      "public/.gitkeep",
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
    expect(content).toContain('provider: "native"')
    expect(content).toContain("schema:")
    expect(content).toContain("versions:")
  })

  it("package.json includes @supatype/cli and @supatype/types", () => {
    scaffold(tmpRoot, "pkg-app")
    const content = readFileSync(join(tmpRoot, "package.json"), "utf8")
    expect(content).toContain("@supatype/cli")
    expect(content).toContain("@supatype/types")
    expect(content).toContain("pkg-app")
  })

  it("skips package.json when it already exists", () => {
    const pkgPath = join(tmpRoot, "package.json")
    writeFileSync(pkgPath, '{"name":"existing"}', "utf8")
    scaffold(tmpRoot, "my-app")
    expect(readFileSync(pkgPath, "utf8")).toBe('{"name":"existing"}')
  })

  it("supatype.config.ts documents self-host workflow", () => {
    scaffold(tmpRoot, "my-app")
    const content = readFileSync(join(tmpRoot, "supatype.config.ts"), "utf8")
    expect(content).toContain("self-host")
  })

  it(".env contains DATABASE_URL, JWT_SECRET, POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB", () => {
    scaffold(tmpRoot, "my-app")
    const content = readFileSync(join(tmpRoot, ".env"), "utf8")
    expect(content).toContain("DATABASE_URL=")
    expect(content).toContain("JWT_SECRET=")
    expect(content).toContain("POSTGRES_USER=")
    expect(content).toContain("POSTGRES_PASSWORD=")
    expect(content).toContain("POSTGRES_DB=")
  })

  it(".env contains ANON_KEY, SERVICE_ROLE_KEY, and SITE_URL placeholders", () => {
    scaffold(tmpRoot, "my-app")
    const content = readFileSync(join(tmpRoot, ".env"), "utf8")
    expect(content).toContain("ANON_KEY=")
    expect(content).toContain("SERVICE_ROLE_KEY=")
    expect(content).toContain("SITE_URL=")
  })

  it("schema/index.ts exports a User model using RFC v2 Model<>", () => {
    scaffold(tmpRoot, "my-app")
    const content = readFileSync(join(tmpRoot, "schema/index.ts"), "utf8")
    expect(content).toContain("export type User")
    expect(content).toContain("Model<")
    expect(content).toContain("access:")
  })

  it(".gitignore excludes .env, node_modules, and engine binary", () => {
    scaffold(tmpRoot, "my-app")
    const content = readFileSync(join(tmpRoot, ".gitignore"), "utf8")
    expect(content).toContain(".env")
    expect(content).toContain("node_modules/")
    expect(content).toContain(".supatype/engine/")
    expect(content).toContain("supatype.local.config.ts")
  })

  it("seed.ts references the project name", () => {
    scaffold(tmpRoot, "acme")
    const content = readFileSync(join(tmpRoot, "seed.ts"), "utf8")
    expect(content).toContain("acme")
  })

  it("different project names produce different config bodies", () => {
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
