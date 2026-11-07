import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Command } from "commander"
import type { SupatypeProjectConfig } from "../src/project-config.js"

/**
 * `supatype sso` with SAML off: every admin subcommand works (providers can be set up first) and
 * says SAML is off, from one hook on the `sso` command rather than one call per subcommand. `info`
 * also says the values it prints are not served yet, and with SAML on it prints the SP certificate
 * from the served metadata: the current one, and the next one during a rotation.
 */

const loadConfig = vi.fn<() => SupatypeProjectConfig>()
const warn = vi.fn<(message: string) => void>()
const plain = vi.fn<(message?: string) => void>()

vi.mock("../src/config.js", async (original) => ({
  ...(await original<typeof import("../src/config.js")>()),
  loadConfig: () => loadConfig(),
}))
vi.mock("../src/ui/messages.js", async (original) => ({
  ...(await original<typeof import("../src/ui/messages.js")>()),
  warn: (message: string) => warn(message),
  plain: (message?: string) => plain(message),
  info: vi.fn(),
  error: vi.fn(),
}))
vi.mock("../src/sso-admin.js", async (original) => ({
  ...(await original<typeof import("../src/sso-admin.js")>()),
  ssoApiBaseUrl: () => ({ baseUrl: "http://localhost:18500", linked: false }),
}))

const { registerSso } = await import("../src/commands/sso.js")

const BASE: SupatypeProjectConfig = {
  project: { name: "acme" },
  database: { provider: "docker" },
  server: { mode: "dev" },
  app: { mode: "none" },
}
const OFF: SupatypeProjectConfig = { ...BASE, auth: { sso: { saml: { enabled: false } } } }
const ON: SupatypeProjectConfig = { ...BASE, auth: { sso: { saml: { enabled: true } } } }

/** Each subcommand with the arguments it requires. */
const SUBCOMMANDS: readonly string[][] = [
  ["add", "acme"],
  ["list"],
  ["show", "acme"],
  ["update", "acme"],
  ["remove", "acme"],
  ["info"],
  ["verify-domain", "acme", "acme.test"],
  ["rotate-key"],
]

/** A program with `sso` registered, every subcommand's own action replaced by nothing at all. */
function programWithoutActions(): Command {
  const program = new Command().exitOverride()
  registerSso(program)
  const sso = program.commands.find((c) => c.name() === "sso")
  for (const sub of sso?.commands ?? []) sub.action(async () => {})
  return program
}

function warnings(): string[] {
  return warn.mock.calls.map(([message]) => message)
}

function printed(): string {
  return plain.mock.calls.map(([message]) => message ?? "").join("\n")
}

beforeEach(() => {
  loadConfig.mockReset()
  warn.mockReset()
  plain.mockReset()
})
afterEach(() => vi.unstubAllGlobals())

/** Every subcommand but `info`, which says SAML is off in its own action. */
const HOOKED = SUBCOMMANDS.filter(([name]) => name !== "info")

describe("sso with SAML off", () => {
  it.each(HOOKED)("sso %s says SAML is off", async (...args) => {
    loadConfig.mockReturnValue(OFF)
    await programWithoutActions().parseAsync(["node", "supatype", "sso", ...args])
    expect(warnings().filter((w) => w.startsWith("SAML is off for this project"))).toHaveLength(1)
  })

  it.each(SUBCOMMANDS)("sso %s says nothing about it with SAML on", async (...args) => {
    loadConfig.mockReturnValue(ON)
    await programWithoutActions().parseAsync(["node", "supatype", "sso", ...args])
    expect(warnings()).toEqual([])
  })

  it("sso info says SAML is off once, that its values are not served, and fetches nothing", async () => {
    loadConfig.mockReturnValue(OFF)
    const fetched = vi.fn()
    vi.stubGlobal("fetch", fetched)
    const program = new Command().exitOverride()
    registerSso(program)
    await program.parseAsync(["node", "supatype", "sso", "info"])
    expect(fetched).not.toHaveBeenCalled()
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]).toMatch(/^SAML is off for this project/)
    expect(warnings()[0]).toMatch(
      /these values are not served: http:\/\/localhost:18500\/auth\/v1\/sso\/saml\/metadata answers 404/,
    )
  })
})

