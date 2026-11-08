import type { Command } from "commander"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve, join, basename } from "node:path"
import { randomBytes } from "node:crypto"
import { p, runClackFlow } from "../ui/clack.js"
import { withProgressView } from "../ui/progress.js"
import {
  installCommand,
  installDependencies,
  plainStepView,
  runTimedStep,
  spinnerStepView,
  type StepView,
  type TimedStep,
} from "../init-setup-steps.js"
import { ensureNotCancelled } from "../ui/prompts.js"
import { adminEmailProblem, answerProblem, askText, smtpHostProblem, smtpPortProblem, type SmtpServer } from "../init-answers.js"
import { assertEnvValues } from "../env-value.js"
import { ensureFunctionsEnvLocal, FUNCTIONS_ENV_LOCAL } from "../functions-env-local.js"
import { generateAndWriteKeys } from "./keys.js"
import {
  BUNDLED_DB_USER,
  CONTROL_PLANE_SECRET_ENV,
  generateControlPlaneSecret,
  generateObjectStoreCredentials,
  givenJwtSecret,
  newJwtSecret,
  OBJECT_STORE_ACCESS_KEY_ENV,
  OBJECT_STORE_SECRET_KEY_ENV,
} from "../local-secrets.js"
import { file, error, info, plain, warn } from "../ui/messages.js"
import { nextSteps } from "../ui/next-steps.js"
import { probeDockerDaemonAsync, reportDockerUnavailable, type DockerDaemonProbe } from "../docker-runtime.js"
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
import {
  mergeSupatypePackageJson,
  PREPARE_COMMAND,
  scaffoldPackageJson,
  supatypeDevScript,
} from "../init-package-json.js"
import { downloadRelease, initFromExample } from "../init-example.js"
import { errorMessage } from "../error-message.js"
import { isJsonObject, parseJsonObject } from "@supatype/shared"
import { cliPackageVersion } from "../cli-package-version.js"
import {
  initDependencyVersionsFallback,
  resolveInitDependencyVersions,
  type InitDependencyVersions,
} from "../init-dependency-versions.js"
import { detectProjectSetup, type DetectedProjectSetup } from "../init-project-detect.js"
import { SUPATYPE_GITIGNORE_PATHS } from "../gitignore.js"
import { DEV_FRONTEND_ENV_FILE, writeFrontendEnv } from "../frontend-env.js"
import { DEFAULT_CLIENT_PATH, DEFAULT_TYPES_PATH } from "../type-generation.js"
import {
  COMPOSE_DEV_KONG_PORT,
  defaultAppStaticDir,
  NATIVE_DB_PORT,
  NATIVE_SERVER_PORT,
  nativeDatabaseUrl,
  VITE_BUILD_DIR,
} from "../project-config.js"
import { cliDatabaseUrlLines } from "../database-url-owner.js"
import { scaffoldNextRuntimeEnv } from "../init-next-runtime-env.js"

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
  /** The SMTP server, asked for when `email` is smtp, written to `.env`. */
  smtp?: SmtpServer
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

      if (interactive) {
        await runInteractiveInit({ name, dir, defaultName, modeTarget, opts })
        return
      }
      const result: WizardResult = {
        ...defaultScaffoldOptions(defaultName, modeTarget),
        packageManager: detectInvokingPackageManager(),
        install: true,
        generateKeys: true,
      }
      const asked = startInitQuestions(result.provider)
      if (asked.kongPort) result.kongPort = await asked.kongPort
      await createProject({ name, dir, result, opts, deps: asked.deps, ...(asked.daemon !== undefined && { daemon: asked.daemon }) })
    })
}

/** What both inits hand on once the answers are in: where, what, and the CLI's flags. */
interface CreateProjectArgs {
  name: string | undefined
  dir: string
  result: WizardResult
  opts: InitCliOptions
  deps: Promise<InitDependencyVersions>
  /** Docker's answer, when init already asked. */
  daemon?: Promise<DockerDaemonProbe>
}

/**
 * Write the project, run its setup steps and print what is left, the same for the interactive init
 * and `init -y`. They were two copies, and had come to disagree about whether keys nobody generated
 * were a step left to do.
 */
async function createProject(args: CreateProjectArgs): Promise<void> {
  const { name, dir, result, opts } = args
  applyAdminFlags(result, opts)
  // CLI flags override wizard / default action choices.
  const wants: SetupWants = { install: opts.install !== false && result.install, keys: opts.keys !== false && result.generateKeys }
  if (name) mkdirSync(dir, { recursive: true })
  scaffold(dir, result, await args.deps)

  const outcome = await withStepView((view) => runSetupSteps(dir, result.packageManager, wants, view))
  exitOnFailedSetup(outcome, wants, result.packageManager)
  await warnDockerUnavailableForProvider(result.provider, args.daemon)
  printNextSteps({
    name,
    result,
    installed: wants.install && outcome.installOk,
    keysGenerated: outcome.keysGenerated,
    binariesReady: outcome.binariesReady,
    devScript: projectDevScript(dir),
  })
}

