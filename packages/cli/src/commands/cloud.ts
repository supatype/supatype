import { withPublishing } from "../model-versioning.js"
import type { Command } from "commander"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { DEFAULT_API_URL, pickApiUrl } from "../api-url.js"
import { envAccessToken, loadCloudCredentials, persistCloudSession } from "../cloud-credentials.js"
import { loadProjectLink, migrateLegacyLinkFiles } from "../link.js"
import { targetFetch } from "../target-client.js"
import { isArrayOf, isShape, isString, isUnknown, nullable, optional, type Guard } from "@supatype/shared"
import { readJsonFile } from "../json-file.js"
import { registerEnvs, registerLinkOptions, runLinkAction } from "./link-helpers.js"
import { resolveTarget, targetSchemaPush, schemaPgSchema } from "../resolve-target.js"
import { loadConfig, loadSchemaAst } from "../config.js"
import { schemaPathFromProject } from "../project-config.js"
import { error, info, plain } from "../ui/messages.js"
import { nextSteps } from "../ui/next-steps.js"

interface CloudConfig {
  apiUrl: string
  token: string
  projectSlug?: string
  orgId?: string | undefined
}

/** A custom domain as the Cloud API returns it (`formatDomain` in its domains route). */
interface CloudDomain {
  id: string
  domain: string
  status: string
  cnameTarget: string
  sslExpiresAt: string | null
}

const isCloudConfig: Guard<CloudConfig> = isShape({
  apiUrl: isString,
  token: isString,
  projectSlug: optional(isString),
  orgId: optional(isString),
})

const isCloudDomain: Guard<CloudDomain> = isShape({
  id: isString,
  domain: isString,
  status: isString,
  cnameTarget: isString,
  sslExpiresAt: nullable(isString),
})

/** A project as `projects list` shows it. */
const isListedProject = isShape({ name: isString, slug: isString, tier: isString, region: isString, status: isString })

/** @deprecated Prefer loadProjectLink */
export function loadCloudConfig(cwd: string): CloudConfig | null {
  migrateLegacyLinkFiles(cwd)
  const link = loadProjectLink(cwd)
  if (!link || link.kind !== "cloud") return null
  const legacyPath = resolve(cwd, ".supatype/cloud.json")
  const legacy = existsSync(legacyPath) ? readJsonFile(legacyPath, isCloudConfig) : undefined
  if (legacy !== undefined) return legacy
  return {
    apiUrl: link.cloudApiUrl ?? DEFAULT_API_URL,
    token: link.token ?? loadCloudCredentials()?.accessToken ?? "",
    projectSlug: link.projectRef,
    ...(link.orgId !== undefined ? { orgId: link.orgId } : {}),
  }
}

function saveCloudConfig(cwd: string, config: CloudConfig): void {
  const dir = resolve(cwd, ".supatype")
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(resolve(cwd, ".supatype/cloud.json"), JSON.stringify(config, null, 2) + "\n", "utf8")
}

async function cloudFetch<T>(
  config: CloudConfig,
  method: string,
  path: string,
  guard: Guard<T>,
  body?: unknown,
): Promise<T> {
  const cwd = process.cwd()
  const creds = loadCloudCredentials()
  const refreshToken = creds?.refreshToken ?? loadProjectLink(cwd)?.refreshToken
  return targetFetch<T>(config.apiUrl, "/api/v1", {
    method,
    path,
    ...(body !== undefined ? { body } : {}),
    token: config.token,
    ...(config.orgId !== undefined ? { orgId: config.orgId } : {}),
    ...(refreshToken
      ? {
          authRefresh: {
            cloudApiUrl: config.apiUrl,
            refreshToken,
            onRefreshed: ({ accessToken, refreshToken: nextRefresh }) => {
              persistCloudSession(cwd, {
                apiUrl: config.apiUrl,
                accessToken,
                kind: "session",
                ...(nextRefresh !== undefined ? { refreshToken: nextRefresh } : {}),
              })
              config.token = accessToken
            },
          },
        }
      : {}),
  }, guard)
}

export function isCloudLinked(cwd: string): boolean {
  migrateLegacyLinkFiles(cwd)
  const link = loadProjectLink(cwd)
  if (!(link?.kind === "cloud" && link.projectRef)) return false
  return Boolean(link.token || loadCloudCredentials()?.accessToken)
}

export async function pushSchemaToLinkedProject(
  cwd: string,
  opts?: { force?: boolean; env?: string; overwriteDrift?: boolean },
): Promise<void> {
  const config = loadConfig(cwd)
  const target = resolveTarget(cwd, { env: opts?.env })
  if (target.mode !== "cloud") {
    error("Not linked to a cloud project. Run: supatype link --project <slug>")
    process.exit(1)
  }

  const ast = withPublishing(loadSchemaAst(schemaPathFromProject(config, cwd), cwd), config)
  info(`Pushing schema to ${target.mode} project ${target.projectRef} (${target.environment})...`)

  const result = await targetSchemaPush(target, ast, {
    cwd,
    force: opts?.force ?? true,
    schema: schemaPgSchema(cwd),
    ...(opts?.overwriteDrift !== undefined && { overwriteDrift: opts.overwriteDrift }),
  })

  info((result as { message?: string }).message ?? "Schema push completed.")
}

