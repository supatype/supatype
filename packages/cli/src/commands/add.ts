import type { Command } from "commander"
import { p, runClackFlow } from "../ui/clack.js"
import { loadConfig } from "../config.js"
import { selfHostTlsEnabled } from "../project-config.js"
import { updateServerConfigInProject } from "../app-config.js"
import { ensureNotCancelled } from "../ui/prompts.js"
import { file, error, info, plain } from "../ui/messages.js"
import { nextSteps } from "../ui/next-steps.js"

export function registerAdd(program: Command): void {
  const addCmd = program
    .command("add")
    .description("Add capabilities to an existing project")

  addCmd
    .command("domain [domain]")
    .description("Add a custom domain with automatic HTTPS (self-host)")
    .option("--email <email>", "Email for Let's Encrypt TLS certificates")
    .action(async (domainArg: string | undefined, opts: { email?: string }) => {
      await addDomain(domainArg, opts.email)
    })
}

async function promptDomain(initial?: string): Promise<string> {
  const trimmed = initial?.trim()
  if (trimmed) return trimmed
  return ensureNotCancelled(
    await p.text({
      message: "Please provide domain:",
      placeholder: "demo.supatype.com",
      validate: (v) => ((v ?? "").trim().length === 0 ? "Domain is required" : undefined),
    }),
  ).trim()
}

async function promptEmail(initial?: string): Promise<string> {
  const trimmed = initial?.trim()
  if (trimmed) return trimmed
  return ensureNotCancelled(
    await p.text({
      message: "Please provide email for TLS",
      placeholder: "hello@supatype.com",
      validate: (v) => ((v ?? "").trim().length === 0 ? "Email is required" : undefined),
    }),
  ).trim()
}

async function addDomain(domainArg?: string, emailArg?: string): Promise<void> {
  const cwd = process.cwd()
  const interactive = !domainArg?.trim() || !emailArg?.trim()

  const run = async (): Promise<void> => {
    const domain = await promptDomain(domainArg)
    const email = await promptEmail(emailArg)

    try {
      const configPath = updateServerConfigInProject(cwd, { domain, tlsEmail: email })
      if (interactive) {
        p.outro(`Updated ${configPath}`)
      } else {
        file("updated", configPath)
      }
      printDomainNextSteps(cwd, domain)
    } catch (err) {
      error((err as Error).message)
      process.exit(1)
    }
  }

  if (interactive) {
    await runClackFlow(async () => {
      p.intro("Add a custom domain")
      await run()
    })
    return
  }

  await run()
}

function printDomainNextSteps(cwd: string, domain: string): void {
  let tlsActive = true
  try {
    tlsActive = selfHostTlsEnabled(loadConfig(cwd))
  } catch {
    // config re-load is best-effort for the warning below
  }

  info(`Domain set to ${domain} with automatic HTTPS.`)
  if (!tlsActive) {
    plain(
      "\nNote: a supatype.local.config.ts override (server.mode=dev) is suppressing HTTPS locally.\n" +
        "That file is gitignored, so HTTPS still activates on your production server.",
    )
  }
  nextSteps("Go live:", [
    `Point DNS: an A record for ${domain} -> your server's public IP`,
    "Open ports 80 and 443 on the server firewall",
    "supatype self-host compose up -d   # Kong provisions HTTPS automatically",
    `Platform URL: https://${domain}`,
  ])
  plain("  App, REST, Auth, Storage, Realtime, Functions, and Studio — one HTTPS domain.")
  plain("  Certificates persist in the valkey-data volume.\n")
}
