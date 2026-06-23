import type { Command } from "commander"
import * as p from "@clack/prompts"
import { loadConfig } from "../config.js"
import { selfHostTlsEnabled } from "../project-config.js"
import { updateServerConfigInProject } from "../app-config.js"
import { ensureNotCancelled, printLogo } from "../prompts.js"

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

  if (interactive) {
    printLogo()
    p.intro("Add a custom domain")
  }

  const domain = await promptDomain(domainArg)
  const email = await promptEmail(emailArg)

  try {
    const configPath = updateServerConfigInProject(cwd, { domain, tlsEmail: email })
    if (interactive) {
      p.outro(`Updated ${configPath}`)
    } else {
      console.log(`  updated  ${configPath}`)
    }
    printDomainNextSteps(cwd, domain)
  } catch (err) {
    console.error((err as Error).message)
    process.exit(1)
  }
}

function printDomainNextSteps(cwd: string, domain: string): void {
  let tlsActive = true
  try {
    tlsActive = selfHostTlsEnabled(loadConfig(cwd))
  } catch {
    // config re-load is best-effort for the warning below
  }

  console.log(`\nDomain set to ${domain} with automatic HTTPS.`)
  if (!tlsActive) {
    console.log(
      "\nNote: a supatype.local.config.ts override (server.mode=dev) is suppressing HTTPS locally.\n" +
        "That file is gitignored, so HTTPS still activates on your production server.",
    )
  }
  console.log("\nGo live:")
  console.log(`  1. Point DNS: an A record for ${domain} -> your server's public IP`)
  console.log("  2. Open ports 80 and 443 on the server firewall")
  console.log("  3. supatype self-host compose up -d   # Kong provisions HTTPS automatically")
  console.log(`\nYour Supatype platform goes live at https://${domain}`)
  console.log("  Your app, REST, Auth, Storage, Realtime, Functions, and Studio — all behind one HTTPS domain.")
  console.log("  Certificates persist in the valkey-data volume.\n")
}
