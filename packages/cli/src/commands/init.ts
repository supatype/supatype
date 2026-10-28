import type { Command } from "commander"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve, join, basename } from "node:path"
import { spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { p, runClackFlow } from "../ui/clack.js"
import { ensureNotCancelled } from "../ui/prompts.js"
import { generateAndWriteKeys } from "./keys.js"
import {
  CONTROL_PLANE_SECRET_ENV,
  generateControlPlaneSecret,
  givenJwtSecret,
  newJwtSecret,
} from "../local-secrets.js"
import { file, error, info, plain, warn } from "../ui/messages.js"
import { nextSteps } from "../ui/next-steps.js"
import { probeDockerDaemon, reportDockerUnavailable } from "../docker-runtime.js"
import { loadConfig } from "../config.js"
import {
  ensureComponentBinaries,
  reportComponentBinaryFailures,
} from "../ensure-component-binaries.js"
import {
  ensureFunctionsDenoTypes,
  sharedFunctionsReadmeSource,
} from "../functions-deno-types.js"
import { functionTemplateSource } from "../functions-template.js"
import { mergeSupatypePackageJson } from "../init-package-json.js"
import { downloadRelease, initFromExample } from "../init-example.js"
import { errorMessage } from "../error-message.js"
import { parseJsonObject } from "@supatype/shared"
import { cliPackageVersion } from "../cli-package-version.js"
import {
  initDependencyVersionsFallback,
  resolveInitDependencyVersions,
  type InitDependencyVersions,
} from "../init-dependency-versions.js"
import { detectProjectSetup, type DetectedProjectSetup } from "../init-project-detect.js"
import { SUPATYPE_GITIGNORE_PATHS } from "../gitignore.js"
import { DEFAULT_CLIENT_PATH, DEFAULT_TYPES_PATH } from "../type-generation.js"

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
  { value: "local", label: "Local", hint: "storage you host yourself (SeaweedFS)" },
  { value: "s3", label: "S3", hint: "external bucket (AWS S3 or compatible)" },
]

/** Wizard result = scaffold options plus runtime actions (install / keys). */
export interface WizardResult extends ScaffoldOptions {
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
  example?: string
}

/**
 * `init <dir> --example <name>`: the example from this CLI's release, in place of the scaffold. Its
 * README carries the rest of the setup, so the next steps end there.
 */
