import type { Command } from "commander"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve, join, basename } from "node:path"
import { spawnSync } from "node:child_process"
import { p, runClackFlow } from "../ui/clack.js"
import { ensureNotCancelled } from "../ui/prompts.js"
import { generateAndWriteKeys } from "./keys.js"
import { file, error, info, plain, warn } from "../ui/messages.js"
import { nextSteps } from "../ui/next-steps.js"
import { probeDockerDaemon, reportDockerUnavailable } from "../docker-runtime.js"
import { loadConfig } from "../config.js"
import {
  ensureComponentBinaries,
  reportComponentBinaryFailures,
} from "../ensure-component-binaries.js"
import { ensureFunctionsDenoTypes } from "../functions-deno-types.js"
import { mergeSupatypePackageJson } from "../init-package-json.js"
import { cliPackageVersion } from "../cli-package-version.js"
import {
  initDependencyVersionsFallback,
  resolveInitDependencyVersions,
  type InitDependencyVersions,
} from "../init-dependency-versions.js"
import { detectProjectSetup, type DetectedProjectSetup } from "../init-project-detect.js"

// ─── Options model ─────────────────────────────────────────────────────────--

type PackageManager = "npm" | "pnpm" | "yarn" | "bun"

/** Where the project runs in production (drives committed config + local override). */
type ProductionTarget = "cloud" | "self-host" | "later"

export interface ScaffoldAppOptions {
  mode: "none" | "static" | "proxy"
  staticDir?: string
  upstream?: string
  start?: string
  viteDevUrl?: string
}

/** File-affecting answers that drive what `scaffold()` writes. */
export interface ScaffoldOptions {
  projectName: string
  /** Local development runtime (docker recommended). */
  provider: "docker" | "native"
  /** Host Kong port when provider is docker (unique per project). */
  kongPort?: number
  productionTarget: ProductionTarget
  domain?: string
  /** ACME contact email for Let's Encrypt HTTPS (self-host + domain). */
  tlsEmail?: string
  schemaPath: string
  app: ScaffoldAppOptions
  email: "console" | "smtp" | "resend" | "ses"
  /** Object storage while developing locally (`supatype dev`). */
  storageLocal: "local" | "s3"
  /** Object storage when deployed to production. */
  storageProduction: "local" | "s3"
  helloFunction: boolean
  /** When set, written to .env for first dev/push to create the admin panel user. */
  adminEmail?: string
  adminPassword?: string
}

type StorageProvider = ScaffoldOptions["storageLocal"]

const STORAGE_PROVIDER_OPTIONS: {
  value: StorageProvider
  label: string
  hint: string
}[] = [
  { value: "local", label: "Local", hint: "storage you host yourself (MinIO)" },
  { value: "s3", label: "S3", hint: "external bucket (AWS S3 or compatible)" },
]

/** Wizard result = scaffold options plus runtime actions (install / keys). */
interface WizardResult extends ScaffoldOptions {
  packageManager: PackageManager
  install: boolean
  generateKeys: boolean
}

/** `--mode dev|standalone` is mapped onto a production target for back-compat. */
function productionTargetFromMode(mode: string): ProductionTarget {
  return mode === "standalone" ? "self-host" : "later"
}

/** supatype-server mode written to the committed config for a production target. */
function serverModeForTarget(target: ProductionTarget): "dev" | "standalone" | "managed" {
  switch (target) {
    case "cloud":
      return "managed"
    case "self-host":
      return "standalone"
    case "later":
      return "dev"
  }
}

export function defaultScaffoldOptions(
  projectName: string,
  productionTarget: ProductionTarget = "later",
): ScaffoldOptions {
  return {
    projectName,
    provider: "docker",
    productionTarget,
    ...(productionTarget === "self-host" ? { domain: "" } : {}),
    schemaPath: "schema/index.ts",
    app: { mode: "none" },
    email: "console",
    storageLocal: "local",
    storageProduction: "local",
    helloFunction: false,
  }
}

// ─── Registration ──────────────────────────────────────────────────────────--

interface InitCliOptions {
  mode: string
  defaults?: boolean
  install: boolean
  keys: boolean
  adminEmail?: string
  adminPassword?: string
  admin?: boolean
}

export function registerInit(program: Command): void {
  program
    .command("init [name]")
    .description("Scaffold a new Supatype project")
    .option(
      "--mode <mode>",
      "Back-compat: dev (default, local only) | standalone (self-host production target)",
      "dev",
    )
    .option("-y, --defaults", "Skip all prompts and use sensible defaults")
    .option("--no-install", "Do not run the package manager install step")
    .option("--no-keys", "Do not generate ANON_KEY / SERVICE_ROLE_KEY")
    .option("--admin-email <email>", "First admin panel user email (written to .env)")
    .option("--admin-password <password>", "First admin panel user password (written to .env)")
    .option("--no-admin", "Do not configure a first admin user")
    .action(async (name: string | undefined, opts: InitCliOptions) => {
      const dir = name ? resolve(process.cwd(), name) : process.cwd()

      if (name && existsSync(dir)) {
        error(`Directory already exists: ${dir}`)
        process.exit(1)
      }

      const defaultName = name ?? basename(dir) ?? "my-project"
      const interactive = !opts.defaults && Boolean(process.stdin.isTTY)

      const modeTarget = productionTargetFromMode(opts.mode)

      let result: WizardResult
      if (interactive) {
        await runInteractiveInit({
          name,
          dir,
          defaultName,
          modeTarget,
          opts,
        })
        return
      } else {
        result = {
          ...defaultScaffoldOptions(defaultName, modeTarget),
          packageManager: detectInvokingPackageManager(),
          install: true,
          generateKeys: true,
        }
        if (result.provider === "docker") {
          const { findNextFreePort } = await import("../dev-ports.js")
          const { COMPOSE_DEV_KONG_PORT } = await import("../project-config.js")
          result.kongPort = await findNextFreePort(COMPOSE_DEV_KONG_PORT)
        }
        if (!opts.admin && opts.adminEmail && opts.adminPassword) {
          result.adminEmail = opts.adminEmail
          result.adminPassword = opts.adminPassword
        }
      }

      if (opts.admin === false) {
        delete result.adminEmail
        delete result.adminPassword
      } else if (opts.adminEmail && opts.adminPassword) {
        result.adminEmail = opts.adminEmail
        result.adminPassword = opts.adminPassword
      }

      // CLI flags override wizard / default action choices.
      const doInstall = opts.install !== false && result.install
      const doKeys = opts.keys !== false && result.generateKeys

      if (name) mkdirSync(dir, { recursive: true })

      const deps = await resolveInitDependencyVersions()
      const runningCli = cliPackageVersion()
      if (deps.cli !== runningCli || deps.types !== runningCli) {
        info(
          `Using published npm versions: @supatype/cli ^${deps.cli}, @supatype/types ^${deps.types}`,
        )
      }

      scaffold(dir, result, deps)

      const installOk = doInstall ? runInstall(dir, result.packageManager) : false
      const keysGenerated = doKeys ? writeKeys(dir) : false
      const binariesReady =
        doInstall && installOk ? await ensureInitBinaries(dir) : false

      if (doInstall && !installOk) {
        error(
          `Dependency install failed. Run "${result.packageManager} install" in the project directory, then "supatype update".`,
        )
        process.exit(1)
      }
      if (doKeys && !keysGenerated) {
        error("Could not generate API keys. Check .env has JWT_SECRET, then run `supatype keys`.")
        process.exit(1)
      }
      if (doInstall && installOk && !binariesReady) {
        error("Component binaries could not be downloaded. Run `supatype update` in the project directory.")
        process.exit(1)
      }

      warnDockerUnavailableForProvider(result.provider)

      printNextSteps({
        name,
        result,
        installed: doInstall && installOk,
        keysGenerated,
        binariesReady,
      })
    })
}