/** `--no-admin`, or `--admin-email` with `--admin-password`, over the answers. */
function applyAdminFlags(result: WizardResult, opts: InitCliOptions): void {
  if (opts.admin === false) {
    delete result.adminEmail
    delete result.adminPassword
  } else if (opts.adminEmail && opts.adminPassword) {
    refuseAdminFlags(opts.adminEmail, opts.adminPassword)
    result.adminEmail = opts.adminEmail.trim()
    result.adminPassword = opts.adminPassword
  }
}

/** Exits before anything is written when the admin flags hold what the prompts would refuse. */
function refuseAdminFlags(email: string, password: string): void {
  const emailProblem = adminEmailProblem(email)
  const passwordProblem = answerProblem(password)
  if (emailProblem !== undefined) error(`--admin-email: ${emailProblem}`)
  if (passwordProblem !== undefined) error(`--admin-password: ${passwordProblem}`)
  if (emailProblem !== undefined || passwordProblem !== undefined) process.exit(1)
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
    const result = await collectWizardAnswers({
      defaultName,
      defaultTarget: modeTarget,
      detected,
      askName: name === undefined,
    })
    await createProject({ name, dir, result, opts, deps: resolveDependencyVersions() })
  })

  process.exit(0)
}

// ─── Wizard ──────────────────────────────────────────────────────────────────

export interface WizardContext {
  defaultName: string
  defaultTarget: ProductionTarget
  detected: DetectedProjectSetup
  /** False when `init <name>` already named the project. */
  askName: boolean
}

export async function collectWizardAnswers(context: WizardContext): Promise<WizardResult> {
    const { defaultName, defaultTarget, detected } = context
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

    const tls = productionTarget === "self-host" ? await promptSelfHostTls() : {}

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

    const schemaPath = await askWithDefault("Where should your schema live?", "schema/index.ts")

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
    // Without a host the server uses its noop mailer and drops every email (issue 76).
    const smtp = email === "smtp" ? await promptSmtpServer() : undefined

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
      ...tls,
      schemaPath,
      app,
      email,
      ...(smtp !== undefined && { smtp }),
      storageLocal,
      storageProduction,
      helloFunction,
      packageManager,
      install: true,
      generateKeys: true,
      ...admin,
    }
}

/** The submission port most SMTP servers take, offered as the answer. */
const SMTP_PORT = "587"

/** The SMTP server's host and port, both required to send anything. */
async function promptSmtpServer(): Promise<SmtpServer> {
  const host = (await askText({ message: "SMTP host", placeholder: "smtp.example.com", validate: smtpHostProblem })).trim()
  const port = await askText({ message: "SMTP port", defaultValue: SMTP_PORT, placeholder: SMTP_PORT, validate: smtpPortProblem })
  return { host, port: Number(port.trim() || SMTP_PORT) }
}

/** A self-hosted project's domain for ACME TLS, and the email for its certificates when it has one. */
async function promptSelfHostTls(): Promise<Pick<WizardResult, "domain" | "tlsEmail">> {
  const domain = (
    await askText({ message: "Production domain for ACME TLS (optional, can set later)", placeholder: "api.example.com", defaultValue: "" })
  ).trim()
  if (!domain) return { domain }
  const tlsEmail = (
    await askText({ message: "Email for Let's Encrypt (HTTPS) certificates", placeholder: "you@example.com", defaultValue: "" })
  ).trim()
  return { domain, ...(tlsEmail !== "" && { tlsEmail }) }
}

async function promptProjectName(defaultName: string): Promise<string> {
  return askWithDefault("Project name", defaultName)
}

/** A text answer, trimmed, or `defaultValue` when it was left empty. */
async function askWithDefault(message: string, defaultValue: string): Promise<string> {
  return (await askText({ message, defaultValue })).trim() || defaultValue
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

  const adminEmail = (
    await askText({ message: "Admin email", placeholder: "you@example.com", validate: adminEmailProblem })
  ).trim()

  return { adminEmail, adminPassword: await promptAdminPassword() }
}

/**
 * The admin password, typed twice: asked once, a typo became the Studio password with nothing to
 * show it. Both are asked again when they differ.
 */
async function promptAdminPassword(): Promise<string> {
  while (true) {
    const password = ensureNotCancelled(await p.password({ message: "Admin password (min 8 characters)" })).trim()
    const problem = answerProblem(password) ?? (password.length < 8 ? "Password must be at least 8 characters." : undefined)
    if (problem !== undefined) {
      p.log.warn(problem)
      continue
    }
    const confirmed = ensureNotCancelled(await p.password({ message: "Confirm admin password" })).trim()
    if (confirmed === password) return password
    p.log.warn("Passwords do not match.")
  }
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
    const viteDevUrl = await promptViteDevUrl(detected, productionTarget)
    return { mode, staticDir: await promptStaticDir(detected, viteDevUrl !== undefined), ...(viteDevUrl ? { viteDevUrl } : {}) }
  }

  if (mode === "proxy") {
    const upstream = await askWithDefault(
      "URL of your running dev server",
      detected.hasVite ? detected.viteDevUrl : "http://localhost:3000",
    )
    const start = await askWithDefault("package.json script that starts your dev server", detected.hasVite ? "vite" : "dev")
    const viteDevUrl = await promptViteDevUrl(detected, productionTarget)
    return { mode, upstream, start, ...(viteDevUrl ? { viteDevUrl } : {}) }
  }

  return { mode: "none" }
}

