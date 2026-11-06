/**
 * The API URL and anon key a production build of the project's front end is given, and where each
 * came from.
 *
 * Since `dev`, `init` and `keys` write a local stack's front-end values to `.env.development.local`
 * (frontend-env.ts), nothing gave a production build an anon key: it built, and the site rendered a
 * blank page (issue 29). `supatype build`, `keys --print frontend` and `deploy` resolve them here.
 *
 * Each value is resolved on its own, from the first source that holds it:
 *
 * 1. The environment, under any front-end name or `SUPATYPE_URL` / `SUPATYPE_ANON_KEY`, so a host's
 *    own settings (Vercel, Netlify, a CI secret) always win.
 * 2. For the anon key only: the server the environment's API URL names, at its public
 *    `/supatype-env.json`, for CI that sets only the URL.
 * 3. The linked environment (frontend-values-linked.ts).
 * 4. A `.env` recording a deployment: a non-local `PUBLIC_SUPATYPE_URL` or `API_EXTERNAL_URL`, and
 *    `ANON_KEY` beside it, as on the server itself.
 *
 * An anon key goes with the URL only when its source holds it for that same deployment: a link to
 * one deployment beside a SUPATYPE_URL naming another gave the second's address the first's key.
 *
 * The first source holding a value decides it: a local address there is refused (unless asked for)
 * rather than passed over, since a later source would quietly build against somewhere else. The
 * service role key is never returned, and an "anon key" that is one is refused. Every source asked
 * is recorded, and a refusal prints the lot, as the seed connection resolver's does.
 */

import { readEnvFile } from "./env-file.js"
import { FRONTEND_ANON_KEYS, FRONTEND_URL_KEYS, isLocalUrl, recordedApiUrl } from "./frontend-env.js"
import { publishedAnonKey, readLinkedFrontendValues } from "./frontend-values-linked.js"
import { unverifiedJwtRole } from "./jwt.js"

/** The two values a front end is built with, as {@link FrontendValues} names them. */
export type FrontendValueName = "apiUrl" | "anonKey"

const VALUE_NAMES: readonly FrontendValueName[] = ["apiUrl", "anonKey"]

const LABELS: Record<FrontendValueName, string> = { apiUrl: "API URL", anonKey: "anon key" }

/** The variable that sets each value for a build, named in a refusal's fix. */
const SETTING: Record<FrontendValueName, string> = { apiUrl: "SUPATYPE_URL", anonKey: "SUPATYPE_ANON_KEY" }

/** The environment's names for the API URL, in the order they are read. */
const URL_NAMES: readonly string[] = [SETTING.apiUrl, ...FRONTEND_URL_KEYS]

/** What one source held for one value. */
export interface FrontendFinding {
  /** The value, when the source holds one. */
  value?: string
  /** Where in the source it was: a variable name, the address fetched. */
  where?: string
  /** Why there is no value, or why the one held may not be used. */
  note?: string
  /** True when the source holds a value that may not be used, for a reason `note` gives. */
  refused?: boolean
  /**
   * For an anon key: the address of the deployment it belongs to, when the source says. It goes into
   * a build only for that same address. A key set in the environment says none: the host's settings
   * name the deployment, so it goes with whatever URL is built for.
   */
  deployment?: string
}

/** One source, and what it held for each value it was asked about. */
export interface FrontendSourceRead {
  /** How the source is described: "the environment", "linked environment \"production\"". */
  name: string
  findings: Partial<Record<FrontendValueName, FrontendFinding>>
}

/** One value looked for in one source, as a refusal lists it. */
export interface FrontendSourceReport {
  of: FrontendValueName
  source: string
  status: "found" | "not set" | "refused" | "skipped"
  detail: string
}

export interface ResolvedFrontendValues {
  apiUrl: string
  anonKey: string
  /** Every value looked for in every source asked, in order. */
  tried: readonly FrontendSourceReport[]
}

export interface ResolveFrontendOptions {
  cwd: string
  /** The linked environment to read (`--env`), else the link's default. */
  env?: string | undefined
  /** Take a local address (`--allow-local`), which a production build is otherwise refused. */
  allowLocal?: boolean
  /** The environment to read first. Default: this process's. */
  processEnv?: NodeJS.ProcessEnv
  /** The command a refusal tells the person to run with `--env`. Default: `supatype build`. */
  command?: string
}