interface InteractiveInitArgs {
  name: string | undefined
  dir: string
  defaultName: string
  modeTarget: ProductionTarget
  opts: InitCliOptions
}

/** Interactive init — one Ink session for wizard + scaffold + install + finish. */
async function runInteractiveInit(args: InteractiveInitArgs): Promise<void> {
  const { name, dir, defaultName, modeTarget, opts } = args

  await runClackFlow(async () => {
    p.intro("Create a new Supatype project")
    const detected = detectProjectSetup(dir)
    if (detected.hasExistingFiles && detected.summaryLines.length > 0) {
      p.note(
        ["Existing project detected:", ...detected.summaryLines.map((line) => `  • ${line}`)].join(
          "\n",
        ),
      )
    }
    let result = await collectWizardAnswers(defaultName, modeTarget, dir, detected)

    if (opts.admin === false) {
      delete result.adminEmail
      delete result.adminPassword
    } else if (opts.adminEmail && opts.adminPassword) {
      result.adminEmail = opts.adminEmail
      result.adminPassword = opts.adminPassword
    }

    const doInstall = opts.install !== false && result.install
    const doKeys = opts.keys !== false && result.generateKeys

    if (name) mkdirSync(dir, { recursive: true })

    const deps = await resolveInitDependencyVersions()
    const runningCli = cliPackageVersion()
    if (deps.cli !== runningCli || deps.types !== runningCli) {
      info(
        `Using published npm versions: @supatype/cli ^${deps.cli}, @supatype/types ^${deps.types}`,
      )
    }

    const setupSpinner = p.spinner()
    setupSpinner.start("Setting up your project...")

    scaffold(dir, result, deps)

    let installOk = !doInstall
    if (doInstall) {
      setupSpinner.start(`Installing dependencies with ${result.packageManager}...`)
      installOk = runInstall(dir, result.packageManager)
      setupSpinner.stop(installOk ? "Dependencies installed." : "Dependency install failed.")
    }

    let keysGenerated = !doKeys
    if (doKeys) {
      setupSpinner.start("Generating API keys...")
      keysGenerated = writeKeys(dir)
      setupSpinner.stop(keysGenerated ? "API keys generated." : "Could not generate API keys.")
    }

    let binariesReady = false
    if (doInstall && installOk) {
      setupSpinner.start("Preparing component binaries...")
      binariesReady = await ensureInitBinaries(dir)
      setupSpinner.stop(binariesReady ? "Component binaries ready." : "Some binaries are missing.")
    }

    if (doInstall && !installOk) {
      error(
        `Dependency install failed. Run "${result.packageManager} install" in the project directory, then "supatype update".`,
      )
      process.exit(1)
    }
    if (doKeys && !keysGenerated) {
      error("Could not generate API keys. Check .env has JWT_SECRET, then run `supatype keys`.")
      process.exit(1)
    }
    if (doInstall && installOk && !binariesReady) {
      error("Component binaries could not be downloaded. Run `supatype update` in the project directory.")
      process.exit(1)
    }

    warnDockerUnavailableForProvider(result.provider)

    p.outro(`Supatype project ready${name ? ` in ${name}/` : ""}.`)
    printNextSteps({
      name,
      result,
      installed: doInstall && installOk,
      keysGenerated,
      binariesReady,
    })
  })

  process.exit(0)
}

// ─── Wizard ──────────────────────────────────────────────────────────────────

