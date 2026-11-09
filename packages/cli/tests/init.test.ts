import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { execFileSync } from "node:child_process"
import { scaffold, defaultScaffoldOptions } from "../src/commands/init.js"

let tmpRoot: string

/**
 * Whether git ignores a path under `cwd`. `check-ignore -q` exits 0 for ignored and 1 for not;
 * anything else (git missing, not a repository) is rethrown so it cannot read as "not ignored".
 */
function gitIgnores(cwd: string, relPath: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", relPath], { cwd, stdio: "pipe" })
    return true
  } catch (err) {
    if (typeof err === "object" && err !== null && "status" in err && err.status === 1) return false
    throw err
  }
}

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

  it("supatype.config.ts names where the generated types and client go", () => {
    // Without it, a project made by init had no `output`, and dev never regenerated the client.
    scaffold(tmpRoot, defaultScaffoldOptions("out-app"))
    const content = readFileSync(join(tmpRoot, "supatype.config.ts"), "utf8")
    expect(content).toMatch(/^\s*output: \{ types: "types\/database\.ts", client: "supatype\/generated\/index\.d\.ts" \},$/m)
  })

  it("package.json includes @supatype/cli and @supatype/types", () => {
    scaffold(tmpRoot, defaultScaffoldOptions("pkg-app"))
    const content = readFileSync(join(tmpRoot, "package.json"), "utf8")
    expect(content).toContain("@supatype/cli")
    expect(content).toContain("@supatype/types")
    expect(content).toContain("pkg-app")
  })

  it("merges Supatype deps into package.json when it already exists", () => {
    const pkgPath = join(tmpRoot, "package.json")
    writeFileSync(pkgPath, '{"name":"existing","scripts":{"dev":"next dev"}}', "utf8")
    scaffold(tmpRoot, defaultScaffoldOptions("my-app"))
    const content = readFileSync(pkgPath, "utf8")
    expect(content).toContain("@supatype/cli")
    expect(content).toContain("@supatype/types")
    expect(content).toContain("next dev")
    expect(content).toContain("supatype:dev")
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

  it(".env carries a generated SQL editor password, distinct from the others", () => {
    scaffold(tmpRoot, defaultScaffoldOptions("my-app"))
    const content = readFileSync(join(tmpRoot, ".env"), "utf8")
    const value = (key: string): string | undefined =>
      content.match(new RegExp(`^${key}=(.+)$`, "m"))?.[1]
    const editor = value("SUPATYPE_SQL_EDITOR_PASSWORD")
    expect(editor).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(editor).not.toBe(value("POSTGRES_PASSWORD"))
    expect(editor).not.toBe(value("AUTHENTICATOR_PASSWORD"))
  })

  // SITE_URL is where auth emails send people back to. It was localhost:3000 for every project,
  // while a static or proxied app is served on the API's address, so the links went nowhere.
  it.each([
    ["a static app on Docker", { mode: "static", staticDir: "./dist" }, "docker", 18478, "http://localhost:18478"],
    ["a proxied app on Docker", { mode: "proxy", upstream: "http://localhost:4000", start: "dev" }, "docker", 18478, "http://localhost:18478"],
    ["a static app on the native provider", { mode: "static", staticDir: "./dist" }, "native", undefined, "http://localhost:18471"],
    ["no app", { mode: "none" }, "docker", 18478, "http://localhost:3000"],
  ] as const)(".env points SITE_URL at where %s is served", (_, app, provider, kongPort, siteUrl) => {
    scaffold(tmpRoot, { ...defaultScaffoldOptions("my-app"), app, provider, ...(kongPort !== undefined ? { kongPort } : {}) })
    expect(readFileSync(join(tmpRoot, ".env"), "utf8")).toMatch(new RegExp(`^SITE_URL=${siteUrl}$`, "m"))
  })

  it("package.json carries a version", () => {
    scaffold(tmpRoot, defaultScaffoldOptions("my-app"))
    expect(JSON.parse(readFileSync(join(tmpRoot, "package.json"), "utf8"))).toMatchObject({ version: "0.1.0" })
  })

  it(".env contains ANON_KEY, SERVICE_ROLE_KEY, and SITE_URL placeholders", () => {
    scaffold(tmpRoot, defaultScaffoldOptions("my-app"))
    const content = readFileSync(join(tmpRoot, ".env"), "utf8")
    expect(content).toContain("ANON_KEY=")
    expect(content).toContain("SERVICE_ROLE_KEY=")
    expect(content).toContain("SITE_URL=")
  })

  // Issue 23: .env is read by a production Vite build, so the local gateway address shipped in the
  // bundle. The front-end URL names go to .env.development.local, read in development only.
  it("writes the front end's local API URL to .env.development.local, not .env", () => {
    scaffold(tmpRoot, { ...defaultScaffoldOptions("my-app"), kongPort: 18478 })
    const env = readFileSync(join(tmpRoot, ".env"), "utf8")
    expect(env).not.toMatch(/^(VITE_|PUBLIC_|NEXT_PUBLIC_|EXPO_PUBLIC_)SUPATYPE_(URL|ANON_KEY)=/m)
    const dev = readFileSync(join(tmpRoot, ".env.development.local"), "utf8")
    expect(dev).toMatch(/^VITE_SUPATYPE_URL=http:\/\/localhost:18478$/m)
    expect(dev).toMatch(/^NEXT_PUBLIC_SUPATYPE_URL=http:\/\/localhost:18478$/m)
    expect(readFileSync(join(tmpRoot, ".gitignore"), "utf8")).toMatch(/^\.env\.\*\.local$/m)
  })

  it("adds .env.*.local to a .gitignore the project already has", () => {
    writeFileSync(join(tmpRoot, ".gitignore"), "node_modules/\n")
    scaffold(tmpRoot, { ...defaultScaffoldOptions("my-app"), kongPort: 18478 })
    expect(readFileSync(join(tmpRoot, ".gitignore"), "utf8")).toMatch(/^\.env\.\*\.local$/m)
  })

  // Fresh-user test: the static directory typed at init was ignored for a Vite project with a
  // production target, which always served ./dist.
  it("serves the static directory typed at init, and has Vite build into it", () => {
    scaffold(tmpRoot, {
      ...defaultScaffoldOptions("my-app", "self-host"),
      app: { mode: "static", staticDir: "./build", viteDevUrl: "http://127.0.0.1:5173" },
    })
    const config = readFileSync(join(tmpRoot, "supatype.config.ts"), "utf8")
    expect(config).toContain('static_dir: "./build"')
    expect(config).not.toContain("./dist")
    expect(existsSync(join(tmpRoot, "build/index.html"))).toBe(true)
    expect(existsSync(join(tmpRoot, "dist/index.html"))).toBe(false)
    expect(readFileSync(join(tmpRoot, "vite.config.ts"), "utf8")).toContain('outDir: "build"')
  })

  it("leaves Vite's own build directory alone when the static directory is dist", () => {
    scaffold(tmpRoot, {
      ...defaultScaffoldOptions("my-app", "self-host"),
      app: { mode: "static", staticDir: "./dist", viteDevUrl: "http://127.0.0.1:5173" },
    })
    expect(readFileSync(join(tmpRoot, "supatype.config.ts"), "utf8")).toContain('static_dir: "./dist"')
    expect(readFileSync(join(tmpRoot, "vite.config.ts"), "utf8")).not.toContain("outDir")
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

  // Issue 30: apps write their client to src/lib/supatype.ts, and init's template ignored that
  // path, so a commit left the client out and a fresh clone did not build. Asked of git itself,
  // because the question is what git does with the file, not what the template text looks like.
  it(".gitignore does not ignore the app's own client or type files", () => {
    scaffold(tmpRoot, defaultScaffoldOptions("my-app"))
    execFileSync("git", ["init", "-q", "."], { cwd: tmpRoot })
    for (const rel of ["src/lib/supatype.ts", "src/types/supatype.d.ts"]) {
      expect(gitIgnores(tmpRoot, rel), `${rel} should be committable`).toBe(false)
    }
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

  it("static app mode with Vite on self-host splits production static and local proxy override", () => {
    scaffold(tmpRoot, {
      ...defaultScaffoldOptions("my-app", "self-host"),
      domain: "api.example.com",
      app: {
        mode: "static",
        staticDir: "./dist",
        viteDevUrl: "http://127.0.0.1:5173",
      },
    })
    const committed = readFileSync(join(tmpRoot, "supatype.config.ts"), "utf8")
    expect(committed).toContain('mode: "static"')
    expect(committed).toContain('static_dir: "./dist"')
    expect(committed).not.toContain("vite_dev_url")

    const local = readFileSync(join(tmpRoot, "supatype.local.config.ts"), "utf8")
    expect(local).toContain('mode: "proxy"')
    expect(local).toContain('start: "vite"')
    expect(local).toContain('vite_dev_url: "http://127.0.0.1:5173"')
    expect(existsSync(join(tmpRoot, "dist/index.html"))).toBe(true)
    expect(existsSync(join(tmpRoot, "vite.config.ts"))).toBe(true)
  })

  // Fresh-user follow-up: a "Decide later" project that chose Vite got `static` + `vite_dev_url`,
  // and nothing started Vite: `supatype dev` starts an app only in proxy mode, and the next steps
  // never said to run it. It gets the same split as a project with a production target.
  it("static app mode with Vite and no production target splits the same way, so dev starts Vite", () => {
    scaffold(tmpRoot, {
      ...defaultScaffoldOptions("my-app", "later"),
      app: { mode: "static", staticDir: "./dist", viteDevUrl: "http://127.0.0.1:5173" },
    })
    const committed = readFileSync(join(tmpRoot, "supatype.config.ts"), "utf8")
    expect(committed).toContain('mode: "static"')
    expect(committed).toContain('static_dir: "./dist"')
    expect(committed).not.toContain("vite_dev_url")
    expect(committed).toContain('mode: "dev"')

    const local = readFileSync(join(tmpRoot, "supatype.local.config.ts"), "utf8")
    expect(local).toContain('mode: "proxy"')
    expect(local).toContain('start: "vite"')
    expect(local).toContain('vite_dev_url: "http://127.0.0.1:5173"')
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
    // Current @vitejs/plugin-react peers vite ^8, so ^6 failed the install with ERESOLVE.
    expect(pkg).toContain('"vite": "^8"')
    // app.static_dir serves Vite's build output, which nothing produced without this.
    expect(pkg).toContain('"build": "vite build"')
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

  // 0.9.1 release test: a missing start was written as "dev", which in a new project is
  // init's own "supatype dev", so dev ran itself as the app.
  it("proxy app mode with no start writes none, not init's own dev script", () => {
    scaffold(tmpRoot, { ...defaultScaffoldOptions("my-app"), app: { mode: "proxy", upstream: "http://localhost:4000" } })
    const content = readFileSync(join(tmpRoot, "supatype.config.ts"), "utf8")
    expect(content).toContain('mode: "proxy"')
    expect(content).not.toMatch(/^\s*start:/m)
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
    expect(existsSync(join(tmpRoot, "functions/deno.d.ts"))).toBe(true)
    expect(existsSync(join(tmpRoot, "functions/tsconfig.json"))).toBe(true)
    // The scaffold teaches the context, not the environment. It used to read Deno.env.get, which is
    // the process-global delivery that forced the worker to run one invocation at a time.
    const hello = readFileSync(join(tmpRoot, "functions/hello/index.ts"), "utf8")
    expect(hello).toContain("ctx: FunctionContext")
    expect(hello).not.toContain("Deno.env.get")
    // The address a browser can open, not the in-stack one a function calls the API on.
    expect(hello).toContain("const { publicUrl } = ctx")
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
    expect(config).toContain('storage: { provider: "s3", production: "s3" }')
    const env = readFileSync(join(tmpRoot, ".env"), "utf8")
    // The names the auth server reads; an unprefixed RESEND_API_KEY was never seen by it.
    expect(env).toMatch(/^SUPATYPE_RESEND_API_KEY=$/m)
    expect(env).toMatch(/^SUPATYPE_RESEND_FROM=/m)
    expect(env).not.toMatch(/^RESEND_/m)
    expect(env).toContain("S3_BUCKET=")
    expect(env).toContain("local development and production")
  })

  // 0.9.2: the storage service keeps every bucket as a prefix in S3_BUCKET, as Supabase does, and
  // serves public files itself. The .env used to promise neither, and "ambient credentials" lived
  // only in a config comment while the service ignored S3_BUCKET altogether.
  it("describes the one-bucket model wherever it scaffolds S3 settings", () => {
    for (const [storageLocal, storageProduction] of [["s3", "s3"], ["local", "s3"], ["s3", "local"]] as const) {
      scaffold(tmpRoot, { ...defaultScaffoldOptions("my-app"), storageLocal, storageProduction })
      const env = readFileSync(join(tmpRoot, ".env"), "utf8")
      expect(env).toContain("Every Supatype bucket is a folder (key prefix) in S3_BUCKET")
      expect(env).toContain("leave S3_ENDPOINT blank")
      expect(env).toContain("leave both keys blank")
      rmSync(tmpRoot, { recursive: true, force: true })
      mkdirSync(tmpRoot, { recursive: true })
    }
  })

  it("scaffolds SES and SMTP settings under the names the auth server reads", () => {
    for (const email of ["ses", "smtp"] as const) {
      const root = join(tmpRoot, email)
      mkdirSync(root, { recursive: true })
      scaffold(root, { ...defaultScaffoldOptions("my-app"), email })
      const env = readFileSync(join(root, ".env"), "utf8")
      expect(env).not.toMatch(/^(SES_FROM|SMTP_[A-Z_]+)=/m)
      expect(env).toMatch(email === "ses" ? /^SUPATYPE_SES_FROM=$/m : /^SUPATYPE_SMTP_HOST=$/m)
    }
  })

  it("writes the SMTP host and port the wizard was given", () => {
    scaffold(tmpRoot, { ...defaultScaffoldOptions("my-app"), email: "smtp", smtp: { host: "smtp.acme.test", port: 2525 } })
    const env = readFileSync(join(tmpRoot, ".env"), "utf8")
    expect(env).toMatch(/^SUPATYPE_SMTP_HOST=smtp\.acme\.test$/m)
    expect(env).toMatch(/^SUPATYPE_SMTP_PORT=2525$/m)
  })

  it("mixed local dev and s3 production writes both storage sections", () => {
    scaffold(tmpRoot, {
      ...defaultScaffoldOptions("my-app"),
      storageLocal: "local",
      storageProduction: "s3",
    })
    const config = readFileSync(join(tmpRoot, "supatype.config.ts"), "utf8")
    expect(config).toContain('storage: { provider: "local", local_path: ".supatype/storage", production: "s3" }')
    const env = readFileSync(join(tmpRoot, ".env"), "utf8")
    expect(env).toContain("local development, SeaweedFS")
    expect(env).toContain("production, your own S3 bucket")
  })

  // 0.9.2: the self-host stack reads production storage from the config, so init records the answer
  // there rather than in a comment, and S3_ENDPOINT is written once: local SeaweedFS's address used
  // to come first and a blank production one after it, which a .env reader takes in place of it.
  it("records production storage in the config and writes each S3 setting once", () => {
    for (const [storageLocal, storageProduction, written] of [
      ["s3", "local", 'storage: { provider: "s3", production: "local" }'],
      ["local", "local", 'storage: { provider: "local", local_path: ".supatype/storage" }'],
      ["local", "s3", 'production: "s3" }'],
    ] as const) {
      scaffold(tmpRoot, { ...defaultScaffoldOptions("my-app"), storageLocal, storageProduction })
      expect(readFileSync(join(tmpRoot, "supatype.config.ts"), "utf8")).toContain(written)
      const env = readFileSync(join(tmpRoot, ".env"), "utf8")
      for (const name of ["S3_ENDPOINT", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY", "S3_SECRET_KEY"]) {
        expect(env.match(new RegExp(`^${name}=`, "gm"))?.length ?? 0, `${storageLocal}/${storageProduction} ${name}`).toBeLessThanOrEqual(1)
      }
      rmSync(tmpRoot, { recursive: true, force: true })
      mkdirSync(tmpRoot, { recursive: true })
    }
  })

  // The compose generator has had this guard since SeaweedFS replaced MinIO; the .env generator
  // did not, which is the whole reason it kept naming a withdrawn image and a port nothing serves.
  // A scaffolded .env is the first thing a new project reads, so it gets the same guard.
  it("a scaffolded .env never names MinIO or its port", () => {
    for (const storage of ["local", "s3"] as const) {
      scaffold(tmpRoot, {
        ...defaultScaffoldOptions("my-app"),
        storageLocal: storage,
        storageProduction: storage,
      })
      const env = readFileSync(join(tmpRoot, ".env"), "utf8")
      expect(env.toLowerCase()).not.toContain("minio")
      expect(env).not.toContain("9000")
      rmSync(tmpRoot, { recursive: true, force: true })
      mkdirSync(tmpRoot, { recursive: true })
    }
  })

  // The object store publishes 8333, and the storage service reads S3_ENDPOINT from this file.
  // A local .env pointing anywhere else is a stack that starts and then fails on first upload.
  it("local storage points at the port the object store actually publishes", () => {
    scaffold(tmpRoot, {
      ...defaultScaffoldOptions("my-app"),
      storageLocal: "local",
      storageProduction: "local",
    })
    const env = readFileSync(join(tmpRoot, ".env"), "utf8")
    expect(env).toContain("S3_ENDPOINT=http://localhost:8333")
  })
})