/** No usable value for one or both, with every source tried. */
export class FrontendValuesRefused extends Error {
  constructor(
    readonly tried: readonly FrontendSourceReport[],
    readonly missing: readonly FrontendValueName[],
    command = "supatype build",
  ) {
    super(refusalText(tried, missing, command))
    this.name = "FrontendValuesRefused"
  }
}

function refusalText(tried: readonly FrontendSourceReport[], missing: readonly FrontendValueName[], command: string): string {
  const lines = tried.map((line) => `  ${line.status.padEnd(8)} ${LABELS[line.of]} from ${line.source}: ${line.detail}`)
  // An API URL is only ever refused for being a local address (valueRefusal).
  const local = tried.some((line) => line.status === "refused" && line.of === "apiUrl")
  return [
    `No ${missing.map((name) => LABELS[name]).join(" and no ")} for a production build of the front end.`,
    ...lines,
    "",
    `Run \`${command} --env <name>\` for a linked deployment, or set ${missing.map((name) => SETTING[name]).join(" and ")}.`,
    ...(local ? ["Pass --allow-local to use a local stack's address anyway."] : []),
  ].join("\n")
}

/** The first of `names` set in `env`, as a finding; otherwise a note naming them all. */
function firstSet(env: NodeJS.ProcessEnv, names: readonly string[]): FrontendFinding {
  for (const name of names) {
    const value = env[name]?.trim()
    if (value) return { value, where: name }
  }
  return { note: `none of ${names.join(", ")} is set` }
}

function environmentSource(opts: ResolveFrontendOptions): FrontendSourceRead {
  const env = opts.processEnv ?? process.env
  return {
    name: "the environment",
    findings: {
      apiUrl: firstSet(env, URL_NAMES),
      anonKey: firstSet(env, [SETTING.anonKey, ...FRONTEND_ANON_KEYS]),
    },
  }
}

/**
 * `.env`, when it records a deployment. Its ANON_KEY counts only beside an API URL saying which
 * deployment it is for, and not when that URL is a local stack's, unless a local build was asked for.
 */
function dotEnvSource(opts: ResolveFrontendOptions): FrontendSourceRead {
  const env = readEnvFile(opts.cwd)
  const apiUrl = recordedApiUrl(env)
  const where = env["PUBLIC_SUPATYPE_URL"] ? "PUBLIC_SUPATYPE_URL" : "API_EXTERNAL_URL"
  const anonKey = env["ANON_KEY"]?.trim()
  const anonFinding = (): FrontendFinding => {
    if (!anonKey) return { note: "no ANON_KEY" }
    if (apiUrl === undefined) return { note: "ANON_KEY is set with no API URL beside it to say which deployment it is for" }
    if (isLocalUrl(apiUrl) && opts.allowLocal !== true) {
      return { refused: true, note: `ANON_KEY in .env is a local stack's: .env's ${where} is ${apiUrl}` }
    }
    return { value: anonKey, where: "ANON_KEY", deployment: apiUrl }
  }
  return {
    name: ".env",
    findings: {
      apiUrl: apiUrl === undefined ? { note: "no PUBLIC_SUPATYPE_URL or API_EXTERNAL_URL" } : { value: apiUrl, where },
      anonKey: anonFinding(),
    },
  }
}

/**
 * The anon key the server the environment's API URL names publishes, for CI that sets only the URL.
 * The same HTTPS and local rules as a self-host link's server. Gives no API URL: the environment
 * source already read it.
 */
async function environmentUrlServerSource(
  opts: ResolveFrontendOptions,
  wanted: readonly FrontendValueName[],
): Promise<FrontendSourceRead> {
  const url = firstSet(opts.processEnv ?? process.env, URL_NAMES)
  const name = `the server ${url.where ?? "SUPATYPE_URL"} names`
  if (!wanted.includes("anonKey")) return { name, findings: {} }
  if (url.value === undefined) return { name, findings: { anonKey: { note: "no API URL in the environment to ask" } } }
  return { name, findings: { anonKey: await publishedAnonKey(url.value, opts.allowLocal === true) } }
}

type FrontendSource = (opts: ResolveFrontendOptions, wanted: readonly FrontendValueName[]) => FrontendSourceRead | Promise<FrontendSourceRead>

/** In order. The environment's URL's own server comes before the link, so its key is that URL's. */
const SOURCES: readonly FrontendSource[] = [environmentSource, environmentUrlServerSource, readLinkedFrontendValues, dotEnvSource]