async function collectWizardAnswers(
  defaultName: string,
  defaultTarget: ProductionTarget,
  dir: string,
  detected: DetectedProjectSetup,
): Promise<WizardResult> {
    const projectName = ensureNotCancelled(
      await p.text({
        message: "Project name",
        defaultValue: defaultName,
        placeholder: defaultName,
      }),
    ).trim() || defaultName

    const admin = await promptAdminUser()

    const packageManager = ensureNotCancelled(
      await p.select<PackageManager>({
        message: "Package manager",
        initialValue: detectInvokingPackageManager(),
        options: [
          { value: "npm", label: "npm" },
          { value: "pnpm", label: "pnpm" },
          { value: "yarn", label: "yarn" },
          { value: "bun", label: "bun" },
        ],
      }),
    )

    const productionTarget = ensureNotCancelled(
      await p.select<ProductionTarget>({
        message: "Where will this run in production?",
        initialValue: defaultTarget,
        options: [
          { value: "cloud", label: "Supatype Cloud", hint: "managed; deploy via supatype link" },
          { value: "self-host", label: "Self-host", hint: "your own server with TLS" },
          { value: "later", label: "Decide later", hint: "local development only for now" },
        ],
      }),
    )

    let domain: string | undefined
    let tlsEmail: string | undefined
    if (productionTarget === "self-host") {
      domain = ensureNotCancelled(
        await p.text({
          message: "Production domain for ACME TLS (optional, can set later)",
          placeholder: "api.example.com",
          defaultValue: "",
        }),
      ).trim()
      if (domain) {
        tlsEmail =
          ensureNotCancelled(
            await p.text({
              message: "Email for Let's Encrypt (HTTPS) certificates",
              placeholder: "you@example.com",
              defaultValue: "",
            }),
          ).trim() || undefined
      }
    }

    const provider = ensureNotCancelled(
      await p.select<ScaffoldOptions["provider"]>({
        message: "How should Postgres and the server run for local development?",
        initialValue: "docker",
        options: [
          { value: "docker", label: "Docker", hint: "Docker Compose stack (recommended)" },
          { value: "native", label: "Native", hint: "host Postgres + server binaries, no Docker" },
        ],
      }),
    )

    let kongPort: number | undefined
    if (provider === "docker") {
      const { promptKongPortChoice } = await import("../dev-ports.js")
      kongPort = await promptKongPortChoice()
    }

    const defaultSchemaPath = existsSync(join(dir, "schema/index.ts"))
      ? "schema/index.ts"
      : "schema/index.ts"
    const schemaPath = ensureNotCancelled(
      await p.text({
        message: "Where should your schema live?",
        defaultValue: defaultSchemaPath,
        placeholder: "schema/index.ts",
      }),
    ).trim() || defaultSchemaPath

    const app = await promptApp(detected, productionTarget)

    const email = ensureNotCancelled(
      await p.select<ScaffoldOptions["email"]>({
        message: "Email provider",
        initialValue: "console",
        options: [
          { value: "console", label: "console", hint: "log emails to the terminal (dev)" },
          { value: "smtp", label: "SMTP" },
          { value: "resend", label: "Resend" },
          { value: "ses", label: "Amazon SES" },
        ],
      }),
    )

    const storageLocal = ensureNotCancelled(
      await p.select<StorageProvider>({
        message: "Local storage (for development)?",
        initialValue: "local",
        options: STORAGE_PROVIDER_OPTIONS,
      }),
    )

    const storageProduction = ensureNotCancelled(
      await p.select<StorageProvider>({
        message: "Production storage?",
        initialValue: "local",
        options: STORAGE_PROVIDER_OPTIONS,
      }),
    )

    const helloFunction = ensureNotCancelled(
      await p.confirm({
        message: "Create a hello-world edge function?",
        initialValue: false,
      }),
    )

    return {
      projectName,
      provider,
      ...(kongPort !== undefined ? { kongPort } : {}),
      productionTarget,
      ...(domain !== undefined ? { domain } : {}),
      ...(tlsEmail !== undefined ? { tlsEmail } : {}),
      schemaPath,
      app,
      email,
      storageLocal,
      storageProduction,
      helloFunction,
      packageManager,
      install: true,
      generateKeys: true,
      ...admin,
    }
}

async function promptAdminUser(): Promise<{ adminEmail?: string; adminPassword?: string }> {
  const createAdmin = ensureNotCancelled(
    await p.confirm({
      message: "Create an admin user for /admin?",
      initialValue: true,
    }),
  )
  if (!createAdmin) return {}

  p.note("First sign-in at /admin — created automatically on supatype dev or push.")

  const adminEmail = ensureNotCancelled(
    await p.text({
      message: "Admin email",
      placeholder: "you@example.com",
      validate: (value) => (value.trim() ? undefined : "Email is required"),
    }),
  ).trim()

  let adminPassword = ""
  while (true) {
    adminPassword = ensureNotCancelled(
      await p.password({ message: "Admin password (min 8 characters)" }),
    ).trim()
    if (adminPassword.length >= 8) break
    p.log.warn("Password must be at least 8 characters.")
  }

  return { adminEmail, adminPassword }
}

async function promptApp(
  detected: DetectedProjectSetup,
  productionTarget: ProductionTarget,
): Promise<ScaffoldAppOptions> {
  const initialMode: ScaffoldAppOptions["mode"] =
    detected.hasVite && productionTarget !== "later"
      ? "static"
      : detected.hasVite
        ? "proxy"
        : "none"

  const mode = ensureNotCancelled(
    await p.select<ScaffoldAppOptions["mode"]>({
      message: "Host a frontend app at /?",
      initialValue: initialMode,
      options: [
        { value: "none", label: "No app", hint: "API only" },
        { value: "static", label: "Static site", hint: "serve a built directory" },
        { value: "proxy", label: "Local dev server", hint: "forward requests to a dev server you run" },
      ],
    }),
  )

  if (mode === "static") {
    const staticDir = ensureNotCancelled(
      await p.text({
        message: "Directory to serve",
        defaultValue: detected.staticDir,
        placeholder: detected.staticDir,
      }),
    ).trim() || detected.staticDir
    const viteDevUrl = await promptViteDevUrl(detected, productionTarget)
    return { mode, staticDir, ...(viteDevUrl ? { viteDevUrl } : {}) }
  }

  if (mode === "proxy") {
    const upstream = ensureNotCancelled(
      await p.text({
        message: "URL of your running dev server",
        defaultValue: detected.hasVite ? detected.viteDevUrl : "http://localhost:3000",
        placeholder: detected.hasVite ? detected.viteDevUrl : "http://localhost:3000",
      }),
    ).trim() || (detected.hasVite ? detected.viteDevUrl : "http://localhost:3000")
    const start = ensureNotCancelled(
      await p.text({
        message: "package.json script that starts your dev server",
        defaultValue: detected.hasVite ? "vite" : "dev",
        placeholder: detected.hasVite ? "vite" : "dev",
      }),
    ).trim() || (detected.hasVite ? "vite" : "dev")
    const viteDevUrl = await promptViteDevUrl(detected, productionTarget)
    return { mode, upstream, start, ...(viteDevUrl ? { viteDevUrl } : {}) }
  }

  return { mode: "none" }
}