export async function deploySchemaToLinkedProject(
  cwd: string,
  environment: string,
  opts?: { overwriteDrift?: boolean },
): Promise<void> {
  await pushSchemaToLinkedProject(cwd, {
    force: true,
    env: environment,
    ...(opts?.overwriteDrift !== undefined && { overwriteDrift: opts.overwriteDrift }),
  })
}

export function registerCloud(program: Command): void {
  registerEnvs(program)

  const linkCmd = program
    .command("link")
    .description("Link this project to cloud or self-host (unified .supatype/link.json)")
  registerLinkOptions(linkCmd)
  linkCmd.action(async (opts: {
    project?: string
    url?: string
    apiUrl?: string
    token?: string
    serviceRoleKey?: string
    env?: string
    fixGitignore?: boolean
  }) => {
    await runLinkAction(opts)
  })

  const projectsCmd = program
    .command("projects")
    .description("Manage cloud projects")

  projectsCmd
    .command("list")
    .description("List your projects: the linked project's organisation, else every organisation you belong to")
    .option("--org <slug>", "List the projects of one organisation (its slug or id)")
    .action(async (opts: { org?: string }) => {
      await listProjects(getCloudConfigOrExit(), opts.org)
    })

  projectsCmd
    .command("create <name>")
    .description("Create a new project")
    .option("--tier <tier>", "Project tier (free, pro, team)", "free")
    .option("--region <region>", "Region (eu-fsn, eu-nbg, eu-hel)", "eu-fsn")
    .option("--org <slug>", "Organisation to create it in (its slug or id)")
    .action(async (name: string, opts: { tier: string; region: string; org?: string }) => {
      const config = await scopedToOrg(getCloudConfigOrExit(), opts.org, true)

      info(`Creating project "${name}" (${opts.tier}, ${opts.region})...`)

      const project = await cloudFetch(
        config, "POST", "/projects",
        isShape({ slug: isString, name: isString, status: isString }),
        { name, tier: opts.tier, region: opts.region },
      )

      info(`Project created: ${project.name} (${project.slug})`)
      info(`Status: ${project.status}`)
      nextSteps("To link this project:", [`supatype link --project ${project.slug}`])
    })

  projectsCmd
    .command("pause <slug>")
    .description("Pause a project")
    .option("--org <slug>", "The project's organisation (its slug or id)")
    .action(async (slug: string, opts: { org?: string }) => {
      const config = await scopedToOrg(getCloudConfigOrExit(), opts.org, false)
      await cloudFetch(config, "POST", `/projects/${slug}/pause`, isUnknown)
      info(`Project ${slug} paused.`)
    })

  projectsCmd
    .command("resume <slug>")
    .description("Resume a paused project")
    .option("--org <slug>", "The project's organisation (its slug or id)")
    .action(async (slug: string, opts: { org?: string }) => {
      const config = await scopedToOrg(getCloudConfigOrExit(), opts.org, false)
      await cloudFetch(config, "POST", `/projects/${slug}/resume`, isUnknown)
      info(`Project ${slug} resumed.`)
    })

  const domainsCmd = program
    .command("domains")
    .description("Manage custom domains for a project")

  domainsCmd
    .command("list")
    .description("List domains for the linked project")
    .action(async () => {
      const config = getCloudConfigOrExit()
      if (!config.projectSlug) {
        error("Not linked to a project. Run: supatype link")
        process.exit(1)
      }

      const domains = await cloudFetch(config, "GET", `/projects/${config.projectSlug}/domains`, isArrayOf(isCloudDomain))

      if (domains.length === 0) {
        info("No custom domains configured.")
        return
      }

      // The id leads: `domains verify` and `domains remove` take it, as the API's routes do, and
      // this is the only place a person can read it.
      plain(`\n  ${"ID".padEnd(38)}${"Domain".padEnd(34)}${"Status".padEnd(21)}CNAME Target`)
      plain("  " + "─".repeat(118))
      for (const d of domains) {
        plain(`  ${d.id.padEnd(38)}${d.domain.padEnd(34)}${d.status.padEnd(21)}${d.cnameTarget}`)
      }
      plain()
    })

  domainsCmd
    .command("add <domain>")
    .description("Add a custom domain")
    .action(async (domain: string) => {
      const config = getCloudConfigOrExit()
      if (!config.projectSlug) {
        error("Not linked to a project. Run: supatype link")
        process.exit(1)
      }

      const result = await cloudFetch(
        config, "POST", `/projects/${config.projectSlug}/domains`,
        isShape({ id: isString, domain: isString, instructions: isString }),
        { domain },
      )

      info(`Domain added: ${result.domain}`)
      plain(`\n${result.instructions}`)
      info(`After adding the CNAME record, verify with: supatype domains verify ${result.id}`)
    })

  domainsCmd
    .command("remove <domainId>")
    .description("Remove a custom domain (its ID from `supatype domains list`)")
    .action(async (domainId: string) => {
      const config = getCloudConfigOrExit()
      if (!config.projectSlug) {
        error("Not linked to a project. Run: supatype link")
        process.exit(1)
      }

      await cloudFetch(config, "DELETE", `/projects/${config.projectSlug}/domains/${domainId}`, isUnknown)
      info("Domain removed.")
    })

  domainsCmd
    .command("verify <domainId>")
    .description("Verify CNAME and provision SSL for a domain (its ID from `supatype domains list`)")
    .action(async (domainId: string) => {
      const config = getCloudConfigOrExit()
      if (!config.projectSlug) {
        error("Not linked to a project. Run: supatype link")
        process.exit(1)
      }

      const result = await cloudFetch(
        config, "POST", `/projects/${config.projectSlug}/domains/${domainId}/verify`,
        isShape({ domain: isString, status: isString }),
      )

      info(`Domain ${result.domain}: ${result.status}`)
    })
}

