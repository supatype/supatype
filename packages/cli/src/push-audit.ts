/**
 * What a push says about itself for the audit trail: who pushed, through what and from where. The
 * renames it applies are recorded from the rename journal the schema carries.
 *
 * The CLI cannot prove who is at the keyboard. It says who git says it is, else the OS user, and
 * never claims to have verified it: only a control plane that authenticated the caller records a
 * verified author, and it ignores what the CLI sent.
 */
import { execFileSync } from "node:child_process"
import { hostname, userInfo } from "node:os"
import type { Capabilities } from "./engine-ownership-gate.js"

/** Where the author is read from: git's config, and the OS. Injectable for tests. */
export interface AuthorSources {
  git: (key: "user.name" | "user.email") => string | undefined
  osUser: () => string | undefined
}

function gitConfig(cwd: string, key: string): string | undefined {
  try {
    const value = execFileSync("git", ["config", "--get", key], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    return value === "" ? undefined : value
  } catch {
    // No git, no repository, or the key is unset: the OS user is asked instead.
    return undefined
  }
}

function osUserName(): string | undefined {
  try {
    const name = userInfo().username.trim()
    return name === "" ? undefined : name
  } catch {
    return process.env["USER"] ?? process.env["USERNAME"]
  }
}

/** The sources a real run reads, for the project at `cwd`. */
export function authorSources(cwd: string): AuthorSources {
  return { git: (key) => gitConfig(cwd, key), osUser: osUserName }
}

/**
 * Who is pushing or declaring a rename: `Name <email>` from git, else the OS user marked unverified.
 * `SUPATYPE_PUSHED_BY` still wins, as it did for the manifest's `pushedBy`.
 */
export function resolveAuthor(sources: AuthorSources): string {
  const explicit = process.env["SUPATYPE_PUSHED_BY"]?.trim()
  if (explicit) return explicit
  const name = sources.git("user.name")
  if (name !== undefined) {
    const email = sources.git("user.email")
    return email === undefined ? name : `${name} <${email}>`
  }
  const user = sources.osUser()
  return user === undefined ? "unknown (unverified)" : `${user} (OS user, unverified)`
}

/** A CI system, how it names itself, and the variable that holds the run. */
const CI_RUNS: ReadonlyArray<{ marker: string; name: string; run: (env: NodeJS.ProcessEnv) => string | undefined }> = [
  {
    marker: "GITHUB_ACTIONS",
    name: "github-actions",
    run: (env) =>
      env["GITHUB_RUN_ID"] === undefined
        ? undefined
        : `${env["GITHUB_SERVER_URL"] ?? "https://github.com"}/${env["GITHUB_REPOSITORY"] ?? ""}/actions/runs/${env["GITHUB_RUN_ID"]}`,
  },
  { marker: "GITLAB_CI", name: "gitlab-ci", run: (env) => env["CI_PIPELINE_URL"] ?? env["CI_JOB_ID"] },
  { marker: "CIRCLECI", name: "circleci", run: (env) => env["CIRCLE_BUILD_URL"] },
  { marker: "BUILDKITE", name: "buildkite", run: (env) => env["BUILDKITE_BUILD_URL"] },
  { marker: "JENKINS_URL", name: "jenkins", run: (env) => env["BUILD_URL"] },
  { marker: "TF_BUILD", name: "azure-pipelines", run: (env) => env["BUILD_BUILDID"] },
  { marker: "BITBUCKET_BUILD_NUMBER", name: "bitbucket", run: (env) => env["BITBUCKET_BUILD_NUMBER"] },
]

/** Where a push comes from: the CI run when a CI system says so, else this host's name. */
export function resolvePushedFrom(env: NodeJS.ProcessEnv = process.env, host: string = hostname()): string {
  for (const ci of CI_RUNS) {
    if (env[ci.marker] === undefined) continue
    const run = ci.run(env)
    return run === undefined ? `${ci.name} ${host}` : `${ci.name} ${run}`
  }
  return env["CI"] !== undefined ? `ci ${host}` : host
}

/** Each author resolved, by project directory: git's config does not change during a run. */
const authors = new Map<string, string>()

/** Who is pushing from the project at `cwd`: {@link resolveAuthor} over git and the OS, asked once. */
export function projectAuthor(cwd: string): string {
  let author = authors.get(cwd)
  if (author === undefined) {
    author = resolveAuthor(authorSources(cwd))
    authors.set(cwd, author)
  }
  return author
}

/** Each audit field of a push request, and the engine binary's flag for it. */
const AUDIT_FLAGS = {
  pushed_by: "--pushed-by",
  pushed_via: "--pushed-via",
  pushed_from: "--pushed-from",
} as const

/**
 * What a push says about itself: the fields the engine's push request reads, and a control plane
 * forwards. `pushed_by_verified` is never among them: it is not the CLI's to claim.
 */
export type PushAuditFields = Record<keyof typeof AUDIT_FLAGS, string>

/** The audit fields of a push from the project at `cwd`. */
export function pushAuditFields(cwd: string): PushAuditFields {
  return { pushed_by: projectAuthor(cwd), pushed_via: "cli", pushed_from: resolvePushedFrom() }
}

/** The audit fields in `body`, as the engine binary's `push` flags. */
export function auditFlags(body: Readonly<Record<string, unknown>>): string[] {
  return Object.entries(AUDIT_FLAGS).flatMap(([key, flag]) => {
    const value = body[key]
    return typeof value === "string" && value !== "" ? [flag, value] : []
  })
}

/**
 * The audit fields of a push from `cwd`, for an engine that records them (`push_audit`), else
 * none: an older engine refuses the flags, and a push must not fail for want of its audit.
 */
export async function auditWhenSupported(
  cwd: string,
  capabilities: () => Promise<Capabilities>,
): Promise<PushAuditFields | undefined> {
  const caps = await capabilities().catch(() => undefined)
  return caps?.features.has("push_audit") === true ? pushAuditFields(cwd) : undefined
}
