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
import { error, info, plain } from "../ui/messages.js"
import { nextSteps } from "../ui/next-steps.js"
import { isInteractive } from "../ui/interactive.js"
import { ensureNotCancelled, printLogo, clack as p } from "../ui/prompts.js"

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
        info("Not linked. Run: supatype link")
        return
      }
      plain(`\nProject: ${link.projectRef} (${link.kind})`)
      plain(`Default: ${link.defaultEnvironment}\n`)
      for (const [name, env] of Object.entries(link.environments)) {
        const mark = name === link.defaultEnvironment ? " *" : "  "
        plain(`${mark} ${name.padEnd(14)} ${env.apiUrl}`)
      }
      plain()
    })

  envs
    .command("use <name>")
    .description("Set the default environment")
    .action((name: string) => {
      const cwd = process.cwd()
      const link = loadProjectLink(cwd)
      if (!link?.environments[name]) {
        error(`Environment "${name}" is not linked.`)
        process.exit(1)
      }
      link.defaultEnvironment = name
      saveProjectLink(cwd, link)
      info(`Default environment set to "${name}".`)
    })

  envs
    .command("create <name>")
    .description("Create a cloud environment (staging/preview)")
    .action(async (name: string) => {
      const cwd = process.cwd()
      const link = loadProjectLink(cwd)
      if (!link || link.kind !== "cloud") {
        error("Cloud link required. Run: supatype link --project <slug>")
        process.exit(1)
      }
      if (!link.token || !link.cloudApiUrl) {
        error("Missing cloud credentials in link.json")
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
      info(`Environment "${bodyName}" created.`)
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
  let project = opts.project
  let url = opts.url

  if (isInteractive() && !project && !url) {
    printLogo()
    p.intro("Link this project")
    const targetKind = ensureNotCancelled(
      await p.select<"cloud" | "self-host">({
        message: "Link target",
        options: [
          { value: "cloud", label: "Supatype Cloud", hint: "managed project on supatype.com" },
          { value: "self-host", label: "Self-host", hint: "your Kong gateway URL" },
        ],
      }),
    )
    if (targetKind === "cloud") {
      project = ensureNotCancelled(
        await p.text({
          message: "Cloud project slug",
          placeholder: projectRef,
          defaultValue: projectRef,
        }),
      ).trim()
    } else {
      url = ensureNotCancelled(
        await p.text({
          message: "Kong gateway URL",
          placeholder: "https://api.example.com",
          defaultValue: "http://localhost:18473",
        }),
      ).trim()
    }
    p.outro("Linking...")
  }

  const token = resolveLinkToken(opts)

  if (opts.fixGitignore) {
    ensureSupatypeGitignore(cwd)
  } else {
    warnIfLinkNotGitignored(cwd)
  }

  const existing = loadProjectLink(cwd)

  if (url) {
    if (!token) {
      error("Authentication required. Pass --token $SERVICE_ROLE_KEY")
      process.exit(1)
    }
    const apiUrl = url.replace(/\/$/, "")
    await probeSelfHostLink(apiUrl, projectRef, token)
    const link = createSelfHostLink({
      projectRef,
      apiUrl,
      token,
      envName,
      existing,
    })
    saveProjectLink(cwd, link)
    info(`Linked to self-host environment "${envName}" at ${apiUrl}`)
    nextSteps("Next steps:", [
      "supatype push --env " + envName,
      "supatype deploy",
    ])
    return
  }

  if (!token) {
    error("Authentication required. Set SUPATYPE_ACCESS_TOKEN or pass --token.")
    process.exit(1)
  }

  const cloudApiUrl = opts.apiUrl.replace(/\/$/, "")

  if (project) {
    const one = await targetFetch<{ slug: string; orgId: string }>(cloudApiUrl, "/api/v1", {
      method: "GET",
      path: `/projects/${project}`,
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
          path: `/projects/${project}/environments`,
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
      projectRef: project,
      cloudApiUrl,
      token,
      orgId: one.orgId,
      environments,
      existing,
    })
    saveProjectLink(cwd, link)
    info(`Linked to cloud project: ${project}`)
    nextSteps("Next steps:", [
      "supatype push --env production",
      "supatype deploy",
    ])
    return
  }

  error("Specify --project <slug> for cloud or --url <kong-url> for self-host.")
  process.exit(1)
}

export function getLinkOrExit(cwd: string): ProjectLink {
  const link = loadProjectLink(cwd)
  if (!link) {
    error("Not linked. Run: supatype link")
    process.exit(1)
  }
  return link
}