async function promptViteDevUrl(
  detected: DetectedProjectSetup,
  productionTarget: ProductionTarget,
): Promise<string | undefined> {
  const defaultYes = detected.hasVite || productionTarget !== "later"
  const useVite = ensureNotCancelled(
    await p.confirm({
      message: detected.hasVite
        ? "Use Vite for local development?"
        : "Develop locally with Vite (live reload)?",
      initialValue: defaultYes,
    }),
  )
  if (!useVite) return undefined

  p.note(`Press Enter for ${detected.viteDevUrl}, or type a custom URL.`)

  return (
    ensureNotCancelled(
      await p.text({
        message: "Vite dev server URL",
        defaultValue: detected.viteDevUrl,
        placeholder: detected.viteDevUrl,
      }),
    ).trim() || detected.viteDevUrl
  )
}

// ─── Package manager ───────────────────────────────────────────────────────--

function detectInvokingPackageManager(): PackageManager {
  const ua = process.env["npm_config_user_agent"] ?? ""
  if (ua.startsWith("pnpm")) return "pnpm"
  if (ua.startsWith("yarn")) return "yarn"
  if (ua.startsWith("bun")) return "bun"
  return "npm"
}

function runInstall(dir: string, pm: PackageManager): boolean {
  const res = spawnSync(pm, ["install"], {
    cwd: dir,
    stdio: "inherit",
    shell: process.platform === "win32",
  })
  if (res.status !== 0 || res.error) {
    return false
  }
  return true
}

async function ensureInitBinaries(dir: string): Promise<boolean> {
  const previousCwd = process.cwd()
  try {
    process.chdir(dir)
    const config = loadConfig(dir)
    const result = await ensureComponentBinaries(config, dir)
    if (!result.ok) {
      reportComponentBinaryFailures(result.failures)
      return false
    }
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    warn(`Could not verify component binaries: ${message}`)
    warn("Run manually from your project directory: supatype update")
    return false
  } finally {
    process.chdir(previousCwd)
  }
}

function writeKeys(dir: string): boolean {
  const keys = generateAndWriteKeys(dir)
  if (!keys) {
    warn("Could not generate keys (JWT_SECRET missing). Run `supatype keys` manually.")
    return false
  }
  return true
}

// ─── Scaffold ──────────────────────────────────────────────────────────────--