/**
 * The directory a static site is served from, asked after Vite: it was asked before, so a new Vite
 * project was offered ./public. A Vite project is offered its build output, ./dist; a site with no
 * build is offered what detection found, ./public when it found nothing. ./public for Vite is
 * warned about and kept: it is Vite's folder of assets copied into the build, not the build.
 */
async function promptStaticDir(detected: DetectedProjectSetup, vite: boolean): Promise<string> {
  const staticDir = await askWithDefault("Directory to serve", vite ? VITE_BUILD_DIR : detected.staticDir)
  if (vite && staticDirRelative(staticDir) === "public") {
    p.log.warn(
      "./public is Vite's folder for static assets it copies into the build, so serving it skips the build. " +
        "Vite builds into ./dist unless vite.config.ts says otherwise.",
    )
  }
  return staticDir
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

  return askWithDefault("Vite dev server URL", detected.viteDevUrl)
}

// ─── Package manager ───────────────────────────────────────────────────────--

function detectInvokingPackageManager(): PackageManager {
  const ua = process.env["npm_config_user_agent"] ?? ""
  if (ua.startsWith("pnpm")) return "pnpm"
  if (ua.startsWith("yarn")) return "yarn"
  if (ua.startsWith("bun")) return "bun"
  return "npm"
}

/** Which setup steps init was asked to run. */
interface SetupWants {
  install: boolean
  keys: boolean
}

/** What init's setup steps did: each true only when it ran and succeeded. */
interface SetupOutcome {
  installOk: boolean
  keysGenerated: boolean
  binariesReady: boolean
}

/**
 * The view init's setup steps are shown on: a spinner in a terminal, the flow's or the command
 * chrome's (ui/progress.ts decides, as for every spinner), and plain start and done lines otherwise.
 */
async function withStepView<T>(run: (view: StepView) => Promise<T>): Promise<T> {
  return withProgressView((spinner) => run(spinner === undefined ? plainStepView() : spinnerStepView(spinner)))
}

/** Install, then keys, then the component binaries an install makes possible, each timed on `view`. */
async function runSetupSteps(dir: string, pm: PackageManager, wants: SetupWants, view: StepView): Promise<SetupOutcome> {
  const installOk = wants.install && (await runTimedStep(view, installStep(dir, pm, view.live)))
  const keysGenerated =
    wants.keys &&
    (await runTimedStep(view, {
      label: "Generating API keys",
      run: async () => writeKeys(dir),
      done: (ok) => (ok ? "API keys generated" : "Could not generate API keys"),
    }))
  const binariesReady =
    installOk &&
    (await runTimedStep(view, {
      label: "Preparing component binaries",
      run: () => ensureInitBinaries(dir),
      done: (ok) => (ok ? "Component binaries ready" : "Some binaries are missing"),
    }))
  return { installOk, keysGenerated, binariesReady }
}

/** The install step: in a terminal its output is read for the spinner, otherwise it passes through. */
function installStep(dir: string, pm: PackageManager, live: boolean): TimedStep<boolean> {
  return {
    label: `Installing dependencies with ${pm}`,
    run: (detail) => installDependencies(dir, installCommand(pm), live ? detail : undefined),
    done: (ok) => (ok ? "Dependencies installed" : "Dependency install failed"),
  }
}

/** Stop init, naming what to run, when a setup step it was asked for failed. */
function exitOnFailedSetup(outcome: SetupOutcome, wants: SetupWants, pm: PackageManager): void {
  if (wants.install && !outcome.installOk) {
    error(`Dependency install failed. Run "${pm} install" in the project directory, then "supatype update".`)
    process.exit(1)
  }
  if (wants.keys && !outcome.keysGenerated) {
    error("Could not generate API keys. Check the project has a .env, then run `supatype keys`.")
    process.exit(1)
  }
  if (wants.install && !outcome.binariesReady) {
    error("Component binaries could not be downloaded. Run `supatype update` in the project directory.")
    process.exit(1)
  }
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
  // First, so a value .env cannot hold is refused before any file is written.
  const env = envTemplate(opts)

  const pkgPath = join(dir, "package.json")
  if (!existsSync(pkgPath)) {
    write("package.json", scaffoldPackageJson(opts, deps))
  } else {
    mergeIntoPackageJson(pkgPath, opts, deps)
  }

  write("supatype.config.ts", tsConfigTemplate(opts))
  if (writesLocalOverride(opts)) {
    write("supatype.local.config.ts", localConfigTemplate(opts.app))
  }
  write(opts.schemaPath, schemaTemplate())
  write(".env", env)
  scaffoldDevFrontendEnv(dir, opts)
  write("seed.ts", seedTemplate(opts.projectName))
  write("seeds/.gitkeep", "")
  scaffoldAppAssets(dir, opts, write)
  // The Next.js counterpart of the static page's script tag: the client and @supatype/ssr ship
  // together, so the route's package is added at the client's range.
  scaffoldNextRuntimeEnv(dir, write, `^${deps.client}`)

  if (opts.helloFunction) scaffoldHelloFunction(dir, write)
  scaffoldGitignore(dir, write)
}

