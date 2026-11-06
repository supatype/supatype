/**
 * `supatype sso`: SAML single sign-on.
 *
 * SAML itself is switched on in supatype.config.ts (`auth.sso.saml.enabled`). Identity providers are
 * runtime data, usually one per customer, so they are registered here through the auth server's
 * admin API, against the local stack or a linked self-hosted deployment, rather than declared in
 * the config. `info` prints what to give an identity provider; `rotate-key` rotates the signing key.
 */
import type { Command } from "commander"
import { loadConfig } from "../config.js"
import { errorMessage } from "../error-message.js"
import type { SupatypeProjectConfig } from "../project-config.js"
import { AUTH_ROUTES_PATH, SAML_NEXT_PRIVATE_KEY_ENV, SAML_PRIVATE_KEY_ENV, samlEnabled } from "../saml-config.js"
import { createNextSamlKey, promoteNextSamlKey } from "../saml-key-rotation.js"
import {
  NAME_ID_FORMATS,
  assertProviderName,
  createSsoProvider,
  getSsoProvider,
  linkedToDeployment,
  listSsoProviders,
  removeSsoProvider,
  resolveSsoEndpoint,
  ssoApiBaseUrl,
  ssoProviderInput,
  updateSsoProvider,
  type SsoFlags,
  type SsoProvider,
} from "../sso-admin.js"
import { askConsent } from "../ui/confirm.js"
import { error, info, plain, warn } from "../ui/messages.js"

/** The attribute the server reads a user's stable id from before it falls back to the NameID. */
const SUBJECT_ID_ATTRIBUTE = "urn:oasis:names:tc:SAML:attribute:subject-id"

const NAME_ID_CHOICES = Object.keys(NAME_ID_FORMATS).join("|")

export function registerSso(program: Command): void {
  const sso = program
    .command("sso")
    .description(
      "SAML single sign-on: register identity providers, print the service provider's values, rotate its key.\n" +
        "Turn SAML on with auth.sso.saml.enabled in supatype.config.ts.",
    )
  registerAdd(sso)
  registerReadCommands(sso)
  registerUpdate(sso)
  registerRemove(sso)
  registerInfo(sso)
  registerRotateKey(sso)
}

/** The flags `add` and `update` share. */
function withProviderFlags(command: Command): Command {
  return command
    .option("--metadata-url <url>", "The identity provider's SAML metadata URL (https; http on a dev stack)")
    .option("--metadata-file <path>", "The identity provider's SAML metadata XML, from a file")
    .option("--domains <list>", "Email domains that sign in through this provider, comma-separated: a.com,b.com")
    .option("--attribute-mapping-file <path>", 'JSON mapping assertion attributes to user metadata: { "keys": { ... } }')
    .option("--name-id-format <format>", `The NameID format to request: ${NAME_ID_CHOICES}`)
}

/** Run an action, ending the command with the reason when it fails. */
function guarded<A extends unknown[]>(fn: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await fn(...args)
    } catch (err) {
      error(errorMessage(err))
      process.exitCode = 1
    }
  }
}

function registerAdd(sso: Command): void {
  withProviderFlags(
    sso
      .command("add <name>")
      .description(
        "Register a SAML identity provider. <name> is how every other sso command refers to it.\n" +
          "Example: supatype sso add acme --metadata-url https://idp.acme.com/metadata --domains acme.com",
      ),
  ).action(guarded(addProvider))
}

async function addProvider(name: string, flags: SsoFlags): Promise<void> {
  assertProviderName(name)
  const input = await ssoProviderInput(flags, { requireMetadata: true })
  const endpoint = resolveSsoEndpoint(process.cwd(), "add")
  const provider = await createSsoProvider(endpoint, name, input)
  info(`Added SAML provider ${name} to ${endpoint.where}.`)
  printProvider(provider)
  warnIfSamlOff(process.cwd())
  plain("\nGive the identity provider this project's service provider values: supatype sso info")
}

function registerReadCommands(sso: Command): void {
  sso
    .command("list")
    .description("List the SAML identity providers")
    .action(guarded(listProviders))
  sso
    .command("show <name>")
    .description("Show one SAML identity provider")
    .action(
      guarded(async (name: string) => {
        assertProviderName(name)
        printProvider(await getSsoProvider(resolveSsoEndpoint(process.cwd(), "show"), name))
      }),
    )
}

async function listProviders(): Promise<void> {
  const endpoint = resolveSsoEndpoint(process.cwd(), "list")
  const providers = await listSsoProviders(endpoint)
  if (providers.length === 0) {
    info(`No SAML identity providers on ${endpoint.where}. Add one with: supatype sso add <name> --metadata-url <url>`)
    return
  }
  const rows = providers.map((p) => [providerName(p), domainsOf(p) || "-", p.saml?.entity_id ?? "-", status(p)])
  for (const line of table(["NAME", "DOMAINS", "ENTITY ID", "STATUS"], rows)) plain(line)
}