export function scaffold(
  dir: string,
  optsOrName: ScaffoldOptions | string,
  deps: InitDependencyVersions = initDependencyVersionsFallback(),
): void {
  const opts =
    typeof optsOrName === "string" ? defaultScaffoldOptions(optsOrName) : optsOrName
  const write = (rel: string, content: string) => {
    const full = join(dir, rel)
    mkdirSync(resolve(full, ".."), { recursive: true })
    writeFileSync(full, content, "utf8")
    file("created", rel)
  }

  const pkgPath = join(dir, "package.json")
  if (!existsSync(pkgPath)) {
    write("package.json", packageJsonTemplate(opts, deps))
  } else {
    try {
      const existing = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>
      const merged = mergeSupatypePackageJson(existing, opts, deps)
      writeFileSync(pkgPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8")
      file("updated", "package.json (added Supatype dependencies)")
    } catch {
      warn("Could not merge into package.json — add @supatype/cli and @supatype/types manually.")
      file("skipped", "package.json (invalid JSON)")
    }
  }

  write("supatype.config.ts", tsConfigTemplate(opts))
  if (opts.productionTarget !== "later") {
    write("supatype.local.config.ts", localConfigTemplate(opts.app))
  }
  write(opts.schemaPath, schemaTemplate())
  write(".env", envTemplate(opts))
  write("seed.ts", seedTemplate(opts.projectName))
  write("seeds/.gitkeep", "")
  scaffoldAppAssets(dir, opts, write)

  if (opts.helloFunction) scaffoldHelloFunction(dir, write)

  const gitignorePath = join(dir, ".gitignore")
  if (existsSync(gitignorePath)) {
    const merged = mergeGitignoreTemplate(readFileSync(gitignorePath, "utf8"))
    if (merged !== readFileSync(gitignorePath, "utf8")) {
      writeFileSync(gitignorePath, merged, "utf8")
      file("updated", ".gitignore (added .supatype/)")
    } else {
      file("skipped", ".gitignore (already exists)")
    }
  } else {
    write(".gitignore", gitignoreTemplate())
  }
}

function staticDirRelative(staticDir?: string): string {
  const raw = (staticDir ?? "./public").trim()
  return raw.replace(/^\.\//, "").replace(/\/+$/, "") || "public"
}

function scaffoldAppAssets(
  dir: string,
  opts: ScaffoldOptions,
  write: (rel: string, content: string) => void,
): void {
  const writeUnlessExists = (rel: string, content: string) => {
    const full = join(dir, rel)
    if (existsSync(full)) {
      file("skipped", `${rel} (already exists)`)
      return
    }
    write(rel, content)
  }

  const holding = holdingPageTemplate(opts.projectName)
  const hasVite = Boolean(opts.app.viteDevUrl)

  if (opts.app.mode === "static") {
    const staticRel = staticDirRelative(opts.app.staticDir)
    if (opts.app.viteDevUrl && opts.productionTarget !== "later") {
      writeUnlessExists("dist/index.html", holding)
      scaffoldVite(dir, opts, writeUnlessExists, holding)
      return
    }
    writeUnlessExists(`${staticRel}/index.html`, holding)
    if (opts.app.viteDevUrl) scaffoldVite(dir, opts, writeUnlessExists, holding)
    return
  }

  if (opts.app.mode === "proxy" && opts.productionTarget !== "later") {
    writeUnlessExists("dist/index.html", holding)
    if (hasVite) scaffoldVite(dir, opts, writeUnlessExists, holding)
    return
  }

  if (opts.app.mode === "proxy" && hasVite) {
    scaffoldVite(dir, opts, writeUnlessExists, holding)
    return
  }

  writeUnlessExists("public/.gitkeep", "")
}

function scaffoldVite(
  dir: string,
  opts: ScaffoldOptions,
  write: (rel: string, content: string) => void,
  holding: string,
): void {
  if (!opts.app.viteDevUrl) return
  write("index.html", holding)
  const viteConfigRel = ["vite.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.cjs"].find(
    (name) => existsSync(join(dir, name)),
  )
  if (viteConfigRel) {
    file("skipped", `${viteConfigRel} (already exists)`)
    return
  }
  write("vite.config.ts", viteConfigTemplate(opts.app.viteDevUrl))
}

function scaffoldHelloFunction(
  dir: string,
  write: (rel: string, content: string) => void,
): void {
  write("functions/hello/index.ts", helloFunctionTemplate())
  if (!existsSync(join(dir, "functions/_shared/README.md"))) {
    write("functions/_shared/README.md", sharedFunctionsReadme())
  }
  if (!existsSync(join(dir, "functions/.env.local"))) {
    write("functions/.env.local", functionsEnvLocalTemplate())
  }
  const denoTypes = ensureFunctionsDenoTypes(dir, join(dir, "functions"))
  if (denoTypes.wroteDenoDts) file("created", "functions/deno.d.ts")
  if (denoTypes.wroteTsconfig) file("created", "functions/tsconfig.json")
  if (denoTypes.rootExclude === "updated") {
    file("updated", 'tsconfig.json (exclude "functions")')
  }
}

// ─── Templates ───────────────────────────────────────────────────────────────

function packageJsonTemplate(opts: ScaffoldOptions, deps: InitDependencyVersions): string {
  const scripts: string[] = [
    `    "dev": "supatype dev"`,
    `    "push": "supatype push"`,
    `    "seed": "tsx seed.ts"`,
  ]
  if (opts.app.viteDevUrl) {
    scripts.push(`    "vite": "vite"`)
  }
  if (opts.helloFunction) {
    scripts.push(`    "functions": "supatype functions serve"`)
  }
  const devDeps = [`    "tsx": "^4.19.2"`, `    "typescript": "^5"`]
  if (opts.app.viteDevUrl) {
    devDeps.push(`    "vite": "^6"`)
  }
  return `{
  "name": "${opts.projectName}",
  "private": true,
  "type": "module",
  "scripts": {
${scripts.join(",\n")}
  },
  "dependencies": {
    "@supatype/cli": "^${deps.cli}",
    "@supatype/types": "^${deps.types}"
  },
  "devDependencies": {
${devDeps.join(",\n")}
  }
}
`
}

function tsConfigTemplate(opts: ScaffoldOptions): string {
  const serverMode = serverModeForTarget(opts.productionTarget)
  const hasLocalOverride = opts.productionTarget !== "later"
  const lines: string[] = []
  lines.push(`import { defineConfig } from "@supatype/cli"`)
  lines.push("")
  if (hasLocalOverride) {
    lines.push(`// Committed config = ${opts.productionTarget} production target.`)
    lines.push(`// Local development overrides live in supatype.local.config.ts (gitignored).`)
  }
  lines.push(`export default defineConfig({`)
  lines.push(`  project: { name: "${opts.projectName}" },`)
  lines.push(`  provider: "${opts.provider}",`)
  if (opts.provider === "docker") {
    lines.push(`  // provider: "native"  // host Postgres + supatype-server binaries (no Docker)`)
  }
  lines.push(`  database: {`)
  lines.push(`    provider: "${opts.provider}",`)
  lines.push(`  },`)
  lines.push(`  server: {`)
  lines.push(`    mode: "${serverMode}",`)
  lines.push(`    port: 54321,`)
  if (serverMode === "standalone") {
    lines.push(`    domain: "${opts.domain ?? ""}",  // e.g. "api.example.com" for ACME TLS`)
    if (opts.tlsEmail) {
      lines.push(`    tls: { email: "${opts.tlsEmail}" },  // automatic HTTPS via Let's Encrypt`)
    } else {
      lines.push(`    // tls: { email: "you@example.com" },  // set to enable automatic HTTPS (Let's Encrypt)`)
    }
  }
  lines.push(`  },`)
  lines.push(...appConfigLines(opts.app, opts.productionTarget))
  if (opts.productionTarget !== "later") {
    lines.push(`  environments: { default: "production" },  // supatype link --env production ...`)
  }
  lines.push(
    `  // Optional: pin component versions (native cache + Docker images synced to .env on dev/push)`,
  )
  lines.push(`  // versions: { engine: "0.1.2", server: "1.0.5", postgres: "17.2", deno: "2.2.0" },`)
  lines.push(`  email: { provider: "${opts.email}" },`)
  lines.push(...storageConfigLines(opts.storageLocal, opts.storageProduction))
  lines.push(`  schema: { path: "${opts.schemaPath}", pg_schema: "public" },`)
  lines.push(
    `  // Self-host production: supatype self-host compose (Docker only). Standalone + domain = native ACME dev.`,
  )
  lines.push(`})`)
  return lines.join("\n") + "\n"
}

function localConfigTemplate(app: ScaffoldAppOptions): string {
  const lines: string[] = [
    `import type { SupatypeConfig } from "@supatype/cli"`,
    ``,
    `// Local development overrides — gitignored, deep-merged over supatype.config.ts.`,
    `// Keeps \`supatype dev\` in local mode while the committed config targets production.`,
    `const localConfig: Partial<SupatypeConfig> = {`,
    `  server: { mode: "dev" },`,
  ]
  const localApp = localDevAppConfigLines(app)
  if (localApp.length > 0) {
    lines.push(...localApp)
  }
  lines.push(`}`, ``, `export default localConfig`, ``)
  return lines.join("\n")
}

/** App block for supatype.local.config.ts (proxy + Vite during local dev). */
function localDevAppConfigLines(app: ScaffoldAppOptions): string[] {
  if (app.mode === "proxy") {
    return [
      `  app: {`,
      `    mode: "proxy",`,
      `    upstream: "${app.upstream ?? "http://localhost:3000"}",`,
      `    start: "${app.start ?? "dev"}",`,
      ...(app.viteDevUrl ? [`    vite_dev_url: "${app.viteDevUrl}",`] : []),
      `  },`,
    ]
  }
  if (app.viteDevUrl) {
    return [
      `  app: {`,
      `    mode: "proxy",`,
      `    upstream: "${app.viteDevUrl}",`,
      `    start: "vite",`,
      `    vite_dev_url: "${app.viteDevUrl}",`,
      `  },`,
    ]
  }
  return []
}

function appConfigLines(app: ScaffoldAppOptions, productionTarget: ProductionTarget): string[] {
  if (app.mode === "static") {
    if (productionTarget !== "later" && app.viteDevUrl) {
      return [
        `  app: {`,
        `    mode: "static",`,
        `    static_dir: "./dist",  // production build output`,
        `  },`,
      ]
    }
    const out = [
      `  app: {`,
      `    mode: "static",`,
      `    static_dir: "${app.staticDir ?? "./public"}",`,
    ]
    if (app.viteDevUrl) out.push(`    vite_dev_url: "${app.viteDevUrl}",`)
    out.push(`  },`)
    return out
  }
  if (app.mode === "proxy") {
    if (productionTarget !== "later") {
      return [
        `  app: {`,
        `    mode: "static",`,
        `    static_dir: "./dist",  // production build output`,
        `  },`,
      ]
    }
    const out = [
      `  app: {`,
      `    mode: "proxy",`,
      `    upstream: "${app.upstream ?? "http://localhost:3000"}",`,
      `    start: "${app.start ?? "dev"}",`,
    ]
    if (app.viteDevUrl) out.push(`    vite_dev_url: "${app.viteDevUrl}",`)
    out.push(`  },`)
    return out
  }
  return [
    `  app: {`,
    `    mode: "none",`,
    `    // mode: "static", static_dir: "./public",  // supatype app add --static ./public`,
    `    // mode: "proxy", upstream: "http://localhost:3000", start: "dev",`,
    `    // vite_dev_url: "http://127.0.0.1:5173",  // live reload from a separate Vite dev server`,
    `  },`,
  ]
}

const HOLDING_PAGE_LOGO_URL = "https://supatype.github.io/supatype/supatype.svg"
const HOLDING_PAGE_DOCS_URL = "https://supatype.github.io/supatype/"
const HOLDING_PAGE_GITHUB_URL = "https://github.com/supatype"
const HOLDING_PAGE_DISCORD_URL = "https://discord.gg/yaQrjQD4"

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function holdingPageTemplate(projectName: string): string {
  const name = escapeHtml(projectName)
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${name} — Supatype</title>
    <meta name="description" content="A Supatype project. Define your types — we generate your platform." />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
    <style>
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      :root {
        --bg: #0a0a0f;
        --border: rgba(255, 255, 255, 0.08);
        --text: #e8e8f0;
        --text-muted: #8888a8;
        --purple: #7c3aed;
        --purple-light: #a855f7;
      }
      body {
        min-height: 100vh;
        font-family: Inter, system-ui, sans-serif;
        background: var(--bg);
        color: var(--text);
        line-height: 1.6;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 2rem;
      }
      body::before {
        content: "";
        position: fixed;
        inset: 0;
        background: radial-gradient(ellipse 80% 50% at 50% -20%, rgba(124, 58, 237, 0.18), transparent);
        pointer-events: none;
      }
      main {
        position: relative;
        max-width: 32rem;
        width: 100%;
        text-align: center;
      }
      .logo {
        display: block;
        height: 2rem;
        width: auto;
        margin: 0 auto 2rem;
      }
      h1 {
        font-size: 1.5rem;
        font-weight: 700;
        letter-spacing: -0.02em;
        margin-bottom: 0.75rem;
      }
      .tagline {
        color: var(--text-muted);
        font-size: 1rem;
        margin-bottom: 2rem;
      }
      .links {
        display: flex;
        flex-wrap: wrap;
        gap: 0.75rem;
        justify-content: center;
        margin-bottom: 2.5rem;
      }
      .links a {
        display: inline-flex;
        align-items: center;
        padding: 0.6rem 1.1rem;
        border-radius: 10px;
        border: 1px solid var(--border);
        color: var(--text);
        text-decoration: none;
        font-size: 0.9rem;
        font-weight: 500;
        transition: border-color 0.15s, background 0.15s;
      }
      .links a:hover {
        border-color: rgba(168, 85, 247, 0.45);
        background: rgba(124, 58, 237, 0.08);
      }
      .links a.primary {
        background: linear-gradient(135deg, var(--purple), var(--purple-light));
        border-color: transparent;
        color: #fff;
      }
      .links a.primary:hover {
        opacity: 0.92;
      }
      .hint {
        font-size: 0.85rem;
        color: var(--text-muted);
      }
      .hint code {
        font-family: ui-monospace, "JetBrains Mono", monospace;
        font-size: 0.8rem;
        background: rgba(255, 255, 255, 0.06);
        padding: 0.15rem 0.4rem;
        border-radius: 4px;
      }
    </style>
  </head>
  <body>
    <main>
      <img class="logo" src="${HOLDING_PAGE_LOGO_URL}" alt="Supatype" width="160" height="30" />
      <h1>${name}</h1>
      <p class="tagline">Your Supatype project is ready. Replace this page when you build your app.</p>
      <nav class="links" aria-label="Supatype resources">
        <a class="primary" href="${HOLDING_PAGE_DOCS_URL}" target="_blank" rel="noopener noreferrer">Documentation</a>
        <a href="${HOLDING_PAGE_GITHUB_URL}" target="_blank" rel="noopener noreferrer">GitHub</a>
        <a href="${HOLDING_PAGE_DISCORD_URL}" target="_blank" rel="noopener noreferrer">Discord</a>
      </nav>
      <p class="hint">Run <code>supatype dev</code> then open <code>http://localhost:18473/</code></p>
    </main>
  </body>
</html>
`
}

function vitePortFromDevUrl(viteDevUrl: string): number {
  try {
    const url = new URL(viteDevUrl)
    if (url.port) return Number.parseInt(url.port, 10)
    return url.protocol === "https:" ? 443 : 80
  } catch {
    return 5173
  }
}

function viteConfigTemplate(viteDevUrl: string): string {
  const port = vitePortFromDevUrl(viteDevUrl)
  return `import { defineConfig } from "vite"

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: ${port},
    strictPort: true,
    // Docker Compose app proxy reaches the host as host.docker.internal.
    allowedHosts: ["127.0.0.1", "localhost", "host.docker.internal"],
  },
})
`
}

function storageConfigLines(
  storageLocal: StorageProvider,
  storageProduction: StorageProvider,
): string[] {
  const lines: string[] = []
  if (storageLocal === "s3") {
    lines.push(`  storage: { provider: "s3" },  // dev — configure S3_* in .env`)
  } else {
    lines.push(`  storage: { provider: "local", local_path: ".supatype/storage" },`)
  }
  if (storageProduction === "s3" && storageLocal !== "s3") {
    lines.push(`  // Production storage: external S3 bucket — set production S3_* in .env`)
  } else if (storageProduction === "local" && storageLocal === "s3") {
    lines.push(`  // Production storage: MinIO on your server (included in self-host compose)`)
  }
  return lines
}

