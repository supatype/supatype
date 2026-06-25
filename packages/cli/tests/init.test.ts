import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { scaffold, defaultScaffoldOptions } from "../src/commands/init.js"

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
    scaffold(tmpRoot, defaultScaffoldOptions("my-app"))

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
    scaffold(tmpRoot, defaultScaffoldOptions("blog-app"))
    const content = readFileSync(join(tmpRoot, "supatype.config.ts"), "utf8")
    expect(content).toContain("blog-app")
    expect(content).toContain("defineConfig")
    expect(content).toContain('provider: "docker"')
    expect(content).toContain("schema:")
    expect(content).toContain("Optional: pin component versions")
    expect(content).not.toMatch(/^\s*versions:\s*\{/m)
  })

  it("package.json includes @supatype/cli and @supatype/types", () => {
    scaffold(tmpRoot, defaultScaffoldOptions("pkg-app"))
    const content = readFileSync(join(tmpRoot, "package.json"), "utf8")
    expect(content).toContain("@supatype/cli")
    expect(content).toContain("@supatype/types")
    expect(content).toContain("pkg-app")
  })

  it("skips package.json when it already exists", () => {
    const pkgPath = join(tmpRoot, "package.json")
    writeFileSync(pkgPath, '{"name":"existing"}', "utf8")
    scaffold(tmpRoot, defaultScaffoldOptions("my-app"))
    expect(readFileSync(pkgPath, "utf8")).toBe('{"name":"existing"}')
  })

  it("supatype.config.ts documents self-host workflow", () => {
    scaffold(tmpRoot, defaultScaffoldOptions("my-app"))
    const content = readFileSync(join(tmpRoot, "supatype.config.ts"), "utf8")
    expect(content).toContain("self-host")
  })

  it(".env contains DATABASE_URL, JWT_SECRET, POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB", () => {
    scaffold(tmpRoot, defaultScaffoldOptions("my-app"))
    const content = readFileSync(join(tmpRoot, ".env"), "utf8")
    expect(content).toContain("DATABASE_URL=")
    expect(content).toContain("JWT_SECRET=")
    expect(content).toContain("POSTGRES_USER=")
    expect(content).toContain("POSTGRES_PASSWORD=")
    expect(content).toContain("POSTGRES_DB=")
  })

  it(".env contains ANON_KEY, SERVICE_ROLE_KEY, and SITE_URL placeholders", () => {
    scaffold(tmpRoot, defaultScaffoldOptions("my-app"))
    const content = readFileSync(join(tmpRoot, ".env"), "utf8")
    expect(content).toContain("ANON_KEY=")
    expect(content).toContain("SERVICE_ROLE_KEY=")
    expect(content).toContain("SITE_URL=")
  })

  it("schema/index.ts exports a Profile model using RFC v2 Model<>", () => {
    scaffold(tmpRoot, defaultScaffoldOptions("my-app"))
    const content = readFileSync(join(tmpRoot, "schema/index.ts"), "utf8")
    expect(content).toContain("export type Profile")
    expect(content).toContain("display_name")
    expect(content).toContain("Model<")
    expect(content).toContain("access:")
  })

  it(".gitignore excludes .env, node_modules, and engine binary", () => {
    scaffold(tmpRoot, defaultScaffoldOptions("my-app"))
    const content = readFileSync(join(tmpRoot, ".gitignore"), "utf8")
    expect(content).toContain(".env")
    expect(content).toContain("node_modules/")
    expect(content).toContain(".supatype/")
    expect(content).toContain("supatype.local.config.ts")
  })

  it("seed.ts references the project name", () => {
    scaffold(tmpRoot, defaultScaffoldOptions("acme"))
    const content = readFileSync(join(tmpRoot, "seed.ts"), "utf8")
    expect(content).toContain("acme")
  })

  it("different project names produce different config bodies", () => {
    scaffold(tmpRoot, defaultScaffoldOptions("alpha"))
    const alpha = readFileSync(join(tmpRoot, "supatype.config.ts"), "utf8")

    const tmp2 = join(tmpdir(), `dt-init-test2-${Date.now()}`)
    mkdirSync(tmp2, { recursive: true })
    try {
      scaffold(tmp2, defaultScaffoldOptions("beta"))
      const beta = readFileSync(join(tmp2, "supatype.config.ts"), "utf8")
      expect(alpha).toContain("alpha")
      expect(beta).toContain("beta")
      expect(alpha).not.toContain("beta")
      expect(beta).not.toContain("alpha")
    } finally {
      rmSync(tmp2, { recursive: true, force: true })
    }
  })

  it("self-host target emits standalone mode + domain and a local override", () => {
    scaffold(tmpRoot, { ...defaultScaffoldOptions("my-app", "self-host"), domain: "api.example.com" })
    const content = readFileSync(join(tmpRoot, "supatype.config.ts"), "utf8")
    expect(content).toContain('mode: "standalone"')
    expect(content).toContain('domain: "api.example.com"')
    expect(content).toContain('environments: { default: "production" }')
    expect(existsSync(join(tmpRoot, "supatype.local.config.ts"))).toBe(true)
    const local = readFileSync(join(tmpRoot, "supatype.local.config.ts"), "utf8")
    expect(local).toContain('mode: "dev"')
    expect(local).toContain("Partial<SupatypeConfig>")
  })

  it("self-host with a TLS email emits an active tls block", () => {
    scaffold(tmpRoot, {
      ...defaultScaffoldOptions("my-app", "self-host"),
      domain: "api.example.com",
      tlsEmail: "ops@example.com",
    })
    const content = readFileSync(join(tmpRoot, "supatype.config.ts"), "utf8")
    expect(content).toContain('tls: { email: "ops@example.com" }')
  })

  it("self-host without a TLS email emits a commented tls hint", () => {
    scaffold(tmpRoot, { ...defaultScaffoldOptions("my-app", "self-host"), domain: "api.example.com" })
    const content = readFileSync(join(tmpRoot, "supatype.config.ts"), "utf8")
    expect(content).toContain('// tls: { email: "you@example.com" }')
  })

  it("cloud target emits managed mode + environments and a local override", () => {
    scaffold(tmpRoot, defaultScaffoldOptions("my-app", "cloud"))
    const content = readFileSync(join(tmpRoot, "supatype.config.ts"), "utf8")
    expect(content).toContain('mode: "managed"')
    expect(content).toContain('environments: { default: "production" }')
    expect(existsSync(join(tmpRoot, "supatype.local.config.ts"))).toBe(true)
  })

  it("later target stays in dev mode with no local override", () => {
    scaffold(tmpRoot, defaultScaffoldOptions("my-app", "later"))
    const content = readFileSync(join(tmpRoot, "supatype.config.ts"), "utf8")
    expect(content).toContain('mode: "dev"')
    expect(content).not.toContain("environments:")
    expect(existsSync(join(tmpRoot, "supatype.local.config.ts"))).toBe(false)
  })

  it("static app mode writes the static dir and config block", () => {
    scaffold(tmpRoot, {
      ...defaultScaffoldOptions("my-app"),
      app: { mode: "static", staticDir: "./dist" },
    })
    const content = readFileSync(join(tmpRoot, "supatype.config.ts"), "utf8")
    expect(content).toContain('mode: "static"')
    expect(content).toContain('static_dir: "./dist"')
    expect(existsSync(join(tmpRoot, "dist/index.html"))).toBe(true)
    const html = readFileSync(join(tmpRoot, "dist/index.html"), "utf8")
    expect(html).toContain("Supatype")
    expect(html).toContain("supatype.github.io/supatype/")
    expect(html).toContain("github.com/supatype")
  })

  it("static app mode with Vite scaffolds root index.html and vite.config.ts", () => {
    scaffold(tmpRoot, {
      ...defaultScaffoldOptions("my-app"),
      app: {
        mode: "static",
        staticDir: "./public",
        viteDevUrl: "http://127.0.0.1:5173",
      },
    })
    expect(existsSync(join(tmpRoot, "public/index.html"))).toBe(true)
    expect(existsSync(join(tmpRoot, "index.html"))).toBe(true)
    expect(existsSync(join(tmpRoot, "vite.config.ts"))).toBe(true)
    const pkg = readFileSync(join(tmpRoot, "package.json"), "utf8")
    expect(pkg).toContain('"vite": "vite"')
    expect(pkg).toContain('"vite": "^6"')
    const viteConfig = readFileSync(join(tmpRoot, "vite.config.ts"), "utf8")
    expect(viteConfig).toContain("port: 5173")
  })

  it("proxy app mode writes upstream and start in the config when target is later", () => {
    scaffold(tmpRoot, {
      ...defaultScaffoldOptions("my-app"),
      app: { mode: "proxy", upstream: "http://localhost:4000", start: "dev" },
    })
    const content = readFileSync(join(tmpRoot, "supatype.config.ts"), "utf8")
    expect(content).toContain('mode: "proxy"')
    expect(content).toContain('upstream: "http://localhost:4000"')
    expect(content).toContain('start: "dev"')
    expect(existsSync(join(tmpRoot, "supatype.local.config.ts"))).toBe(false)
  })

  it("proxy app mode with self-host splits static production config and local proxy override", () => {
    scaffold(tmpRoot, {
      ...defaultScaffoldOptions("my-app", "self-host"),
      domain: "api.example.com",
      app: {
        mode: "proxy",
        upstream: "http://127.0.0.1:5173",
        start: "vite",
        viteDevUrl: "http://127.0.0.1:5173",
      },
    })
    const committed = readFileSync(join(tmpRoot, "supatype.config.ts"), "utf8")
    expect(committed).toContain('mode: "static"')
    expect(committed).toContain('static_dir: "./dist"')
    expect(committed).not.toContain('mode: "proxy"')

    const local = readFileSync(join(tmpRoot, "supatype.local.config.ts"), "utf8")
    expect(local).toContain('mode: "dev"')
    expect(local).toContain('mode: "proxy"')
    expect(local).toContain('upstream: "http://127.0.0.1:5173"')
    expect(local).toContain('start: "vite"')
    expect(local).toContain('vite_dev_url: "http://127.0.0.1:5173"')
    expect(existsSync(join(tmpRoot, "dist/index.html"))).toBe(true)
    expect(existsSync(join(tmpRoot, "index.html"))).toBe(true)
    expect(existsSync(join(tmpRoot, "vite.config.ts"))).toBe(true)
  })

  it("proxy app mode with cloud target splits static production config and local proxy override", () => {
    scaffold(tmpRoot, {
      ...defaultScaffoldOptions("my-app", "cloud"),
      app: { mode: "proxy", upstream: "http://localhost:3000", start: "dev" },
    })
    const committed = readFileSync(join(tmpRoot, "supatype.config.ts"), "utf8")
    expect(committed).toContain('mode: "static"')
    expect(committed).not.toContain('mode: "proxy"')

    const local = readFileSync(join(tmpRoot, "supatype.local.config.ts"), "utf8")
    expect(local).toContain('mode: "proxy"')
    expect(local).toContain('upstream: "http://localhost:3000"')
  })

  it("hello-world function scaffolds function files and a functions script", () => {
    scaffold(tmpRoot, { ...defaultScaffoldOptions("my-app"), helloFunction: true })
    expect(existsSync(join(tmpRoot, "functions/hello/index.ts"))).toBe(true)
    expect(existsSync(join(tmpRoot, "functions/_shared/README.md"))).toBe(true)
    expect(existsSync(join(tmpRoot, "functions/.env.local"))).toBe(true)
    const pkg = readFileSync(join(tmpRoot, "package.json"), "utf8")
    expect(pkg).toContain("supatype functions serve")
  })

  it("custom schema path is honored", () => {
    scaffold(tmpRoot, { ...defaultScaffoldOptions("my-app"), schemaPath: "db/schema.ts" })
    expect(existsSync(join(tmpRoot, "db/schema.ts"))).toBe(true)
    const content = readFileSync(join(tmpRoot, "supatype.config.ts"), "utf8")
    expect(content).toContain('path: "db/schema.ts"')
  })

  it("s3 storage and resend email reflect in config and .env", () => {
    scaffold(tmpRoot, {
      ...defaultScaffoldOptions("my-app"),
      email: "resend",
      storageLocal: "s3",
      storageProduction: "s3",
    })
    const config = readFileSync(join(tmpRoot, "supatype.config.ts"), "utf8")
    expect(config).toContain('email: { provider: "resend" }')
    expect(config).toContain('storage: { provider: "s3" }')
    const env = readFileSync(join(tmpRoot, ".env"), "utf8")
    expect(env).toContain("RESEND_API_KEY=")
    expect(env).toContain("S3_BUCKET=")
    expect(env).toContain("local development and production")
  })

  it("mixed local dev and s3 production writes both storage sections", () => {
    scaffold(tmpRoot, {
      ...defaultScaffoldOptions("my-app"),
      storageLocal: "local",
      storageProduction: "s3",
    })
    const config = readFileSync(join(tmpRoot, "supatype.config.ts"), "utf8")
    expect(config).toContain('provider: "local"')
    expect(config).toContain("Production storage: external S3")
    const env = readFileSync(join(tmpRoot, ".env"), "utf8")
    expect(env).toContain("local development — MinIO")
    expect(env).toContain("production — external bucket")
  })
})
