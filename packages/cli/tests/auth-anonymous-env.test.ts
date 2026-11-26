import { describe, expect, it } from "vitest"
import { nativeServerDotEnvLayer } from "../src/native-dev-env.js"
import { validateProjectConfig } from "../src/project-config.js"
import { renderSelfHostCompose } from "../src/self-host-compose.js"

/**
 * The docs turn anonymous sign-in on with `SUPATYPE_EXTERNAL_ANONYMOUS_USERS_ENABLED=true` in
 * `.env`. The compose file (docker dev and self-host) never passed it to the server, so the value
 * reached nothing and `signInAnonymously()` stayed refused with "Anonymous sign-ins are disabled".
 */

const KEY = "SUPATYPE_EXTERNAL_ANONYMOUS_USERS_ENABLED"
const config = validateProjectConfig(
  { project: { name: "demo" }, server: { mode: "dev" }, app: { mode: "none" }, database: { provider: "docker" } },
  "supatype.config.ts",
)

describe("anonymous sign-in switch from .env", () => {
  it("reaches the server in the self-host and docker dev compose files, off unless .env says", () => {
    expect(renderSelfHostCompose(config)).toContain(`${KEY}: \${${KEY}:-false}`)
    expect(renderSelfHostCompose(config, process.cwd(), { devLocal: true })).toContain(`${KEY}: \${${KEY}:-false}`)
  })

  it("reaches the server in native dev", () => {
    expect(nativeServerDotEnvLayer({ dotEnv: { [KEY]: "true" }, config, denoPort: 54330 })[KEY]).toBe("true")
  })
})

/**
 * docs/realtime.md lists REALTIME_CHANNELS and REALTIME_CHANNEL_RECHECK_S as the realtime
 * service's settings, and the compose file passed neither, so a value in `.env` changed nothing.
 * Unset renders empty, which the service reads as absent.
 */
describe("realtime channel settings from .env", () => {
  it("reach the realtime service, empty when .env says nothing", () => {
    for (const compose of [renderSelfHostCompose(config), renderSelfHostCompose(config, process.cwd(), { devLocal: true })]) {
      expect(compose).toContain("REALTIME_CHANNELS: ${REALTIME_CHANNELS:-}")
      expect(compose).toContain("REALTIME_CHANNEL_RECHECK_S: ${REALTIME_CHANNEL_RECHECK_S:-}")
    }
  })
})