function schemaTemplate(): string {
  return `import type { Model, LoggedIn, Owner, Public, Role, SupatypeAuthUserId, UUID } from "@supatype/types"

/** App profile for a signed-in user. \`id\` matches the Supatype auth user id. */
export type Profile = Model<{
  id: SupatypeAuthUserId
  display_name: string
}, {
  access: {
    read: LoggedIn
    create: Owner<"id">
    update: Owner<"id">
    delete: Owner<"id">
  }
}>

/** Example singleton global — editable in Studio under Settings. */
export type SiteSettings = Model<{
  id: UUID
  site_name: string
}, {
  singleton: true
  access: {
    read: Public
    update: Role<"admin">
  }
}>
`
}

function envTemplate(opts: ScaffoldOptions): string {
  const sections: string[] = []
  sections.push(`DATABASE_URL=postgresql://supatype_admin:postgres@localhost:5432/${opts.projectName}
POSTGRES_USER=supatype_admin
POSTGRES_PASSWORD=postgres
POSTGRES_DB=${opts.projectName}`)

  sections.push(`# JWT — run \`supatype keys\` to generate ANON_KEY and SERVICE_ROLE_KEY
JWT_SECRET=super-secret-jwt-token-change-in-production
ANON_KEY=
SERVICE_ROLE_KEY=`)

  sections.push(`# Site URL (used by GoTrue for email redirects)
SITE_URL=http://localhost:3000`)

  if (opts.provider === "docker" && opts.kongPort !== undefined) {
    const apiUrl = `http://localhost:${opts.kongPort}`
    sections.push(
      `# Local API gateway (Kong) — unique per project so multiple stacks can run concurrently
SUPATYPE_KONG_PORT=${opts.kongPort}
PUBLIC_SUPATYPE_URL=${apiUrl}
API_EXTERNAL_URL=${apiUrl}
VITE_SUPATYPE_URL=${apiUrl}
VITE_SUPATYPE_ANON_KEY=`,
    )
  }

  sections.push(emailEnvSection(opts.email, opts.projectName))
  sections.push(storageEnvSections(opts.storageLocal, opts.storageProduction))

  if (opts.adminEmail && opts.adminPassword) {
    sections.push(
      `# First admin for /admin — consumed on first supatype dev or push (password removed after use)
SUPATYPE_ADMIN_EMAIL=${opts.adminEmail}
SUPATYPE_ADMIN_PASSWORD=${opts.adminPassword}`,
    )
  }

  sections.push(
    `# Self-host compose uses the same DATABASE_URL when Postgres is published on localhost:5432`,
  )

  return sections.join("\n\n") + "\n"
}

