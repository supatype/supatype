import { describe, expect, it } from "vitest"
import { renderSelfHostCompose } from "../src/self-host-compose.js"
import { validateProjectConfig, type SupatypeProjectConfig } from "../src/project-config.js"
import { platformSettingsBody, serviceSwitchServerEnv, storageBucketPlan } from "../src/platform-settings.js"
import { DENO_RELEASE_PIN } from "../src/release-pins.js"

/**
 * `services`, `realtime.recheckSeconds` and `storage.s3`: what they are checked against when the
 * config is read, what self-host renders from them, and what a Cloud push sends. A config that uses
 * none of them renders and sends exactly what it did.
 */
const config = (extra: Record<string, unknown> = {}): SupatypeProjectConfig =>
  validateProjectConfig(
    {
      project: { name: "acme" },
      server: { mode: "standalone" },
      app: { mode: "none" },
      database: { provider: "docker" },
      versions: { postgres: "17.2", deno: DENO_RELEASE_PIN },
      ...extra,
    },
    "supatype.config.ts",
  )

const OWN_BUCKET = {
  storage: {
    provider: "s3",
    production: "s3",
    s3: { bucket: "acme-files", region: "eu-west-1", accessKey: "env(ACME_S3_KEY)", secretKey: "env(ACME_S3_SECRET)" },
  },
}

/** The environment's lines of one compose service, trimmed. */
function serviceEnv(compose: string, service: string): string[] {
  const block = new RegExp(`^ {2}${service}:\\n([\\s\\S]*?)(?=^ {2}[a-z][a-z-]*:\\n|(?![\\s\\S]))`, "m").exec(compose)?.[1] ?? ""
  return block.split("\n").map((line) => line.trim())
}

describe("services", () => {
  it("renders the server's disabled switch for each service set to false, self-host and dev", () => {
    for (const devLocal of [false, true]) {
      const lines = serviceEnv(renderSelfHostCompose(config({ services: { storage: false, graphql: false } }), process.cwd(), { devLocal }), "server")
      expect(lines, `devLocal: ${devLocal}`).toContain('SUPATYPE_STORAGE_DISABLED: "true"')
      expect(lines, `devLocal: ${devLocal}`).toContain('SUPATYPE_GRAPHQL_DISABLED: "true"')
      expect(lines, `devLocal: ${devLocal}`).toContain('SUPATYPE_GRAPHQL_DISABLED_REASON: "project"')
    }
  })

  it("renders only the service that is off", () => {
    const lines = serviceEnv(renderSelfHostCompose(config({ services: { graphql: false } })), "server")
    expect(lines).toContain('SUPATYPE_GRAPHQL_DISABLED: "true"')
    expect(lines).toContain('SUPATYPE_GRAPHQL_DISABLED_REASON: "project"')
    expect(lines.join("\n")).not.toContain("SUPATYPE_STORAGE_DISABLED")
  })

  it.each([[undefined], [{}], [{ storage: true, graphql: true }]])("renders nothing for %o, leaving the server's default", (services) => {
    const compose = renderSelfHostCompose(config(services === undefined ? {} : { services }))
    expect(compose).not.toContain("SUPATYPE_STORAGE_DISABLED")
    expect(compose).not.toContain("SUPATYPE_GRAPHQL_DISABLED")
    expect(compose).not.toContain("SUPATYPE_GRAPHQL_DISABLED_REASON")
    expect(serviceSwitchServerEnv(config(services === undefined ? {} : { services }))).toEqual({})
  })

  it.each([
    [{ storage: "no" }, /services\.storage must be true or false/],
    [{ realtime: false }, /services\.realtime is not a service that can be switched/],
    ["off", /services must be an object/],
  ])("refuses %j", (services, message) => {
    expect(() => config({ services })).toThrow(message)
  })
})

