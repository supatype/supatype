/**
 * Cloud session login / logout for CLI control-plane auth.
 * Self-host uses SERVICE_ROLE_KEY via `supatype link --url` — not this command.
 */
import type { Command } from "commander"
import {
  clearCloudCredentials,
  cloudPasswordLogin,
  loadCloudCredentials,
  persistCloudSession,
} from "../cloud-credentials.js"
import { loadProjectLink, saveProjectLink } from "../link.js"
import { isInteractive } from "../ui/interactive.js"
import { error, info, plain } from "../ui/messages.js"
import { ensureNotCancelled, p, printLogo, runClackFlow } from "../ui/prompts.js"

function defaultApiUrl(cwd: string, flag?: string): string {
  if (flag?.trim()) return flag.trim().replace(/\/$/, "")
  const link = loadProjectLink(cwd)
  if (link?.kind === "cloud" && link.cloudApiUrl) {
    return link.cloudApiUrl.replace(/\/$/, "")
  }
  return (process.env["SUPATYPE_API_URL"] ?? "https://api.supatype.com").replace(/\/$/, "")
}

export function registerLogin(program: Command): void {
  program
    .command("login")
    .description("Sign in to Supatype Cloud (stores refreshable session for push/deploy)")
    .option("--api-url <url>", "Cloud control plane API URL")
    .option("--email <email>", "Account email (non-interactive)")
    .option("--password <password>", "Account password (prefer SUPATYPE_PASSWORD)")
    .action(async (opts: { apiUrl?: string; email?: string; password?: string }) => {
      const cwd = process.cwd()
      const apiUrl = defaultApiUrl(cwd, opts.apiUrl)

      let email = opts.email?.trim() ?? process.env["SUPATYPE_EMAIL"]?.trim()
      let password =
        opts.password ?? process.env["SUPATYPE_PASSWORD"] ?? process.env["SUPATYPE_LOGIN_PASSWORD"]

      if ((!email || !password) && isInteractive()) {
        await runClackFlow(async () => {
          printLogo()
          p.intro("Supatype Cloud login")
          if (!email) {
            email = ensureNotCancelled(
              await p.text({
                message: "Email",
                placeholder: "you@example.com",
              }),
            ).trim()
          }
          if (!password) {
            password = ensureNotCancelled(await p.password({ message: "Password" }))
          }
          p.outro("Signing in...")
        })
      }

      if (!email || !password) {
        error(
          "Email and password required. Pass --email / --password, set SUPATYPE_EMAIL + SUPATYPE_PASSWORD, or run interactively.",
        )
        process.exit(1)
      }

      try {
        const session = await cloudPasswordLogin(apiUrl, email, password)
        persistCloudSession(cwd, {
          apiUrl,
          accessToken: session.accessToken,
          ...(session.refreshToken !== undefined ? { refreshToken: session.refreshToken } : {}),
          ...(session.email !== undefined ? { email: session.email } : { email }),
        })
        const link = loadProjectLink(cwd)
        info(`Logged in to ${apiUrl}${session.email ? ` as ${session.email}` : ""}`)
        if (link?.kind === "cloud") {
          info(`Updated cloud session for linked project ${link.projectRef}`)
        } else if (!session.refreshToken) {
          plain("Warning: no refresh_token returned — session may expire in ~1h. Update control plane.")
        } else {
          plain("Tip: link a project with: supatype link --project <slug>")
        }
      } catch (err) {
        error((err as Error).message)
        process.exit(1)
      }
    })

  program
    .command("logout")
    .description("Clear stored Supatype Cloud credentials")
    .action(() => {
      const cwd = process.cwd()
      clearCloudCredentials()
      const link = loadProjectLink(cwd)
      if (link?.kind === "cloud") {
        delete link.token
        delete link.refreshToken
        saveProjectLink(cwd, link)
      }
      info("Logged out of Supatype Cloud.")
    })

  program
    .command("whoami")
    .description("Show the current Supatype Cloud session")
    .action(() => {
      const creds = loadCloudCredentials()
      const cwd = process.cwd()
      const link = loadProjectLink(cwd)
      if (!creds && !(link?.kind === "cloud" && link.token)) {
        info("Not logged in. Run: supatype login")
        return
      }
      if (creds) {
        plain(`API:   ${creds.apiUrl}`)
        if (creds.email) plain(`Email: ${creds.email}`)
        plain(`Refresh token: ${creds.refreshToken ? "yes" : "no"}`)
        plain(`Updated: ${creds.updatedAt}`)
      }
      if (link?.kind === "cloud") {
        plain(`Linked project: ${link.projectRef}`)
        plain(`Link has refresh token: ${link.refreshToken ? "yes" : "no"}`)
      }
    })
}
