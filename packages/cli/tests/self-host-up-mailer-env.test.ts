import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runCommand, tempProject } from "./support/command-run.js"
import { MANAGED_MARKER, readEnvFile } from "../src/env-file.js"

/**
 * Issues 74 and 75: `up` started production with the mailer values the last `dev` wrote into
 * `.env` from `supatype.local.config.ts`: dev's mail catcher, and dev's autoconfirm after the
 * committed config turned confirmations on. `up` writes them from the committed config first.
 */
vi.mock("../src/self-host-compose.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/self-host-compose.js")>()),
  writeSelfHostCompose: (cwd: string) => ({ composePath: join(cwd, "docker-compose.yml"), kongPath: "" }),
  runDockerCompose: () => 0,
}))
vi.mock("../src/compose-render-mode.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/compose-render-mode.js")>()),
  composeRenderOptions: () => ({ devLocal: false }),
}))
vi.mock("../src/compose-services.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/compose-services.js")>()),
  takenComposePorts: async () => [],
}))
vi.mock("../src/ui/interactive.js", () => ({ isInteractive: () => false }))

import { registerSelfHost } from "../src/commands/self-host.js"

let project: { dir: string; remove: () => void }

beforeEach(() => {
  project = tempProject("self-host-up-mailer")
  writeFileSync(
    join(project.dir, "supatype.config.ts"),
    `export default { project: { name: "acme" }, database: { provider: "docker" }, server: { mode: "standalone" }, app: { mode: "none" }, email: { provider: "smtp" }, auth: { email: { enableConfirmations: true } } }\n`,
  )
  writeFileSync(
    join(project.dir, ".env"),
    [
      "JWT_SECRET=0123456789abcdef0123456789abcdef0123456789abcdef",
      "ANON_KEY=a",
      "SERVICE_ROLE_KEY=s",
      MANAGED_MARKER,
      "SUPATYPE_MAILER_AUTOCONFIRM=true",
      MANAGED_MARKER,
      "SUPATYPE_SMTP_HOST=host.docker.internal",
      "",
    ].join("\n"),
  )
})

afterEach(() => {
  project.remove()
})

describe("self-host compose up", () => {
  it("writes the committed config's mailer values over the ones dev wrote", async () => {
    await runCommand(registerSelfHost, ["self-host", "compose", "up"], project.dir)
    const env = readEnvFile(project.dir)
    expect(env["SUPATYPE_MAILER_AUTOCONFIRM"]).toBe("false")
    expect(env["SUPATYPE_SMTP_HOST"]).toBeUndefined()
    expect(env["SUPATYPE_MAILER_MAILER_PROVIDER"]).toBe("smtp")
  })
})