describe("realtime.recheckSeconds and realtime.channels on self-host", () => {
  it("renders them as the realtime service's defaults, which a value in .env overrides", () => {
    const lines = serviceEnv(renderSelfHostCompose(config({ realtime: { channels: "declared", recheckSeconds: 90 } })), "realtime")
    expect(lines).toContain("REALTIME_CHANNELS: ${REALTIME_CHANNELS:-declared}")
    expect(lines).toContain("REALTIME_CHANNEL_RECHECK_S: ${REALTIME_CHANNEL_RECHECK_S:-90}")
  })

  it("leaves the lines as they were for a config that sets neither, or sets channels to open", () => {
    for (const realtime of [undefined, { channels: "open" }]) {
      const lines = serviceEnv(renderSelfHostCompose(config(realtime === undefined ? {} : { realtime })), "realtime")
      expect(lines).toContain("REALTIME_CHANNELS: ${REALTIME_CHANNELS:-}")
      expect(lines).toContain("REALTIME_CHANNEL_RECHECK_S: ${REALTIME_CHANNEL_RECHECK_S:-}")
    }
  })

  it.each([0, -1, 1.5, 86_401, "60"])("refuses a re-check interval of %j", (recheckSeconds) => {
    expect(() => config({ realtime: { recheckSeconds } })).toThrow(/realtime\.recheckSeconds must be a whole number of seconds from 1 to 86400/)
  })
})

describe("storage.s3", () => {
  it("is read, and changes nothing self-host renders", () => {
    const without = renderSelfHostCompose(config({ storage: { provider: "s3", production: "s3" } }))
    const withKeys = renderSelfHostCompose(config(OWN_BUCKET))
    expect(withKeys).toBe(without)
  })

  it.each([
    [{ storage: { provider: "s3", s3: OWN_BUCKET.storage.s3 } }, /storage\.s3 needs storage\.production set to "s3"/],
    [{ storage: { ...OWN_BUCKET.storage, s3: { ...OWN_BUCKET.storage.s3, accessKey: "AKIAEXAMPLE" } } }, /storage\.s3\.accessKey must name an environment variable, not hold the key/],
    [{ storage: { ...OWN_BUCKET.storage, s3: { ...OWN_BUCKET.storage.s3, secretKey: "hunter2" } } }, /storage\.s3\.secretKey must name an environment variable/],
    [{ storage: { ...OWN_BUCKET.storage, s3: { ...OWN_BUCKET.storage.s3, bucket: "" } } }, /storage\.s3\.bucket must be a non-empty string/],
    [{ storage: { ...OWN_BUCKET.storage, s3: { ...OWN_BUCKET.storage.s3, region: undefined } } }, /storage\.s3\.region is required for AWS S3/],
    [{ storage: { ...OWN_BUCKET.storage, s3: { ...OWN_BUCKET.storage.s3, prefix: "x" } } }, /storage\.s3\.prefix is not a setting/],
    [{ storage: { ...OWN_BUCKET.storage, s3: { ...OWN_BUCKET.storage.s3, forcePathStyle: "yes" } } }, /forcePathStyle must be true or false/],
  ])("refuses %j", (extra, message) => {
    expect(() => config(extra)).toThrow(message)
  })

  it("takes an endpoint in place of a region", () => {
    const { region: _region, ...s3 } = OWN_BUCKET.storage.s3
    expect(() => config({ storage: { ...OWN_BUCKET.storage, s3: { ...s3, endpoint: "https://r2.example.com" } } })).not.toThrow()
  })
})

describe("what a Cloud push sends", () => {
  it("sends nothing for a config that sets none of the settings", () => {
    expect(platformSettingsBody(config())).toBeUndefined()
    expect(storageBucketPlan(config(), {})).toEqual({ kind: "none" })
  })

  it("sends the switches and realtime options that are set, and only those", () => {
    expect(platformSettingsBody(config({ services: { storage: false }, realtime: { recheckSeconds: 60 } }))).toEqual({
      services: { storage: false },
      realtime: { recheckSeconds: 60 },
    })
  })

  it("sends a switch set to true, so a service turned back on is turned on", () => {
    expect(platformSettingsBody(config({ services: { storage: true } }))).toEqual({ services: { storage: true }, realtime: {} })
  })

  it("resolves the bucket's keys from the environment", () => {
    expect(storageBucketPlan(config(OWN_BUCKET), { ACME_S3_KEY: "AKIA1", ACME_S3_SECRET: "sec" })).toEqual({
      kind: "send",
      body: { bucket: "acme-files", region: "eu-west-1", accessKey: "AKIA1", secretKey: "sec" },
    })
  })

  it("names a key this machine does not have rather than sending it empty", () => {
    expect(storageBucketPlan(config(OWN_BUCKET), { ACME_S3_KEY: "AKIA1" })).toEqual({ kind: "missing", names: ["ACME_S3_SECRET"] })
    expect(storageBucketPlan(config(OWN_BUCKET), { ACME_S3_KEY: "", ACME_S3_SECRET: "" })).toEqual({ kind: "missing", names: ["ACME_S3_KEY", "ACME_S3_SECRET"] })
  })
})