/** An organisation as `GET /organisations` lists those the account belongs to. */
interface CloudOrg {
  id: string
  name: string
  slug: string
}

const isCloudOrg: Guard<CloudOrg> = isShape({ id: isString, name: isString, slug: isString })

/**
 * The organisations `projects list` covers. The control plane scopes projects to the organisation in
 * `X-Org-Id`, and before a link there is none to send, so the account's own are asked: `--org` picks
 * one by slug or id, else all of them (an account with one organisation lists that one).
 */
async function orgsToList(config: CloudConfig, wanted: string | undefined): Promise<CloudOrg[]> {
  const orgs = await cloudFetch(config, "GET", "/organisations", isArrayOf(isCloudOrg))
  if (wanted === undefined) return orgs
  const found = orgs.filter((org) => org.slug === wanted || org.id === wanted)
  if (found.length === 0) {
    const have = orgs.map((org) => org.slug).join(", ")
    error(`You are not in an organisation "${wanted}".${have === "" ? "" : ` Yours: ${have}.`}`)
    process.exit(1)
  }
  return found
}

/**
 * `config` with the one organisation a project command acts in, for `create`, `pause` and `resume`
 * (as `projects list` resolves them): the linked one, else `--org`, else the account's only one.
 * With several and no `--org`, `required` commands (create) refuse and name them; the others go on
 * without, since a project's slug names it whatever organisation is sent.
 */
async function scopedToOrg(config: CloudConfig, wanted: string | undefined, required: boolean): Promise<CloudConfig> {
  if (config.orgId !== undefined && wanted === undefined) return config
  const orgs = await orgsToList(config, wanted)
  const only = orgs.length === 1 ? orgs[0] : undefined
  if (only !== undefined) return { ...config, orgId: only.id }
  if (!required) return config
  error(
    orgs.length === 0
      ? "You are not in any organisation yet. Create one in your account on Supatype Cloud."
      : `You are in several organisations (${orgs.map((org) => org.slug).join(", ")}). Pass --org <slug>.`,
  )
  process.exit(1)
}

function printProjects(projects: ReadonlyArray<{ name: string; slug: string; tier: string; region: string; status: string }>): void {
  plain("\n  Name                    Slug                     Tier    Region    Status")
  plain("  " + "─".repeat(80))
  for (const p of projects) {
    plain(`  ${p.name.padEnd(24)}${p.slug.padEnd(25)}${p.tier.padEnd(8)}${p.region.padEnd(10)}${p.status}`)
  }
  plain()
}

/** `projects list`: the linked project's organisation, or those of the account when nothing is linked. */
async function listProjects(config: CloudConfig, org: string | undefined): Promise<void> {
  const orgs: CloudOrg[] | undefined =
    config.orgId !== undefined && org === undefined ? undefined : await orgsToList(config, org)
  if (orgs?.length === 0) {
    info("You are not in any organisation yet. Create one in your account on Supatype Cloud.")
    return
  }
  const scopes = orgs ?? [undefined]
  let listed = 0
  for (const scope of scopes) {
    const projects = await cloudFetch(
      scope === undefined ? config : { ...config, orgId: scope.id },
      "GET", "/projects", isArrayOf(isListedProject),
    )
    listed += projects.length
    if (projects.length === 0) continue
    if (scopes.length > 1 && scope !== undefined) plain(`\n  ${scope.name} (${scope.slug})`)
    printProjects(projects)
  }
  if (listed === 0) info("No projects. Create one with: supatype projects create <name>")
}

function getCloudConfigOrExit(): CloudConfig {
  const cwd = process.cwd()
  let config = loadCloudConfig(cwd)
  if (!config) {
    const creds = loadCloudCredentials()
    const token = envAccessToken() ?? creds?.accessToken
    if (!token) {
      error("Not connected to Supatype Cloud. Run: supatype login (then supatype link), or set SUPATYPE_ACCESS_TOKEN.")
      process.exit(1)
    }
    config = { apiUrl: pickApiUrl(process.env["SUPATYPE_API_URL"], creds?.apiUrl), token }
  }
  return config
}