function emailEnvSection(email: ScaffoldOptions["email"], projectName: string): string {
  switch (email) {
    case "resend":
      return `# Email (Resend)
RESEND_API_KEY=
RESEND_FROM=onboarding@resend.dev`
    case "ses":
      return `# Email (Amazon SES)
SES_FROM=
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=`
    case "smtp":
      return `# Email (SMTP)
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_SENDER_NAME=${projectName}`
    case "console":
    default:
      return `# SMTP — leave empty to use email autoconfirm in dev (no emails sent)
SMTP_HOST=
SMTP_PORT=
SMTP_USER=
SMTP_PASS=
SMTP_SENDER_NAME=${projectName}`
  }
}

function storageEnvSections(
  storageLocal: StorageProvider,
  storageProduction: StorageProvider,
): string {
  if (storageLocal === storageProduction) {
    if (storageLocal === "s3") {
      return `# Storage (local development and production — external bucket)
# Use separate buckets for dev and production in your provider.
S3_ENDPOINT=
S3_REGION=us-east-1
S3_BUCKET=
S3_ACCESS_KEY=
S3_SECRET_KEY=`
    }
    return `${localStorageEnvSection("local")}

# Production storage (MinIO on your server)
# Included in the self-host compose stack — no extra configuration needed.`
  }

  return [localStorageEnvSection(storageLocal), productionStorageEnvSection(storageProduction)].join(
    "\n\n",
  )
}

function localStorageEnvSection(storage: StorageProvider): string {
  if (storage === "s3") {
    return `# Storage (local development — external bucket)
S3_ENDPOINT=
S3_REGION=us-east-1
S3_BUCKET=
S3_ACCESS_KEY=
S3_SECRET_KEY=`
  }
  return `# Storage (local development — MinIO)
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY=supatype
S3_SECRET_KEY=supatype-secret`
}