const CURRENT =
  "MIICCjCCAXOgAwIBAgIUI+ubPPG94II1Q8Y5Xbe7kxJI4AIwDQYJKoZIhvcNAQELBQAwFjEUMBIGA1UEAwwLU0FNTCB0ZXN0IGEwIBcNMjYxMTA2MjE1NzAwWhgPMjEyNjEwMTMyMTU3MDBaMBYxFDASBgNVBAMMC1NBTUwgdGVzdCBhMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCrf7WcMiPyQk/FLG8bRISo4sJh1VjCfNPwbsw7uXU9X1LP+M/yxegCeoWuzZ16aJTIXHjJQI4K3zsA4EcNllkQsAdngV5nSL10cfH2zXxkHlngTRk0GWAZedwk2W0fmCgBc4s0ovhe3GPWxrAJPGqQDhU1WxLFEnVrglSxbRaGUwIDAQABo1MwUTAdBgNVHQ4EFgQUdvwn+VHWAaI3lbE10Gw52YNTgnAwHwYDVR0jBBgwFoAUdvwn+VHWAaI3lbE10Gw52YNTgnAwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOBgQCNdsg780fBODn6fIq/DmvxDaDFelj/JyXCFGTN+mBgmlClSZAobseW9Wo2jkBIFqOg/QyqTb80nmcHYhzdOi1DqOdq68rw6WJd+Qz7yKijQvL0gffnhegFezCRvmC5/D2iqwcfRirAlBSQt9Xw++KQizlHy69S4+t3tCtXsOn1MQ=="
const NEXT =
  "MIICCjCCAXOgAwIBAgIUcL1fJJgp5VjaGqk0buw37afa3YcwDQYJKoZIhvcNAQELBQAwFjEUMBIGA1UEAwwLU0FNTCB0ZXN0IGIwIBcNMjYxMTA2MjE1NzAwWhgPMjEyNjEwMTMyMTU3MDBaMBYxFDASBgNVBAMMC1NBTUwgdGVzdCBiMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDF6J952lQMR7c+Iy+3iANdMkNU1lWZt5tbfwuuvQFSiXoX0MSEBlLZFrj9WsVisnG+ZTzwHTnuNPIYmmwIjaIByQ/321iK2GSJRCinGGsMwts1YeFiieP9F2/9e/qPcc1u1jTz++Vc55pUIQ76KVK18wTguGoETBH0e57xstMeOwIDAQABo1MwUTAdBgNVHQ4EFgQUlAibLDDk1gT2C1lU+LIjUQv/Hq0wHwYDVR0jBBgwFoAUlAibLDDk1gT2C1lU+LIjUQv/Hq0wDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOBgQADDkexTTnsl259GDH4v0RKt5KUN/LT3qzlolvUy8+mkHg5UDAOlnsdudlWgBEIDGic18G0S6oTMO8Rq0uUt8crX/U4ir5p0UpiKGGkBLHxhVlJomWSj8YljEYXHI05aRKOdlEDR70UYRJp7bi3RUWg+DALiOLlRZ4v4ExIp8/Seg=="

/** SP metadata as the server writes it: a signing and an encryption descriptor per certificate. */
function metadata(certificates: readonly string[]): string {
  const descriptor = (use: string, cert: string): string =>
    `<KeyDescriptor use="${use}"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data>` +
    `<ds:X509Certificate>${cert}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></KeyDescriptor>`
  const keys = certificates.flatMap((cert) => [descriptor("signing", cert), descriptor("encryption", cert)])
  return `<EntityDescriptor><SPSSODescriptor>${keys.join("")}</SPSSODescriptor></EntityDescriptor>`
}

async function runInfo(xml: string): Promise<string[]> {
  loadConfig.mockReturnValue(ON)
  const urls: string[] = []
  vi.stubGlobal("fetch", async (url: string) => {
    urls.push(url)
    return new Response(xml, { headers: { "Content-Type": "application/xml" } })
  })
  const program = new Command().exitOverride()
  registerSso(program)
  await program.parseAsync(["node", "supatype", "sso", "info"])
  return urls
}

describe("sso info with SAML on", () => {
  it("prints the SP certificate from the served metadata, as PEM with its fingerprint", async () => {
    const urls = await runInfo(metadata([CURRENT]))
    expect(urls).toEqual(["http://localhost:18500/auth/v1/sso/saml/metadata"])
    const out = printed()
    expect(out).toContain("-----BEGIN CERTIFICATE-----\nMIICCjCCAXOgAwIBAgIUI+ubPPG94II1Q8Y5Xbe7kxJI4AIw")
    expect(out).toMatch(/Signing certificate \(SHA-256 ([0-9A-F]{2}:){31}[0-9A-F]{2}\)/)
    expect(out).not.toMatch(/Next/)
  })

  it("prints the next certificate too while a rotation publishes it", async () => {
    await runInfo(metadata([CURRENT, NEXT]))
    const out = printed()
    expect(out.indexOf("Signing certificate")).toBeLessThan(out.indexOf("Next signing certificate"))
    expect(out).toContain("-----BEGIN CERTIFICATE-----\nMIICCjCCAXOgAwIBAgIUcL1fJJgp5VjaGqk0buw37afa3Ycw")
  })

  it("says where to get the certificate when the metadata cannot be read", async () => {
    loadConfig.mockReturnValue(ON)
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed")
    })
    const program = new Command().exitOverride()
    registerSso(program)
    await program.parseAsync(["node", "supatype", "sso", "info"])
    expect(warnings().join("\n")).toMatch(
      /Could not read the signing certificate from http:\/\/localhost:18500\/auth\/v1\/sso\/saml\/metadata/,
    )
  })
})
