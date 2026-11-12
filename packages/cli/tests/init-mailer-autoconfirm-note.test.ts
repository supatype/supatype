import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { defaultScaffoldOptions, scaffold } from "../src/commands/init.js"
import { readEnvValue } from "../src/env-file.js"
import { MAILER_AUTOCONFIRM_NOTE, retireCliMailerAutoconfirm } from "../src/mailer-autoconfirm.js"

/**
 * FF7: the CLI takes the SUPATYPE_MAILER_AUTOCONFIRM line an earlier CLI wrote out of `.env` once,
 * and leaves a note so it never does it again. An unmarked `true` looks the same whether an old CLI
 * or the developer wrote it, so a new project's own `true` was taken out on its first start. `init`
 * now writes the note itself: nothing in a new project's `.env` is ever the old CLI's.
 */
let dir = ""

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-init-autoconfirm-"))
  vi.spyOn(console, "log").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe("init .env and SUPATYPE_MAILER_AUTOCONFIRM", () => {
  for (const email of ["console", "smtp", "resend", "ses"] as const) {
    it(`writes the note with email.provider ${email}, so the developer's own true is kept`, () => {
      scaffold(dir, { ...defaultScaffoldOptions("note-app"), email })
      expect(readFileSync(join(dir, ".env"), "utf8").split(/\r?\n/)).toContain(MAILER_AUTOCONFIRM_NOTE)
      // init prints its own lines; only the retire step's message matters here.
      vi.mocked(console.log).mockClear()
      appendFileSync(join(dir, ".env"), "SUPATYPE_MAILER_AUTOCONFIRM=true\n")
      retireCliMailerAutoconfirm(dir)
      expect(readEnvValue(dir, "SUPATYPE_MAILER_AUTOCONFIRM", "<unset>")).toBe("true")
      expect(console.log).not.toHaveBeenCalled()
    })
  }
})