/**
 * Supatype's scripts and packages merged into the project's own package.json, saying so when its
 * `prepare` changed: a project's own (husky, say) gets `supatype-prepare` after it, and the one
 * earlier releases of init wrote is replaced.
 */
function mergeIntoPackageJson(pkgPath: string, opts: ScaffoldOptions, deps: InitDependencyVersions): void {
  try {
    const existing = parseJsonObject(readFileSync(pkgPath, "utf8"))
    if (!existing.ok) throw new Error("package.json is not a JSON object")
    const merged = mergeSupatypePackageJson(existing.value, opts, deps)
    writeFileSync(pkgPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8")
    file("updated", "package.json (added Supatype dependencies)")
    const before = scriptOf(existing.value, "prepare")
    const after = merged.scripts?.["prepare"]
    if (before !== undefined && after !== undefined && before !== after) {
      info(`package.json's prepare script was "${before}" and is now "${after}", so a fresh clone generates the seed builder.`)
    }
  } catch {
    warn(
      "Could not merge into package.json. Add @supatype/client to dependencies, @supatype/cli and " +
        `@supatype/types to devDependencies, and a "prepare" script of "${PREPARE_COMMAND}".`,
    )
    file("skipped", "package.json (invalid JSON)")
  }
}

/** The package.json script `name`, when it is a string. */
function scriptOf(pkg: Record<string, unknown>, name: string): string | undefined {
  const scripts = pkg["scripts"]
  const script = isJsonObject(scripts) ? scripts[name] : undefined
  return typeof script === "string" ? script : undefined
}

/**
 * The front end's local API address, in `.env.development.local` (frontend-env.ts) for a docker
 * project, whose gateway port is known now. In `.env`, a production build read it and shipped it.
 */
function scaffoldDevFrontendEnv(dir: string, opts: ScaffoldOptions): void {
  if (opts.provider !== "docker" || opts.kongPort === undefined) return
  const existed = existsSync(join(dir, DEV_FRONTEND_ENV_FILE))
  writeFrontendEnv(dir, { apiUrl: initLocalApiUrl(opts) })
  file(existed ? "updated" : "created", DEV_FRONTEND_ENV_FILE)
}

function scaffoldGitignore(dir: string, write: (rel: string, content: string) => void): void {
  const gitignorePath = join(dir, ".gitignore")
  if (!existsSync(gitignorePath)) {
    write(".gitignore", gitignoreTemplate())
    return
  }
  const existing = readFileSync(gitignorePath, "utf8")
  const merged = mergeGitignoreTemplate(existing)
  if (merged === existing) {
    file("skipped", ".gitignore (already exists)")
    return
  }
  writeFileSync(gitignorePath, merged, "utf8")
  file("updated", ".gitignore (added Supatype's local files)")
}

/**
 * The directory a static app is served from: the one typed at init, else the stack's own default
 * (defaultAppStaticDir). The config, the holding page and Vite's build all read it here, so none
 * of them can name a different one.
 */
function staticDirOf(app: ScaffoldAppOptions): string {
  return app.staticDir ?? defaultAppStaticDir(Boolean(app.viteDevUrl))
}

function staticDirRelative(staticDir: string): string {
  return staticDir.trim().replace(/^\.\//, "").replace(/\/+$/, "") || "public"
}

/**
 * Whether the committed config has Supatype serve the app's files: a static app, and a proxied one
 * with a production target, whose committed config serves its build (appConfigLines). Only such a
 * server answers `/supatype-env.js`; a proxied app is served by its own.
 */
function servedStatically(opts: Pick<ScaffoldOptions, "productionTarget" | "app">): boolean {
  return opts.app.mode === "static" || (opts.app.mode === "proxy" && opts.productionTarget !== "later")
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

  const holding = holdingPageTemplate(opts.projectName, initLocalApiUrl(opts), servedStatically(opts))
  const hasVite = Boolean(opts.app.viteDevUrl)

  if (opts.app.mode === "static") {
    writeUnlessExists(`${staticDirRelative(staticDirOf(opts.app))}/index.html`, holding)
    if (hasVite) scaffoldVite(dir, opts, writeUnlessExists, holding)
    return
  }

  if (servedStatically(opts)) {
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
  write("vite.config.ts", viteConfigTemplate(opts.app.viteDevUrl, viteBuildOutDir(opts)))
}

/**
 * Where `vite build` writes, when it is not Vite's own `dist`: the static directory a static app is
 * served from, so its build lands there. Undefined otherwise.
 */
function viteBuildOutDir(opts: ScaffoldOptions): string | undefined {
  if (opts.app.mode !== "static") return undefined
  const outDir = staticDirRelative(staticDirOf(opts.app))
  // Not into "./public" either: that is Vite's own assets folder, served as it is (promptStaticDir).
  return outDir === "dist" || outDir === "public" ? undefined : outDir
}

function scaffoldHelloFunction(
  dir: string,
  write: (rel: string, content: string) => void,
): void {
  write("functions/hello/index.ts", functionTemplateSource("hello"))
  if (!existsSync(join(dir, "functions/_shared/README.md"))) {
    write("functions/_shared/README.md", sharedFunctionsReadmeSource())
  }
  if (ensureFunctionsEnvLocal(join(dir, "functions")).created) file("created", `functions/${FUNCTIONS_ENV_LOCAL}`)
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
      `Pinning @supatype/cli ^${deps.cli}, @supatype/types ^${deps.types}, ` +
        `@supatype/client ^${deps.client}`,
    )
  }
  return deps
}

/**
 * Whether init writes a supatype.local.config.ts: for a production target, whose committed config
 * is production's, and for a static app developed with Vite, whose dev server `supatype dev` starts
 * only in proxy mode. A "Decide later" project with Vite used to get neither, and nothing started
 * Vite.
 */
function writesLocalOverride(opts: Pick<ScaffoldOptions, "productionTarget" | "app">): boolean {
  return opts.productionTarget !== "later" || viteDevelopsStaticApp(opts.app)
}

/** A static app with a Vite dev server: served from its build, developed through Vite. */
function viteDevelopsStaticApp(app: ScaffoldAppOptions): boolean {
  return app.mode === "static" && Boolean(app.viteDevUrl)
}

function tsConfigTemplate(opts: ScaffoldOptions): string {
  const serverMode = serverModeForTarget(opts.productionTarget)
  const lines: string[] = []
  lines.push(`import { defineConfig } from "@supatype/cli"`)
  lines.push("")
  if (opts.productionTarget !== "later") lines.push(`// Committed config = ${opts.productionTarget} production target.`)
  if (writesLocalOverride(opts)) {
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
  // .env (SUPATYPE_KONG_PORT), so writing a server port there only named a port nothing listened on.
  if (opts.provider === "native") lines.push(`    port: ${NATIVE_SERVER_PORT},`)
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
    // Vite's dev server is the local override's (writesLocalOverride); this is the built site.
    const built = viteDevelopsStaticApp(app) ? "  // production build output" : ""
    return [`  app: {`, `    mode: "static",`, `    static_dir: "${staticDirOf(app)}",${built}`, `  },`]
  }
  if (app.mode === "proxy") {
    if (servedStatically({ app, productionTarget })) {
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

/**
 * Where `supatype dev` answers for this project: the gateway's port for docker, the API server's
 * for native. One answer for the page `init` writes and the steps it prints, which disagreed: the
 * page named 18473 whatever port the project was given.
 */
function initLocalApiUrl(opts: Pick<ScaffoldOptions, "provider" | "kongPort">): string {
  return opts.provider === "docker"
    ? `http://localhost:${opts.kongPort ?? COMPOSE_DEV_KONG_PORT}`
    : `http://localhost:${NATIVE_SERVER_PORT}`
}

/**
 * Where auth emails send people back to. A static or proxied app is served on the same address as
 * the API, so that is the app's address too; it was `http://localhost:3000` for every project,
 * where nothing listened. With no app, the address is the developer's own, and 3000 is a guess.
 */
function initSiteUrl(opts: Pick<ScaffoldOptions, "provider" | "kongPort" | "app">): string {
  return opts.app.mode === "none" ? "http://localhost:3000" : initLocalApiUrl(opts)
}

/**
 * The deployment's address and anon key, from the server that serves the page, for a build that
 * carried none. A classic script in the head runs before any module script, wherever the app puts
 * its own. Where no Supatype server answers it (Vite's dev server, opened directly, sends its
 * index.html back) the script fails with one console error and the page runs on: only that script
 * is lost, and the dev build has its values from `.env.development.local` anyway. `vite-ignore`
 * tells Vite to leave the tag as it is: without it, every `vite build` warned that it could not
 * bundle a script the project does not have. Vite drops the attribute from the page it builds, and
 * a browser ignores it in a page nothing builds.
 */
const RUNTIME_ENV_SCRIPT = `
    <!-- The deployment's API address and anon key, from the server that serves this page.
         vite-ignore tells Vite to leave it out of the bundle, so the build does not warn. -->
    <script src="/supatype-env.js" vite-ignore></script>`

function holdingPageTemplate(projectName: string, apiUrl: string, runtimeEnv: boolean): string {
  const name = escapeHtml(projectName)
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${name}: Supatype</title>
    <meta name="description" content="A Supatype project. Define your types, we generate your platform." />${runtimeEnv ? RUNTIME_ENV_SCRIPT : ""}
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
      <p class="hint">Run <code>supatype dev</code> then open <code>${escapeHtml(apiUrl)}/</code></p>
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

function viteConfigTemplate(viteDevUrl: string, outDir?: string): string {
  const port = vitePortFromDevUrl(viteDevUrl)
  const build = outDir === undefined ? "" : `  // Built into the directory supatype.config.ts serves.\n  build: { outDir: "${outDir}" },\n`
  return `import { defineConfig } from "vite"

export default defineConfig({
${build}  server: {
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

/**
 * The values `.env` takes from what init was told, rather than generates, under the key each is
 * written as. The project name is the database's name and, for SMTP, the sender's.
 */
function envAnswers(opts: ScaffoldOptions): Record<string, string> {
  return {
    POSTGRES_DB: opts.projectName,
    ...(opts.adminEmail !== undefined && { SUPATYPE_ADMIN_EMAIL: opts.adminEmail }),
    ...(opts.adminPassword !== undefined && { SUPATYPE_ADMIN_PASSWORD: opts.adminPassword }),
  }
}

function envTemplate(opts: ScaffoldOptions): string {
  assertEnvValues(envAnswers(opts), ".env")
  const sections: string[] = []
  // Generated, not constant. These reach a server: the previous defaults meant a self-host
  // deployment ran with a password of `postgres` and a JWT secret published in this repo,
  // and anyone holding that secret can mint a token naming any Postgres role. Safe to generate
  // only because `supatype dev` no longer overwrites them on every run (see local-secrets.ts).
  const postgresPassword = randomBytes(24).toString("base64url")

  // Labelled as the CLI's, so it follows the provider the project runs (database-url-owner.ts). A
  // native project's is the one its dev uses, which used to rewrite a Docker URL on the first start.
  const databaseUrl = opts.provider === "native"
    ? nativeDatabaseUrl(opts.projectName, postgresPassword, NATIVE_DB_PORT)
    : `postgresql://${BUNDLED_DB_USER}:${encodeURIComponent(postgresPassword)}@localhost:5432/${opts.projectName}`
  sections.push(`${cliDatabaseUrlLines(databaseUrl)}
POSTGRES_USER=${BUNDLED_DB_USER}
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
SITE_URL=${initSiteUrl(opts)}`)

  if (opts.provider === "docker" && opts.kongPort !== undefined) {
    // The front end's copies of this address and the anon key are in .env.development.local
    // (scaffoldDevFrontendEnv, and the keys step), where a production build does not read them.
    sections.push(
      `# Local API gateway (Kong), unique per project so multiple stacks can run concurrently
SUPATYPE_KONG_PORT=${opts.kongPort}
API_EXTERNAL_URL=${initLocalApiUrl(opts)}`,
    )
  }

  sections.push(emailEnvSection(opts))
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
# Self-host commands reach Postgres at SUPATYPE_DB_PORT for their own run; DATABASE_URL above stays dev's.
# SUPATYPE_PUBLISH_ADDRESS=127.0.0.1
# SUPATYPE_DB_PORT=5432
# SUPATYPE_SERVER_PORT=9999
# SUPATYPE_SEAWEEDFS_PORT=8333`

/**
 * The scaffolded `.env`'s email settings, under the names the auth server reads. They used to be
 * written unprefixed (RESEND_API_KEY, SES_FROM, SMTP_HOST), which nothing reads, so a developer who
 * filled them in still got no email.
 */
function emailEnvSection({ email, projectName, smtp }: ScaffoldOptions): string {
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
SUPATYPE_SMTP_HOST=${smtp?.host ?? ""}
SUPATYPE_SMTP_PORT=${smtp?.port ?? 587}
SUPATYPE_SMTP_USER=
SUPATYPE_SMTP_PASS=
SUPATYPE_SMTP_SENDER_NAME=${projectName}`
    case "console":
    default:
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
  const login = generateObjectStoreCredentials()
  return `# Storage (local development, SeaweedFS)
# The object store's login, generated for this project. It opens every file in every bucket, so
# keep it as private as the database password.
S3_ENDPOINT=http://localhost:8333
${OBJECT_STORE_ACCESS_KEY_ENV}=${login.accessKey}
${OBJECT_STORE_SECRET_KEY_ENV}=${login.secretKey}`
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

function gitignoreTemplate(): string {
  // Supatype's own paths come from `SUPATYPE_GITIGNORE_PATHS` rather than being written out again
  // here. This template and that list were two copies of the same thing and had already diverged;
  // the copy that drifts is found when a key reaches a public repository.
  return `${SUPATYPE_GITIGNORE_PATHS.join("\n")}
node_modules/
dist/
`
}

/**
 * An existing `.gitignore` with what init adds to a project: `.supatype/` (link.json holds secrets)
 * and `.env.*.local`, where init writes the front end's development-only API address. Each is added
 * only when the file does not already cover it.
 */
export function mergeGitignoreTemplate(existingContent: string): string {
  const lines = existingContent.split(/\r?\n/).map((line) => line.trim())
  const missing = [
    ...(existingContent.includes(".supatype/") || lines.includes(".supatype") ? [] : [".supatype/"]),
    ...(lines.includes(".env.*.local") || lines.includes("*.local") ? [] : [".env.*.local"]),
  ]
  if (missing.length === 0) return existingContent
  const block = `\n# Supatype: local runtime (secrets in .supatype/link.json) and development-only env files\n${missing.join("\n")}\n`
  return existingContent.endsWith("\n") ? `${existingContent}${block}` : `${existingContent}\n${block}`
}

// ─── Next steps ────────────────────────────────────────────────────────────--

/** Say so when a Docker project's Docker is not running: from `started` when init already asked. */
async function warnDockerUnavailableForProvider(
  provider: ScaffoldOptions["provider"],
  started?: Promise<DockerDaemonProbe>,
): Promise<void> {
  if (provider !== "docker") return
  const probe = await (started ?? probeDockerDaemonAsync())
  if (probe.ok) return
  reportDockerUnavailable(probe)
  plain()
}

/** What `init -y` asks of the machine, all asked at once (see startInitQuestions). */
interface InitQuestions {
  /** The Kong port, for a Docker project. */
  kongPort?: Promise<number>
  /** Whether Docker runs, for a Docker project. */
  daemon?: Promise<DockerDaemonProbe>
  deps: Promise<InitDependencyVersions>
}

/**
 * Start everything `init -y` asks of Docker and the npm registry, side by side and each with a short
 * limit (docker-exec.ts). They ran one after another with none: 16 to 27 seconds on a developer
 * machine, past 58 on a loaded one. A native project asks Docker nothing.
 */
function startInitQuestions(provider: ScaffoldOptions["provider"]): InitQuestions {
  const deps = resolveDependencyVersions()
  if (provider !== "docker") return { deps }
  const kongPort = import("../dev-ports.js").then(({ chooseInitKongPort }) => chooseInitKongPort())
  return { kongPort, daemon: probeDockerDaemonAsync(), deps }
}

/** What `init` did and was asked for, which decides the steps it prints. */
export interface InitStepsArgs {
  name: string | undefined
  result: Pick<WizardResult, "provider" | "kongPort" | "adminEmail" | "packageManager" | "helloFunction"> &
    Partial<Pick<WizardResult, "productionTarget" | "domain" | "tlsEmail">>
  installed: boolean
  keysGenerated: boolean
  binariesReady: boolean
  /** The package.json script that runs `supatype dev`: `dev`, or `supatype:dev` beside a dev of the project's own. */
  devScript?: string
}

/** One titled block of what init prints when it is done, with a line after its steps when it has one. */
export interface InitStepBlock {
  title: string
  steps: string[]
  after?: string
}

/** The script in `dir`'s package.json that runs `supatype dev`, or `dev` when it cannot be read. */
function projectDevScript(dir: string): string {
  try {
    const pkg = parseJsonObject(readFileSync(join(dir, "package.json"), "utf8"))
    return pkg.ok ? supatypeDevScript(pkg.value["scripts"]) : "dev"
  } catch {
    return "dev"
  }
}

/** True when nothing is left to set up, only to run. */
function initSetupComplete(args: InitStepsArgs): boolean {
  return args.installed && args.keysGenerated && args.binariesReady
}

function printNextSteps(args: InitStepsArgs): void {
  const { name } = args
  info(`Supatype project ready${name ? ` in ${name}/` : ""}.`)
  for (const block of initStepBlocks(args)) {
    nextSteps(block.title, block.steps)
    if (block.after !== undefined) plain(`  ${block.after}`)
  }
  const target = args.result.productionTarget
  if (target === "cloud" || target === "self-host") {
    info(`supatype.local.config.ts keeps \`supatype dev\` local while the committed config targets ${target}.`)
  }
  plain()
}

/**
 * Everything init prints when it is done, in order: running the project locally, then its secrets,
 * then taking it to production. Production comes last whatever the target: it is the step for
 * later, and a self-host project used to lead with a domain the person had just said they lacked.
 */
export function initStepBlocks(args: InitStepsArgs): InitStepBlock[] {
  const blocks: InitStepBlock[] = [
    { title: initSetupComplete(args) ? "Next steps:" : "Finish setup:", steps: initFirstSteps(args) },
    { title: "Secrets: generated for this project, kept in .env:", steps: initSecretLines(), after: SECRETS_CLOSING },
  ]
  const deploy = deployBlock(args.result)
  return deploy === undefined ? blocks : [...blocks, deploy]
}

/** Setting up, then running the project locally, for every production target. */
export function initFirstSteps(args: InitStepsArgs): string[] {
  return [...initSetupSteps(args), ...initDevSteps(args)]
}

function initSetupSteps(args: InitStepsArgs): string[] {
  const { name, result, installed, keysGenerated, binariesReady } = args
  const steps: string[] = []
  if (name) steps.push(`cd ${name}`)
  if (!initSetupComplete(args)) {
    if (!installed) steps.push(`${result.packageManager} install`)
    if (!binariesReady) steps.push("supatype update   # download component binaries")
    if (!keysGenerated) steps.push("supatype keys")
  }
  return steps
}

/** `script` run the way `pm` runs a package.json script. */
function runScriptCommand(pm: PackageManager, script: string): string {
  return pm === "npm" || pm === "bun" ? `${pm} run ${script}` : `${pm} ${script}`
}

/** `command` with `comments` after it, each comment after the first on its own line in the same column. */
function commented(command: string, comments: string[]): string[] {
  const column = command.length + 3
  return comments.map((comment, index) => `${(index === 0 ? command : "").padEnd(column)}# ${comment}`)
}

/**
 * The dev script, which applies the schema and generates the types, then watches both; then where
 * to open the project. `push` is for another database (`push --env <name>`), and listing it here
 * sent people to it anyway.
 */
function initDevSteps(args: InitStepsArgs): string[] {
  const { result } = args
  const comments = [
    "applies the schema, generates types, and watches both",
    result.provider === "docker" ? "runs the Docker Compose stack" : "runs the native binaries",
  ]
  if (result.adminEmail) comments.push("first admin user is created on dev")
  const steps = commented(runScriptCommand(result.packageManager, args.devScript ?? "dev"), comments)
  steps.push(`Open ${initLocalApiUrl(result)}`)
  if (result.helloFunction) {
    steps.push(...commented(runScriptCommand(result.packageManager, "functions"), ["run edge functions locally"]))
  }
  return steps
}

/**
 * The secrets init generated, shown once, at creation. They are generated per project rather than
 * shipped as constants, so this is the moment to say they exist and where they live: nothing prints
 * them again, and the JWT secret is only echoed as a fingerprint from here on.
 */
const INIT_SECRETS: ReadonlyArray<readonly [name: string, description: string]> = [
  ["POSTGRES_PASSWORD", "direct SQL access as the superuser"],
  ["AUTHENTICATOR_PASSWORD", "PostgREST's own login; rotating the one above does not affect it"],
  ["SUPATYPE_SQL_EDITOR_PASSWORD", "Studio's SQL editor login, a role that is not a superuser"],
  ["JWT_SECRET", "signs ANON_KEY and SERVICE_ROLE_KEY; changing it invalidates every token"],
]

const SECRETS_CLOSING = "Keep .env out of version control, and use different values in production."

/** One line per secret, each description two spaces past the longest name. */
export function initSecretLines(): string[] {
  const width = Math.max(...INIT_SECRETS.map(([name]) => name.length)) + 2
  return INIT_SECRETS.map(([name, description]) => `${name.padEnd(width)}${description}`)
}

/**
 * The app's production build, given the linked deployment's API URL and anon key. Without it a
 * production build read neither, and the deployed app rendered a blank page (issue 29).
 */
const BUILD_STEP = "supatype build --env production   # your app's production build, with the deployment's URL and anon key"

/** Taking the project to production, for a target that has one. No frontend block: `supatype app add` covers that. */
function deployBlock(result: InitStepsArgs["result"]): InitStepBlock | undefined {
  if (result.productionTarget === "cloud") {
    return {
      title: "When you're ready to deploy (Supatype Cloud):",
      steps: ["supatype login", "supatype link --env production --project <ref>", "supatype push --env production", BUILD_STEP],
    }
  }
  if (result.productionTarget === "self-host") {
    return { title: "When you're ready to deploy (self-host):", steps: selfHostDeploySteps(result) }
  }
  return undefined
}

/**
 * Taking a self-host project to its own server. With a domain, DNS and the firewall come first;
 * without one, HTTPS is the last step and an optional one, since the person just said they had none.
 */
export function selfHostDeploySteps(result: Partial<Pick<WizardResult, "domain" | "tlsEmail">>): string[] {
  const domain = result.domain?.trim()
  const link = "supatype link --env production ...   # then: supatype push --env production"
  if (!domain) {
    return [
      "supatype self-host compose up -d   # on your server: the Docker stack",
      link,
      BUILD_STEP,
      "Later, optionally: set server.domain and server.tls.email in supatype.config.ts for automatic HTTPS",
    ]
  }
  return [
    `1. Point DNS: an A record for ${domain} -> your server's public IP`,
    "2. Open ports 80 and 443 on the server firewall",
    ...(result.tlsEmail ? [] : ["3. Set server.tls.email in supatype.config.ts (required for HTTPS)"]),
    "supatype self-host compose up -d   # Kong provisions HTTPS automatically",
    link,
    BUILD_STEP,
    `Your Supatype platform goes live at https://${domain}`,
    "Your app, REST, Auth, Storage, Realtime, Functions, and Studio, all behind one HTTPS domain (certificates outlive restarts)",
  ]
}