async function runExampleInit(name: string | undefined, example: string): Promise<void> {
  const target = name ?? example
  const dir = resolve(process.cwd(), target)
  const version = cliPackageVersion()
  try {
    info(`Downloading the ${example} example from supatype v${version}...`)
    const { files, hasReadme } = await initFromExample({ dir, example, version, download: downloadRelease })
    info(`Wrote ${files} files to ${target}/, with @supatype dependencies pinned to ^${version}.`)
    nextSteps("Next steps:", [
      `cd ${target}`,
      `${detectInvokingPackageManager()} install`,
      hasReadme ? "Then follow README.md: it has the rest of this example's setup." : "supatype dev",
    ])
  } catch (err) {
    error(errorMessage(err))
    process.exit(1)
  }
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
    .option("--example <name>", "Start from an example of this CLI's release (examples/<name> on GitHub)")
    .action(async (name: string | undefined, opts: InitCliOptions) => {
      if (opts.example !== undefined) {
        await runExampleInit(name, opts.example)
        return
      }
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
          const { chooseInitKongPort } = await import("../dev-ports.js")
          result.kongPort = await chooseInitKongPort()
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

      const deps = await resolveDependencyVersions()

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
        error("Could not generate API keys. Check the project has a .env, then run `supatype keys`.")
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

/** Interactive init: one Ink session for wizard + scaffold + install + finish. */
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
    let result = await collectWizardAnswers({
      defaultName,
      defaultTarget: modeTarget,
      dir,
      detected,
      askName: name === undefined,
    })

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

    const deps = await resolveDependencyVersions()

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
      error("Could not generate API keys. Check the project has a .env, then run `supatype keys`.")
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

export interface WizardContext {
  defaultName: string
  defaultTarget: ProductionTarget
  dir: string
  detected: DetectedProjectSetup
  /** False when `init <name>` already named the project. */
  askName: boolean
}

export async function collectWizardAnswers(context: WizardContext): Promise<WizardResult> {
    const { defaultName, defaultTarget, dir, detected } = context
    const projectName = context.askName ? await promptProjectName(defaultName) : defaultName

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

    // No production to store for yet: production storage is chosen with the production target.
    const storageProduction = productionTarget === "later" ? storageLocal : await promptProductionStorage()

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

async function promptProjectName(defaultName: string): Promise<string> {
  const answer = ensureNotCancelled(
    await p.text({ message: "Project name", defaultValue: defaultName, placeholder: defaultName }),
  )
  return answer.trim() || defaultName
}

async function promptProductionStorage(): Promise<StorageProvider> {
  return ensureNotCancelled(
    await p.select<StorageProvider>({
      message: "Production storage?",
      initialValue: "local",
      options: STORAGE_PROVIDER_OPTIONS,
    }),
  )
}

async function promptAdminUser(): Promise<{ adminEmail?: string; adminPassword?: string }> {
  const createAdmin = ensureNotCancelled(
    await p.confirm({
      message: "Create an admin user for Studio (/studio/)?",
      initialValue: true,
    }),
  )
  if (!createAdmin) return {}

  p.note("First sign-in to Studio at /studio/, created automatically on supatype dev or push.")

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
    const message = errorMessage(err)
    warn(`Could not verify component binaries: ${message}`)
    warn("Run manually from your project directory: supatype update")
    return false
  } finally {
    process.chdir(previousCwd)
  }
}

function writeKeys(dir: string): boolean {
  const keys = generateAndWriteKeys(dir)
  if (!keys.ok) {
    warn(`Could not write keys: ${keys.reason} Run \`supatype keys\` in the project once that is fixed.`)
    return false
  }
  return true
}

/**
 * The new .env's JWT_SECRET: the shell's when one is exported and usable, else a generated one.
 * Warned about rather than refused when the shell's is unusable, since init is mid-wizard.
 */
function initialJwtSecret(): string {
  const { secret, problem } = newJwtSecret(givenJwtSecret())
  if (problem !== undefined) warn(`${problem} Generated a JWT_SECRET for .env instead.`)
  return secret
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
      const existing = parseJsonObject(readFileSync(pkgPath, "utf8"))
      if (!existing.ok) throw new Error("package.json is not a JSON object")
      const merged = mergeSupatypePackageJson(existing.value, opts, deps)
      writeFileSync(pkgPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8")
      file("updated", "package.json (added Supatype dependencies)")
    } catch {
      warn("Could not merge into package.json, add @supatype/cli and @supatype/types manually.")
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
  write("functions/hello/index.ts", functionTemplateSource("hello"))
  if (!existsSync(join(dir, "functions/_shared/README.md"))) {
    write("functions/_shared/README.md", sharedFunctionsReadmeSource())
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

/** The Supatype package versions to pin, saying so when the registry moved any off the running CLI's. */
async function resolveDependencyVersions(): Promise<InitDependencyVersions> {
  const deps = await resolveInitDependencyVersions()
  const runningCli = cliPackageVersion()
  if (deps.cli !== runningCli || deps.types !== runningCli || deps.client !== runningCli) {
    info(
      `Using published npm versions: @supatype/cli ^${deps.cli}, @supatype/types ^${deps.types}, ` +
        `@supatype/client ^${deps.client}`,
    )
  }
  return deps
}

function packageJsonTemplate(opts: ScaffoldOptions, deps: InitDependencyVersions): string {
  const scripts: string[] = [
    `    "dev": "supatype dev"`,
    `    "push": "supatype push"`,
    `    "seed": "supatype seed"`,
    // The generated seed builder is gitignored, so a fresh clone has to produce it before
    // anything can import it. `generate` is fully offline, which is the condition that makes
    // gitignoring generated code reasonable rather than a trap; without this hook it would be
    // one, and the failure would be a missing module rather than anything naming the remedy.
    `    "prepare": "supatype generate"`,
  ]
  if (opts.app.viteDevUrl) {
    scripts.push(`    "vite": "vite"`)
  }
  if (opts.helloFunction) {
    scripts.push(`    "functions": "supatype functions serve"`)
  }
  // Both are development-time only, so they belong in devDependencies. Validated end to end
  // against a real database: schema/index.ts imports @supatype/types with `import type`, which is
  // erased at build; supatype.config.ts imports defineConfig, which only the CLI evaluates; and
  // seed.ts is run by `tsx seed.ts`. Nothing `supatype push` or `supatype generate` writes refers
  // to either package: the generated types import nothing. The generated client
  // (supatype/generated/client.ts) imports @supatype/client at runtime, so that one is a real
  // dependency.
  //
  // In dependencies they were installed by `npm install --omit=dev`, so every production install
  // of a Supatype app pulled the whole CLI toolchain (ink, react, typescript, ts-morph, pg, tsx)
  // to support three files that never run in production.
  const devDeps = [
    `    "@supatype/cli": "^${deps.cli}"`,
    `    "@supatype/types": "^${deps.types}"`,
    `    "tsx": "^4.19.2"`,
    `    "typescript": "^5"`,
  ]
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
    "@supatype/client": "^${deps.client}"
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
  // The native server listens on server.port. A docker project's API is on the gateway port in
  // .env (SUPATYPE_KONG_PORT), so writing 54321 there only named a port nothing listened on.
  if (opts.provider === "native") lines.push(`    port: 54321,`)
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
  lines.push(`  // Regenerated by dev, push and generate on every schema change.`)
  lines.push(`  output: { types: "${DEFAULT_TYPES_PATH}", client: "${DEFAULT_CLIENT_PATH}" },`)
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
    `// Local development overrides, gitignored, deep-merged over supatype.config.ts.`,
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
const HOLDING_PAGE_DISCORD_URL = "https://discord.gg/TzMtynufEH"

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
    <title>${name}: Supatype</title>
    <meta name="description" content="A Supatype project. Define your types, we generate your platform." />
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
    lines.push(`  storage: { provider: "s3" },  // dev, configure S3_* in .env`)
  } else {
    lines.push(`  storage: { provider: "local", local_path: ".supatype/storage" },`)
  }
  if (storageProduction === "s3" && storageLocal !== "s3") {
    lines.push(`  // Production storage: external S3 bucket, set production S3_* in .env`)
  } else if (storageProduction === "local" && storageLocal === "s3") {
    lines.push(`  // Production storage: SeaweedFS on your server (included in self-host compose)`)
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

/** Example singleton global: editable in Studio under Settings. */
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
  // Generated, not constant. These reach a server: the previous defaults meant a self-host
  // deployment ran with a password of `postgres` and a JWT secret published in this repo,
  // and anyone holding that secret can mint a token naming any Postgres role. Safe to generate
  // only because `supatype dev` no longer overwrites them on every run (see local-secrets.ts).
  const postgresPassword = randomBytes(24).toString("base64url")

  sections.push(`DATABASE_URL=postgresql://supatype_admin:${encodeURIComponent(postgresPassword)}@localhost:5432/${opts.projectName}
POSTGRES_USER=supatype_admin
POSTGRES_PASSWORD=${postgresPassword}
POSTGRES_DB=${opts.projectName}

# PostgREST's own database credential. It connects as \`authenticator\`, a role that holds no
# privileges and can only switch to anon/authenticated/service_role, so a request whose JWT
# names any other role is refused by Postgres rather than honoured.
#
# Deliberately NOT the same as POSTGRES_PASSWORD: that one is yours, for direct SQL access, and
# rotating it should never take the REST API down with it.
AUTHENTICATOR_PASSWORD=${randomBytes(24).toString("base64url")}

# Studio's SQL editor connects as \`supatype_sql_editor\`, a role that is not a superuser, so a
# query typed there runs without superuser rights. Kept apart from both passwords above.
SUPATYPE_SQL_EDITOR_PASSWORD=${randomBytes(24).toString("base64url")}`)

  // A usable JWT_SECRET exported in the shell goes into the new .env, so tokens the developer
  // already signed with it keep working. From then on .env's wins over the shell's.
  sections.push(`# JWT: ANON_KEY and SERVICE_ROLE_KEY are derived from this secret.
# Changing it invalidates every issued token; re-run \`supatype keys\` afterwards.
JWT_SECRET=${initialJwtSecret()}
ANON_KEY=
SERVICE_ROLE_KEY=`)

  sections.push(`# Shared by the API server and the control plane only. The control plane refuses any
# request without it, so code running in the functions worker cannot call it directly.
${CONTROL_PLANE_SECRET_ENV}=${generateControlPlaneSecret()}`)

  sections.push(`# Site URL (used for email redirects)
SITE_URL=http://localhost:3000`)

  if (opts.provider === "docker" && opts.kongPort !== undefined) {
    const apiUrl = `http://localhost:${opts.kongPort}`
    sections.push(
      `# Local API gateway (Kong), unique per project so multiple stacks can run concurrently
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
      `# First Studio admin (/studio/), consumed on first supatype dev or push (password removed after use)
SUPATYPE_ADMIN_EMAIL=${opts.adminEmail}
SUPATYPE_ADMIN_PASSWORD=${opts.adminPassword}`,
    )
  }

  sections.push(SELF_HOST_PORTS_ENV_SECTION)

  return sections.join("\n\n") + "\n"
}

/**
 * The host ports `supatype self-host compose` publishes, with their defaults. Commented out so the
 * defaults apply; the first anyone heard of these used to be a clash on 5432.
 */
const SELF_HOST_PORTS_ENV_SECTION = `# Self-host stack ports (supatype self-host compose). Kong, at SUPATYPE_KONG_PORT, is the way in.
# Postgres, the API server and SeaweedFS bind 127.0.0.1 only. To reach them from other machines,
# set SUPATYPE_PUBLISH_ADDRESS=0.0.0.0 (put a firewall in front of the server first).
# A self-host push points DATABASE_URL at SUPATYPE_DB_PORT.
# SUPATYPE_PUBLISH_ADDRESS=127.0.0.1
# SUPATYPE_DB_PORT=5432
# SUPATYPE_SERVER_PORT=9999
# SUPATYPE_SEAWEEDFS_PORT=8333`

/**
 * The scaffolded `.env`'s email settings, under the names the auth server reads. They used to be
 * written unprefixed (RESEND_API_KEY, SES_FROM, SMTP_HOST), which nothing reads, so a developer who
 * filled them in still got no email.
 */
function emailEnvSection(email: ScaffoldOptions["email"], projectName: string): string {
  switch (email) {
    case "resend":
      return `# Email (Resend)
SUPATYPE_RESEND_API_KEY=
SUPATYPE_RESEND_FROM=onboarding@resend.dev`
    case "ses":
      return `# Email (Amazon SES)
SUPATYPE_SES_FROM=
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=`
    case "smtp":
      return `# Email (SMTP)
SUPATYPE_SMTP_HOST=
SUPATYPE_SMTP_PORT=587
SUPATYPE_SMTP_USER=
SUPATYPE_SMTP_PASS=
SUPATYPE_SMTP_SENDER_NAME=${projectName}`
    case "console":
    default:
      // Commented out: an empty SUPATYPE_SMTP_PORT is not a number, and the server refuses it.
      return `# SMTP: unused while email.provider is console, which logs each email instead of sending it.
# Email confirmation is auth.email.enableConfirmations in supatype.config.ts.
# SUPATYPE_SMTP_HOST=
# SUPATYPE_SMTP_PORT=587
# SUPATYPE_SMTP_USER=
# SUPATYPE_SMTP_PASS=
# SUPATYPE_SMTP_SENDER_NAME=${projectName}`
  }
}

function storageEnvSections(
  storageLocal: StorageProvider,
  storageProduction: StorageProvider,
): string {
  if (storageLocal === storageProduction) {
    if (storageLocal === "s3") {
      return `# Storage (local development and production, external bucket)
# Use separate buckets for dev and production in your provider.
S3_ENDPOINT=
S3_REGION=us-east-1
S3_BUCKET=
S3_ACCESS_KEY=
S3_SECRET_KEY=`
    }
    return `${localStorageEnvSection("local")}

# Production storage (SeaweedFS on your server)
# Included in the self-host compose stack, no extra configuration needed.`
  }

  return [localStorageEnvSection(storageLocal), productionStorageEnvSection(storageProduction)].join(
    "\n\n",
  )
}

function localStorageEnvSection(storage: StorageProvider): string {
  if (storage === "s3") {
    return `# Storage (local development, external bucket)
S3_ENDPOINT=
S3_REGION=us-east-1
S3_BUCKET=
S3_ACCESS_KEY=
S3_SECRET_KEY=`
  }
  return `# Storage (local development, SeaweedFS)
S3_ENDPOINT=http://localhost:8333
S3_ACCESS_KEY=supatype
S3_SECRET_KEY=supatype-secret`
}

function productionStorageEnvSection(storage: StorageProvider): string {
  if (storage === "s3") {
    return `# Storage (production, external bucket)
S3_ENDPOINT=
S3_REGION=us-east-1
S3_BUCKET=
S3_ACCESS_KEY=
S3_SECRET_KEY=`
  }
  return `# Storage (production, SeaweedFS on your server)
# Included in the self-host compose stack, no extra configuration needed.`
}

function seedTemplate(projectName: string): string {
  return `import type { SeedContext } from "@supatype/cli/seed"

/**
 * Seed data for ${projectName}. Run it with \`supatype seed\`.
 *
 * The calls below are collected rather than executed. They are ordered by their foreign keys,
 * batched into as few statements as they allow, and applied in one transaction: so there is no
 * connection to open, no ordering to work out by hand, and a failure leaves nothing behind.
 *
 * Usually written as \`{ db, expr, log }\`; taken whole here so the example can stay commented.
 */
export default async function seed(ctx: SeedContext) {
  ctx.log("seeding ${projectName}")

  // \`upsert\` is the one to reach for. Seeds get re-run, and naming the row by a key it already
  // has is what makes that safe, without an id pasted in from somewhere. Rows nested in it
  // (\`create\`, \`createMany\`) are added only when the parent has no child with the same values,
  // so a re-run adds nothing and an edited child is added beside the old one rather than
  // replacing it. Values the database works out, fields left out and \`$default\` are not
  // compared, and a child that matches is left as it is.
  //
  // ctx.db.profile.upsert({
  //   where: { id: "00000000-0000-4000-8000-000000000001" },
  //   data: { display_name: "Admin" },
  // })

  // A seed cannot create auth users. A field typed SupatypeAuthUserId (an owner such as
  // comment.user_id) must name a user who already exists, or the database refuses the row.
  // Create them first, with the auth API (client.auth.signUp) or \`supatype admin create-user\`
  // (which also makes them Studio members), read their ids with \`supatype admin list-users\`,
  // and use those ids here.

  // Times the database works out, so a fixture calendar is still ahead of whenever an
  // environment is seeded rather than fixed to whenever this file was written:
  //
  //   starts_at: ctx.expr.startOf("day", { days: 30, hours: 9 })
}
`
}

function functionsEnvLocalTemplate(): string {
  return "# Local environment variables for edge functions\n# These are NOT committed to git\n# Set production env vars via: npx supatype functions env set KEY=value\n"
}

function gitignoreTemplate(): string {
  // Supatype's own paths come from `SUPATYPE_GITIGNORE_PATHS` rather than being written out again
  // here. This template and that list were two copies of the same thing and had already diverged;
  // the copy that drifts is found when a key reaches a public repository.
  return `${SUPATYPE_GITIGNORE_PATHS.join("\n")}
node_modules/
dist/
# Generated by supatype push (legacy paths, prefer output.types in config)
src/types/supatype.d.ts
src/lib/supatype.ts
`
}

export function mergeGitignoreTemplate(existingContent: string): string {
  if (existingContent.includes(".supatype/") || existingContent.includes(".supatype\n")) {
    return existingContent
  }
  const block = `
# Supatype: local runtime (contains secrets in link.json)
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

/** What `init` did and was asked for, which decides the steps it prints. */
export interface InitStepsArgs {
  name: string | undefined
  result: Pick<WizardResult, "provider" | "kongPort" | "adminEmail" | "packageManager" | "helloFunction"> &
    Partial<Pick<WizardResult, "productionTarget" | "domain" | "tlsEmail">>
  installed: boolean
  keysGenerated: boolean
  binariesReady: boolean
}

/** True when nothing is left to set up, only to run. */
function initSetupComplete(args: InitStepsArgs): boolean {
  return args.installed && args.keysGenerated && args.binariesReady
}

function printNextSteps(args: InitStepsArgs & { result: WizardResult }): void {
  const { name, result } = args
  info(`Supatype project ready${name ? ` in ${name}/` : ""}.`)
  nextSteps(initSetupComplete(args) ? "Next steps:" : "Finish setup:", initFirstSteps(args))
  printProductionSteps(result)
  if (result.productionTarget === "self-host") nextSteps("Develop locally:", initDevSteps(result))
}

/**
 * The commands to run next, in order, after `init`: setting up, then what the project is for. A
 * self-host project leads with taking it to its server, and its local development is printed after
 * ({@link printNextSteps}); every other project leads with `supatype dev`.
 */
export function initFirstSteps(args: InitStepsArgs): string[] {
  const { result } = args
  const next = result.productionTarget === "self-host" ? selfHostProductionSteps(result) : initDevSteps(result)
  return [...initSetupSteps(args), ...next]
}

function initSetupSteps(args: InitStepsArgs): string[] {
  const { name, result, installed, keysGenerated, binariesReady } = args
  const steps: string[] = []
  if (name) steps.push(`cd ${name}`)
  if (!initSetupComplete(args)) {
    if (!installed) steps.push(`${result.packageManager} install`)
    if (!binariesReady) steps.push("supatype update        # download component binaries")
    if (!keysGenerated) steps.push("supatype keys")
  }
  return steps
}

/**
 * `supatype dev`, which applies the schema and generates the types, then watches both. `push` is for
 * another database (`push --env <name>`), and listing it here sent people to it anyway.
 */
function initDevSteps(result: InitStepsArgs["result"]): string[] {
  const steps: string[] = []
  const stack =
    result.provider === "docker"
      ? `Docker Compose stack, API on http://localhost:${result.kongPort ?? 18473}`
      : "native binaries, API on http://localhost:54321"
  steps.push("supatype dev          # applies the schema, generates types, and watches both")
  steps.push(`                      # ${stack}`)
  if (result.adminEmail) {
    steps.push("                      # first admin user is created on dev")
  }
  if (result.helloFunction) {
    steps.push("supatype functions serve   # run edge functions locally")
  }
  return steps
}

/** The secrets, frontend and production blocks printed after the first steps. */
export function printProductionSteps(result: WizardResult): void {
  // Shown once, at creation. These are generated per project rather than shipped as
  // constants, so this is the moment to say they exist and where they live, nothing prints
  // them again, and the JWT secret is only echoed as a fingerprint from here on.
  nextSteps("Secrets: generated for this project, kept in .env:", [
    "POSTGRES_PASSWORD    direct SQL access as the superuser",
    "AUTHENTICATOR_PASSWORD    PostgREST's own login; rotating the one above does not affect it",
    "SUPATYPE_SQL_EDITOR_PASSWORD    Studio's SQL editor login, a role that is not a superuser",
    "JWT_SECRET    signs ANON_KEY and SERVICE_ROLE_KEY; changing it invalidates every token",
    "Keep .env out of version control, and use different values in production.",
  ])

  // No frontend block: someone who chose "No app" was told how to serve a static one. `supatype app
  // add` is there when they want one.

  if (result.productionTarget === "cloud") {
    nextSteps("Deploy to Supatype Cloud:", [
      "supatype login",
      "supatype link --env production --project <ref>",
      "supatype push --env production",
    ])
    info("supatype.local.config.ts keeps `supatype dev` local while the committed config targets cloud.")
  } else if (result.productionTarget === "self-host") {
    // The self-host steps lead the first block (initFirstSteps); local development follows this.
    info("supatype.local.config.ts keeps `supatype dev` local while the committed config targets self-host.")
  }
  plain()
}

/** Taking a self-host project to its own server, with or without a domain for HTTPS. */
function selfHostProductionSteps(result: Pick<WizardResult, "domain" | "tlsEmail">): string[] {
  const steps: string[] = []
  const domain = result.domain?.trim()
  if (domain) {
    steps.push(`1. Point DNS: an A record for ${domain} -> your server's public IP`)
    steps.push("2. Open ports 80 and 443 on the server firewall")
    if (!result.tlsEmail) {
      steps.push("3. Set server.tls.email in supatype.config.ts (required for HTTPS)")
    }
    steps.push("supatype self-host compose up -d   # Kong provisions HTTPS automatically")
    steps.push(`Your Supatype platform goes live at https://${domain}`)
    steps.push(
      "Your app, REST, Auth, Storage, Realtime, Functions, and Studio, all behind one HTTPS domain (certificates outlive restarts)",
    )
  } else {
    steps.push("Set server.domain + server.tls.email in supatype.config.ts to enable automatic HTTPS")
    steps.push("supatype self-host compose up -d   # Docker stack")
  }
  steps.push("supatype link --env production ... # then: supatype push --env production")
  return steps
}