/** An address as a deployment is named: scheme, host and port, no trailing slash, no `/auth/v1`. */
function deploymentAddress(url: string): string {
  try {
    const parsed = new URL(url.trim())
    const path = parsed.pathname.replace(/\/+$/, "").replace(/\/auth\/v1$/, "")
    return `${parsed.protocol}//${parsed.host}${path}`
  } catch {
    return url.trim().replace(/\/+$/, "")
  }
}

/**
 * Why an anon key is passed over for the URL being built for, or undefined when it goes with it: a
 * key a source names a deployment for is for that deployment only.
 */
function keySkip(finding: FrontendFinding, apiUrl: string | undefined): string | undefined {
  if (finding.deployment === undefined) return undefined
  if (apiUrl === undefined) return `for ${finding.deployment}, and no URL has been found to build for`
  if (deploymentAddress(finding.deployment) === deploymentAddress(apiUrl)) return undefined
  return `for ${finding.deployment}, not the URL being built for (${apiUrl})`
}

/** Why a value a source holds may not go into a build, or undefined when it may. */
function valueRefusal(of: FrontendValueName, finding: FrontendFinding & { value: string }, allowLocal: boolean): string | undefined {
  const where = finding.where ?? "the value"
  if (of === "apiUrl" && isLocalUrl(finding.value) && !allowLocal) {
    return `${where}=${finding.value} is a local address, which a production build would ship`
  }
  if (of === "anonKey" && unverifiedJwtRole(finding.value) === "service_role") {
    return `${where} holds a service role key, which must never reach a browser`
  }
  return undefined
}

/** What a value is judged against: the local rule, and the API URL decided so far. */
interface JudgeContext {
  allowLocal: boolean
  apiUrl: string | undefined
}

/** One value as one source holds it: the report a refusal lists, and the value when it may be used. */
function judge(read: FrontendSourceRead, of: FrontendValueName, ctx: JudgeContext): { report: FrontendSourceReport; value?: string } {
  const finding = read.findings[of] ?? { note: "not looked for" }
  const base = { of, source: read.name }
  if (finding.refused === true) return { report: { ...base, status: "refused", detail: finding.note ?? "refused" } }
  if (finding.value === undefined) return { report: { ...base, status: "not set", detail: finding.note ?? "not set" } }
  const skip = of === "anonKey" ? keySkip(finding, ctx.apiUrl) : undefined
  if (skip !== undefined) return { report: { ...base, status: "skipped", detail: skip } }
  const refusal = valueRefusal(of, { ...finding, value: finding.value }, ctx.allowLocal)
  if (refusal !== undefined) return { report: { ...base, status: "refused", detail: refusal } }
  return { report: { ...base, status: "found", detail: finding.where ?? "set" }, value: finding.value }
}

/**
 * The API URL and anon key for a production build of the front end, each from the first source
 * that holds it, the key only from one that holds it for the URL decided (or names no deployment). Throws {@link FrontendValuesRefused}, listing every source asked, when either is
 * missing or the first source holding it holds one that may not be used.
 */
export async function resolveFrontendValues(opts: ResolveFrontendOptions): Promise<ResolvedFrontendValues> {
  const decided = new Map<FrontendValueName, string | undefined>()
  const tried: FrontendSourceReport[] = []
  for (const source of SOURCES) {
    const wanted = VALUE_NAMES.filter((name) => !decided.has(name))
    if (wanted.length === 0) break
    const read = await source(opts, wanted)
    // A source says nothing about a value it does not look for (the URL's server gives no URL).
    for (const name of wanted.filter((value) => read.findings[value] !== undefined)) {
      const { report, value } = judge(read, name, { allowLocal: opts.allowLocal === true, apiUrl: decided.get("apiUrl") })
      tried.push(report)
      if (report.status === "found" || report.status === "refused") decided.set(name, value)
    }
  }
  const apiUrl = decided.get("apiUrl")
  const anonKey = decided.get("anonKey")
  if (apiUrl === undefined || anonKey === undefined) {
    throw new FrontendValuesRefused(tried, VALUE_NAMES.filter((name) => decided.get(name) === undefined), opts.command)
  }
  return { apiUrl, anonKey, tried }
}

/** Where each resolved value came from, for a line saying so: "API URL from .env (API_EXTERNAL_URL)". */
export function describeFrontendSources(values: ResolvedFrontendValues): string {
  return values.tried
    .filter((line) => line.status === "found")
    .map((line) => `${LABELS[line.of]} from ${line.source} (${line.detail})`)
    .join(", ")
}