function registerUpdate(sso: Command): void {
  withProviderFlags(
    sso
      .command("update <name>")
      .description(
        "Change a SAML identity provider in place. Only the flags given change; --domains replaces the list.\n" +
          "New metadata must keep the provider's entity ID.",
      ),
  ).action(guarded(updateProvider))
}

async function updateProvider(name: string, flags: SsoFlags): Promise<void> {
  assertProviderName(name)
  const input = await ssoProviderInput(flags, { requireMetadata: false })
  if (Object.keys(input).length === 0) {
    throw new Error("Nothing to change: give --metadata-url, --metadata-file, --domains, --attribute-mapping-file or --name-id-format")
  }
  const endpoint = resolveSsoEndpoint(process.cwd(), "update")
  printProvider(await updateSsoProvider(endpoint, name, input))
  info(`Updated SAML provider ${name} on ${endpoint.where}.`)
}

function registerRemove(sso: Command): void {
  sso
    .command("remove <name>")
    .description("Remove a SAML identity provider. Users who signed in through it can no longer sign in that way.")
    .option("-y, --yes", "Remove without asking")
    .action(guarded(removeProvider))
}

async function removeProvider(name: string, opts: { yes?: boolean }): Promise<void> {
  assertProviderName(name)
  const endpoint = resolveSsoEndpoint(process.cwd(), "remove")
  warn(
    `Users who signed in through ${name} can no longer sign in that way. Adding a provider called ${name} ` +
      "again later makes a new one, which their accounts are not linked to.",
  )
  const consent = await askConsent(`Remove SAML provider ${name} from ${endpoint.where}?`, opts.yes === true)
  if (consent === "needs-yes") throw new Error("sso remove needs --yes when not interactive")
  if (consent === "declined") {
    plain("Nothing removed.")
    return
  }
  await removeSsoProvider(endpoint, name)
  info(`Removed SAML provider ${name} from ${endpoint.where}.`)
}

function registerInfo(sso: Command): void {
  sso
    .command("info")
    .description("Print the service provider values to give an identity provider: entity ID, ACS URL, NameID, metadata")
    .action(
      guarded(async () => {
        const cwd = process.cwd()
        const config = loadConfig(cwd)
        for (const line of serviceProviderInfo(samlServiceProviderUrl(config, ssoApiBaseUrl(cwd).baseUrl))) plain(line)
        const off = samlOffWarning(config)
        if (off !== undefined) warn(off)
      }),
    )
}

/** Where the service provider is: `auth.sso.saml.externalUrl`, else the API's `/auth/v1`, as the stack sets it. */
export function samlServiceProviderUrl(config: SupatypeProjectConfig, apiBaseUrl: string): string {
  const stated = config.auth?.sso?.saml?.externalUrl?.trim()
  return (stated ?? `${apiBaseUrl.replace(/\/+$/, "")}${AUTH_ROUTES_PATH}`).replace(/\/+$/, "")
}

/** The values an identity provider asks for, for the service provider at `samlUrl`. */
export function serviceProviderInfo(samlUrl: string): string[] {
  const metadata = `${samlUrl}/sso/saml/metadata`
  const row = (label: string, value: string): string => `  ${label.padEnd(26)}${value}`
  return [
    "Service provider values to give your identity provider:",
    "",
    row("Entity ID / metadata URL", metadata),
    row("ACS URL", `${samlUrl}/sso/saml/acs`),
    row("ACS binding", "HTTP-POST"),
    row("NameID format", `${NAME_ID_FORMATS.persistent} (requested)`),
    row("", `${NAME_ID_FORMATS.emailAddress} (also accepted)`),
    row("User ID", `the ${SUBJECT_ID_ATTRIBUTE} attribute when sent, preferred to the NameID`),
    row("Email", "an email or mail attribute, or the NameID when its format is emailAddress"),
    row("Signing", "sign the assertion or the response; AuthnRequests from this SP are signed"),
    "",
    `Metadata XML to download: ${metadata}?download=true`,
  ]
}

/** What to say when the project has not turned SAML on, or nothing when it has. */
export function samlOffWarning(config: SupatypeProjectConfig): string | undefined {
  if (samlEnabled(config)) return undefined
  return (
    "SAML is off for this project: set auth.sso.saml.enabled to true in supatype.config.ts and restart the " +
    "stack. Providers can be registered first, but nobody can sign in through them until then."
  )
}

/** {@link samlOffWarning} for the project in `cwd`, when its config can be read. */
function warnIfSamlOff(cwd: string): void {
  let config: SupatypeProjectConfig
  try {
    config = loadConfig(cwd)
  } catch {
    return
  }
  const off = samlOffWarning(config)
  if (off !== undefined) warn(off)
}

