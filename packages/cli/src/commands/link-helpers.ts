import type { Command } from "commander"
import { loadConfig } from "../config.js"
import {
  createCloudLink,
  createSelfHostLink,
  loadProjectLink,
  saveProjectLink,
  type ProjectLink,
} from "../link.js"
import { ensureSupatypeGitignore, warnIfLinkNotGitignored } from "../gitignore.js"
import { targetFetch } from "../target-client.js"

function resolveLinkToken(opts: {
  token?: string
  serviceRoleKey?: string
}): string | undefined {
  return (
    opts.token ??
    opts.serviceRoleKey ??
    process.env["SUPATYPE_ACCESS_TOKEN"] ??
    process.env["SUPATYPE_TOKEN"] ??
    process.env["SERVICE_ROLE_KEY"]
  )
}

async function probeSelfHostLink(apiUrl: string, projectRef: string, token: string): Promise<void> {
  await targetFetch(apiUrl, "/platform/v1", {
    method: "GET",
    path: `/projects/${projectRef}/status`,
    token,
  })
}

export function registerEnvs(program: Command): void {
  const envs = program.command("envs").description("Manage linked deployment environments")

  envs
    .command("list")
    .description("List linked environments")
    .action(() => {
      const cwd = process.cwd()
      const link = loadProjectLink(cwd)
      if (!link) {
        console.log("Not linked. Run: supatype link")
        return
      }
      console.log(`\nProject: ${link.projectRef} (${link.kind})`)
      console.log(`Default: ${link.defaultEnvironment}\n`)
      for (const [name, env] of Object.entries(link.environments)) {
        const mark = name === link.defaultEnvironment ? " *" : "  "
        console.log(`${mark} ${name.padEnd(14)} ${env.apiUrl}`)
      }
      console.log()
    })

  envs
    .command("use <name>")
    .description("Set the default environment")
    .action((name: string) => {
      const cwd = process.cwd()
      const link = loadProjectLink(cwd)
      if (!link?.environments[name]) {
        console.error(`Environment "${name}" is not linked.`)
        process.exit(1)
      }
      link.defaultEnvironment = name
      saveProjectLink(cwd, link)
      console.log(`Default environment set to "${name}".`)
    })

  envs
    .command("create <name>")
    .description("Create a cloud environment (staging/preview)")
    .action(async (name: string) => {
      const cwd = process.cwd()
      const link = loadProjectLink(cwd)
      if (!link || link.kind !== "cloud") {
        console.error("Cloud link required. Run: supatype link --project <slug>")
        process.exit(1)
      }
      if (!link.token || !link.cloudApiUrl) {
        console.error("Missing cloud credentials in link.json")
        process.exit(1)
      }
      const bodyName = name === "staging" || name === "preview" ? name : "staging"
      await targetFetch(link.cloudApiUrl, "/api/v1", {
        method: "POST",
        path: `/projects/${link.projectRef}/environments`,
        body: { name: bodyName },
        token: link.token,
        orgId: link.orgId,
      })
      const envsList = await targetFetch<Array<{ name: string; apiUrl: string }>>(
        link.cloudApiUrl,
        "/api/v1",
        {
          method: "GET",
          path: `/projects/${link.projectRef}/environments`,
          token: link.token,
          orgId: link.orgId,
        },
      )
      const updated = createCloudLink({
        projectRef: link.projectRef,
        cloudApiUrl: link.cloudApiUrl,
        token: link.token,
        environments: envsList.map((e) => ({ name: e.name, apiUrl: e.apiUrl })),
        existing: link,
        ...(link.orgId !== undefined ? { orgId: link.orgId } : {}),
      })
      saveProjectLink(cwd, updated)
      console.log(`Environment "${bodyName}" created.`)
    })
}

export function registerLinkOptions(linkCmd: Command): void {
  linkCmd
    .option("--project <slug>", "Cloud project slug")
    .option("--url <url>", "Self-host or local Kong URL")
    .option("--api-url <url>", "Cloud control plane API URL", "https://api.supatype.com")
    .option("--token <token>", "Access token (cloud PAT or self-host SERVICE_ROLE_KEY)")
    .option("--service-role-key <key>", "Deprecated alias for --token on self-host")
    .option("--env <name>", "Environment name (default: production)", "production")
    .option("--fix-gitignore", "Append .supatype/ to .gitignore if missing")
}

export async function runLinkAction(opts: {
  project?: string
  url?: string
  apiUrl: string
  token?: string
  serviceRoleKey?: string
  env?: string
  fixGitignore?: boolean
}): Promise<void> {
  const cwd = process.cwd()
  const config = loadConfig(cwd)
  const projectRef = config.project?.name ?? "project"
  const envName = opts.env ?? "production"
  const token = resolveLinkToken(opts)

  if (opts.fixGitignore) {
    ensureSupatypeGitignore(cwd)
  } else {
    warnIfLinkNotGitignored(cwd)
  }

  const existing = loadProjectLink(cwd)

  if (opts.url) {
    if (!token) {
      console.error("Authentication required. Pass --token $SERVICE_ROLE_KEY")
      process.exit(1)
    }
    const apiUrl = opts.url.replace(/\/$/, "")
    await probeSelfHostLink(apiUrl, projectRef, token)
    const link = createSelfHostLink({
      projectRef,
      apiUrl,
      token,
      envName,
      existing,
    })
    saveProjectLink(cwd, link)
    console.log(`\nLinked to self-host environment "${envName}" at ${apiUrl}`)
    console.log(`Config saved to .supatype/link.json\n`)
    return
  }

  if (!token) {
    console.error("Authentication required. Set SUPATYPE_ACCESS_TOKEN or pass --token.")
    process.exit(1)
  }

  const cloudApiUrl = opts.apiUrl.replace(/\/$/, "")

  if (opts.project) {
    const one = await targetFetch<{ slug: string; orgId: string }>(cloudApiUrl, "/api/v1", {
      method: "GET",
      path: `/projects/${opts.project}`,
      token,
    })
    let environments: Array<{ name: string; apiUrl: string }> = [
      { name: "production", apiUrl: cloudApiUrl },
    ]
    try {
      const listed = await targetFetch<Array<{ name: string; apiUrl: string }>>(
        cloudApiUrl,
        "/api/v1",
        {
          method: "GET",
          path: `/projects/${opts.project}/environments`,
          token,
          orgId: one.orgId,
        },
      )
      if (listed.length > 0) {
        environments = listed.map((e) => ({ name: e.name, apiUrl: e.apiUrl }))
      }
    } catch {
      // environments optional on older control planes
    }
    const link = createCloudLink({
      projectRef: opts.project,
      cloudApiUrl,
      token,
      orgId: one.orgId,
      environments,
      existing,
    })
    saveProjectLink(cwd, link)
    console.log(`\nLinked to cloud project: ${opts.project}`)
    console.log(`Config saved to .supatype/link.json\n`)
    return
  }

  console.error("Specify --project <slug> for cloud or --url <kong-url> for self-host.")
  process.exit(1)
}

export function getLinkOrExit(cwd: string): ProjectLink {
  const link = loadProjectLink(cwd)
  if (!link) {
    console.error("Not linked. Run: supatype link")
    process.exit(1)
  }
  return link
}