function productionStorageEnvSection(storage: StorageProvider): string {
  if (storage === "s3") {
    return `# Storage (production — external bucket)
S3_ENDPOINT=
S3_REGION=us-east-1
S3_BUCKET=
S3_ACCESS_KEY=
S3_SECRET_KEY=`
  }
  return `# Storage (production — MinIO on your server)
# Included in the self-host compose stack — no extra configuration needed.`
}

function seedTemplate(projectName: string): string {
  return `import { sql } from "@supatype/cli/seed"

// Connect using DATABASE_URL from environment
const db = sql(
  process.env["DATABASE_URL"] ??
    "postgresql://supatype_admin:postgres@localhost:5432/${projectName}",
)

async function seed() {
  console.log("Seeding ${projectName}...")

  // TODO: insert seed data
  // await db\`INSERT INTO profile (id, display_name) VALUES ('...', 'Admin')\`

  await db.end()
  console.log("Done.")
}

seed().catch((e) => {
  console.error(e)
  process.exit(1)
})
`
}

function helloFunctionTemplate(): string {
  return `// hello — Supatype Edge Function
// Docs: https://supatype.com/docs/edge-functions

export default async function handler(req: Request): Promise<Response> {
  const { method } = req
  const url = Deno.env.get("SUPATYPE_URL")

  if (method === "POST") {
    const body = await req.json()
    return new Response(JSON.stringify({ message: "Hello from hello!", received: body, url }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }

  return new Response(JSON.stringify({ message: "Hello from hello!", url }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}
`
}

function sharedFunctionsReadme(): string {
  return "# Shared Code\n\nFiles in `_shared/` are available to all functions via relative imports.\nThis directory is not deployed as a function.\n\nExample: `import { sendEmail } from '../_shared/email.ts'`\n"
}

function functionsEnvLocalTemplate(): string {
  return "# Local environment variables for edge functions\n# These are NOT committed to git\n# Set production env vars via: npx supatype functions env set KEY=value\n"
}

function gitignoreTemplate(): string {
  return `.env
node_modules/
dist/
.supatype/
supatype.local.config.ts
supatype.local.config.js
supatype.local.config.mjs
# Generated by supatype push (legacy paths — prefer output.types in config)
src/types/supatype.d.ts
src/lib/supatype.ts
`
}

export function mergeGitignoreTemplate(existingContent: string): string {
  if (existingContent.includes(".supatype/") || existingContent.includes(".supatype\n")) {
    return existingContent
  }
  const block = `
# Supatype — local runtime (contains secrets in link.json)
.supatype/
`
  return existingContent.endsWith("\n") ? `${existingContent}${block}` : `${existingContent}\n${block}`
}

// ─── Next steps ────────────────────────────────────────────────────────────--

function warnDockerUnavailableForProvider(provider: ScaffoldOptions["provider"]): void {
  if (provider !== "docker") return
  const probe = probeDockerDaemon()
  if (probe.ok) return
  reportDockerUnavailable(probe)
  plain()
}

function printNextSteps(args: {
  name: string | undefined
  result: WizardResult
  installed: boolean
  keysGenerated: boolean
  binariesReady: boolean
}): void {
  const { name, result, installed, keysGenerated, binariesReady } = args
  const setupComplete = installed && keysGenerated && binariesReady
  const steps: string[] = []
  if (name) steps.push(`cd ${name}`)
  const kongHint =
    result.provider === "docker" && result.kongPort !== undefined
      ? `supatype dev          # Docker Compose stack (Kong :${result.kongPort})`
      : "supatype dev          # Docker Compose stack (Kong :18473)"
  if (setupComplete) {
    steps.push(kongHint)
    steps.push("supatype push         # apply schema + generate types")
    if (result.adminEmail) {
      steps.push("                      # first admin user is created on dev or push")
    }
  } else {
    if (!installed) steps.push(`${result.packageManager} install`)
    if (!binariesReady) steps.push("supatype update        # download component binaries")
    if (!keysGenerated) steps.push("supatype keys")
    steps.push(kongHint)
    steps.push("supatype push         # apply schema + generate types")
  }
  if (result.helloFunction) {
    steps.push("supatype functions serve   # run edge functions locally")
  }

  info(`Supatype project ready${name ? ` in ${name}/` : ""}.`)
  nextSteps(setupComplete ? "Next steps:" : "Finish setup:", steps)

  if (result.app.mode === "none") {
    nextSteps("Static frontend (self-host):", [
      "supatype app add --static ./public",
      "npm run build         # write files into public/",
      "supatype self-host compose up -d",
    ])
  }

  if (result.productionTarget === "cloud") {
    nextSteps("Deploy to Supatype Cloud:", [
      "supatype login",
      "supatype link --env production --project <ref>",
      "supatype push --env production",
    ])
    info("supatype.local.config.ts keeps `supatype dev` local while the committed config targets cloud.")
  } else if (result.productionTarget === "self-host") {
    const selfHostSteps: string[] = []
    const domain = result.domain?.trim()
    if (domain) {
      selfHostSteps.push(`1. Point DNS: an A record for ${domain} -> your server's public IP`)
      selfHostSteps.push("2. Open ports 80 and 443 on the server firewall")
      if (!result.tlsEmail) {
        selfHostSteps.push("3. Set server.tls.email in supatype.config.ts (required for HTTPS)")
      }
      selfHostSteps.push("supatype self-host compose up -d   # Kong provisions HTTPS automatically")
      selfHostSteps.push(`Your Supatype platform goes live at https://${domain}`)
      selfHostSteps.push(
        "Your app, REST, Auth, Storage, Realtime, Functions, and Studio — all behind one HTTPS domain (certs persist in valkey-data)",
      )
    } else {
      selfHostSteps.push(
        "Set server.domain + server.tls.email in supatype.config.ts to enable automatic HTTPS",
      )
      selfHostSteps.push("supatype self-host compose up -d   # Docker stack")
    }
    selfHostSteps.push("supatype link --env production ... # then: supatype push --env production")
    nextSteps("Self-host production (your own server):", selfHostSteps)
    info("supatype.local.config.ts keeps `supatype dev` local while the committed config targets self-host.")
  }
  plain()
}