function registerRotateKey(sso: Command): void {
  sso
    .command("rotate-key")
    .description(
      `Rotate the SAML signing key: create ${SAML_NEXT_PRIVATE_KEY_ENV} in .env, published beside the current ` +
        "key while identity providers take the new certificate; then --promote makes it the current key.",
    )
    .option("--promote", `Make the next key current, replacing ${SAML_PRIVATE_KEY_ENV}`)
    .option("-y, --yes", "Promote without asking")
    .action(guarded(rotateKey))
}

async function rotateKey(opts: { promote?: boolean; yes?: boolean }): Promise<void> {
  const cwd = process.cwd()
  if (linkedToDeployment(cwd)) {
    for (const line of serverRotationSteps()) plain(line)
    return
  }
  if (opts.promote === true) {
    await promoteKey(cwd, opts.yes === true)
    return
  }
  const created = createNextSamlKey(cwd) === "created"
  info(created ? `Created ${SAML_NEXT_PRIVATE_KEY_ENV} in .env.` : `${SAML_NEXT_PRIVATE_KEY_ENV} is already in .env; kept it.`)
  for (const line of overlapSteps()) plain(line)
}

function overlapSteps(): string[] {
  return [
    "",
    "During the overlap the server lists both certificates in its SP metadata, signs requests with the",
    "current key, and decrypts assertions with either. Next:",
    "  1. Restart the stack (supatype dev, or supatype self-host compose up) so the server loads the key.",
    "  2. Give every identity provider the new metadata (supatype sso info prints the link).",
    "  3. Then make the new key current: supatype sso rotate-key --promote",
  ]
}

async function promoteKey(cwd: string, yes: boolean): Promise<void> {
  warn(
    "Identity providers that have not taken the new certificate stop working with this SP: a request signed " +
      "with the new key fails their signature check, and an assertion they encrypt to the old certificate " +
      "can no longer be decrypted.",
  )
  const consent = await askConsent(`Make ${SAML_NEXT_PRIVATE_KEY_ENV} the current SAML key?`, yes)
  if (consent === "needs-yes") throw new Error("sso rotate-key --promote needs --yes when not interactive")
  if (consent === "declined") {
    plain("Nothing changed.")
    return
  }
  if (promoteNextSamlKey(cwd) === "no-next-key") {
    throw new Error(`There is no ${SAML_NEXT_PRIVATE_KEY_ENV} in .env to promote. Create one first: supatype sso rotate-key`)
  }
  info(`${SAML_PRIVATE_KEY_ENV} is now the new key, and ${SAML_NEXT_PRIVATE_KEY_ENV} is removed. Restart the stack to use it.`)
}

/** What to do on a linked deployment, whose key is in the server's environment rather than this `.env`. */
function serverRotationSteps(): string[] {
  return [
    "This project is linked to a deployment, whose SAML key is in the server's environment, not this .env.",
    "On the server:",
    `  1. Set ${SAML_NEXT_PRIVATE_KEY_ENV} to a new key and restart it. In the server's project directory,`,
    "     supatype sso rotate-key writes one into its .env.",
    "  2. Give every identity provider the new metadata (supatype sso info prints the link).",
    `  3. Move that value to ${SAML_PRIVATE_KEY_ENV}, remove ${SAML_NEXT_PRIVATE_KEY_ENV}, and restart`,
    "     (supatype sso rotate-key --promote in the server's project directory).",
  ]
}

function providerName(provider: SsoProvider): string {
  return provider.resource_id ?? `(unnamed) ${provider.id}`
}

function domainsOf(provider: SsoProvider): string {
  return (provider.domains ?? []).map((d) => d.domain).join(", ")
}

function status(provider: SsoProvider): string {
  return provider.disabled === true ? "disabled" : "enabled"
}

function printProvider(provider: SsoProvider): void {
  const saml = provider.saml
  const rows: [string, string][] = [
    ["Name", providerName(provider)],
    ["ID", provider.id],
    ["Status", status(provider)],
    ["Entity ID", saml?.entity_id ?? "-"],
    ["Metadata", saml?.metadata_url ?? "from XML"],
    ["Domains", domainsOf(provider) || "-"],
    ["NameID format", saml?.name_id_format ?? "(the SP's default, persistent)"],
    ["Attribute mapping", saml?.attribute_mapping === undefined ? "-" : JSON.stringify(saml.attribute_mapping)],
  ]
  for (const [label, value] of rows) plain(`  ${label.padEnd(19)}${value}`)
}

/** Rows under a header, each column as wide as its widest cell. */
function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)))
  const line = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd()
  return [line(header), ...rows.map(line)]
}
