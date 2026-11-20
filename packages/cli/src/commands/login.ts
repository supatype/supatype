/**
 * Cloud login / logout for CLI control-plane auth. `login` signs in through the accounts site in a
 * browser and stores the personal access token it hands back; `--token` stores one made by hand, for
 * CI. Self-host uses SERVICE_ROLE_KEY via `supatype link --url`, not this command.
 */
import type { Command } from "commander"
import { DEFAULT_API_URL, trimApiUrl } from "../api-url.js"
import {
  accountsUrl,
  defaultTokenName,
  fetchSealedToken,
  loginUrl,
  newLoginSession,
  openSealedToken,
  type LoginSession,
} from "../browser-login.js"
import { errorMessage } from "../error-message.js"
import {
  clearCloudCredentials,
  credentialKind,
  fetchCloudEmail,
  loadCloudCredentials,
  persistCloudSession,
} from "../cloud-credentials.js"
import { loadProjectLink, saveProjectLink } from "../link.js"
import { openBrowser } from "../open-browser.js"
import { isPersonalAccessToken } from "../personal-access-token.js"
import { isInteractive } from "../ui/interactive.js"
import { error, info, plain, warn } from "../ui/messages.js"
import { promptText } from "../ui/prompts.js"

/** How many codes `login` takes before giving up; the control plane forgets a login after 5 wrong ones. */
const MAX_CODE_ATTEMPTS = 5

interface LoginOptions {
  apiUrl?: string
  token?: string
  name?: string
  browser: boolean
}

function defaultApiUrl(cwd: string, flag?: string): string {
  if (flag?.trim()) return trimApiUrl(flag.trim())
  const link = loadProjectLink(cwd)
  if (link?.kind === "cloud" && link.cloudApiUrl) {
    return trimApiUrl(link.cloudApiUrl)
  }
  return trimApiUrl(process.env["SUPATYPE_API_URL"] ?? DEFAULT_API_URL)
}

/** Show the URL to open, and open it unless `--no-browser`; the URL is always printed, for a box with no browser. */
async function showLoginUrl(url: string, browser: boolean): Promise<void> {
  const opened = browser && (await openBrowser(url))
  info(opened ? "Opening your browser to sign in. If it does not open, visit:" : "Open this URL in a browser to sign in:")
  plain(url)
}

/** Ask for the code the browser shows until the control plane accepts one; the token it seals, opened. */
async function exchangeCode(apiUrl: string, session: LoginSession): Promise<string> {
  for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS; attempt++) {
    const code = await promptText("Enter the code shown in the browser", { placeholder: "XXXX-XXXX" })
    const sealed = await fetchSealedToken(apiUrl, session.sessionId, code)
    if (sealed !== undefined) return openSealedToken(session, sealed)
    if (attempt < MAX_CODE_ATTEMPTS) warn("That code was not accepted. Check it against the browser and try again.")
  }
  throw new Error("The code was not accepted. The login may have expired (it lasts 10 minutes) or been used. Run: supatype login")
}

/** Store `accessToken` as this machine's Cloud login and say who it is. */
function saveLogin(cwd: string, apiUrl: string, accessToken: string, email: string | undefined): void {
  const emailPart = email === undefined ? {} : { email }
  persistCloudSession(cwd, { apiUrl, accessToken, kind: "pat", ...emailPart })
  info(`Logged in to ${apiUrl}${email === undefined ? "" : ` as ${email}`}`)
  const link = loadProjectLink(cwd)
  if (link?.kind === "cloud") info(`Updated the login for linked project ${link.projectRef}`)
  else plain("Tip: link a project with: supatype link --project <slug>")
}

async function loginInBrowser(cwd: string, apiUrl: string, opts: LoginOptions): Promise<void> {
  if (!isInteractive()) {
    throw new Error("Logging in through the browser needs a terminal to type the code in. In CI, use --token <spt_...> or SUPATYPE_ACCESS_TOKEN.")
  }
  const session = newLoginSession(opts.name?.trim() || defaultTokenName())
  await showLoginUrl(loginUrl(await accountsUrl(apiUrl), session), opts.browser)
  const accessToken = await exchangeCode(apiUrl, session)
  const email = await fetchCloudEmail(apiUrl, accessToken).catch((err: unknown) => {
    warn(`Logged in, but could not look up the account: ${errorMessage(err)}`)
    return undefined
  })
  saveLogin(cwd, apiUrl, accessToken, email)
}

async function loginWithToken(cwd: string, apiUrl: string, token: string): Promise<void> {
  if (!isPersonalAccessToken(token)) {
    throw new Error("--token takes a personal access token (spt_ followed by 40 hex characters). Create one in your account's access tokens.")
  }
  saveLogin(cwd, apiUrl, token, await fetchCloudEmail(apiUrl, token))
}

export function registerLogin(program: Command): void {
  registerLoginCommand(program)
  registerLogout(program)
  registerWhoami(program)
}

function registerLoginCommand(program: Command): void {
  program
    .command("login")
    .description("Sign in to Supatype Cloud in your browser (stores a personal access token for push/deploy; closed beta: request access at https://www.supatype.com/#cloud)")
    .option("--api-url <url>", "Cloud control plane API URL")
    .option("--name <name>", "Name of the access token this makes (default: cli_<hostname>_<time>)")
    .option("--no-browser", "Print the sign-in URL instead of opening it")
    .option("--token <token>", "Store a personal access token (spt_...) instead of signing in, for CI")
    .action(async (opts: LoginOptions) => {
      const cwd = process.cwd()
      const apiUrl = defaultApiUrl(cwd, opts.apiUrl)
      try {
        if (opts.token !== undefined) await loginWithToken(cwd, apiUrl, opts.token.trim())
        else await loginInBrowser(cwd, apiUrl, opts)
      } catch (err) {
        error(errorMessage(err))
        process.exit(1)
      }
    })
}

function registerLogout(program: Command): void {
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
}

function registerWhoami(program: Command): void {
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
        plain(`Token: ${credentialKind(creds) === "pat" ? "personal access token" : "session (expires; run supatype login to replace it)"}`)
        plain(`Updated: ${creds.updatedAt}`)
      }
      if (link?.kind === "cloud") plain(`Linked project: ${link.projectRef}`)
    })
}
