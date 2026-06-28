import { describe, expect, it } from "vitest"
import {
  ADMIN_EMAIL_ENV,
  ADMIN_PASSWORD_ENV,
  clearAdminSeedPassword,
  composePostgresPassword,
  GOTRUE_NIL_INSTANCE_ID,
  gotrueJwtAud,
  hashPasswordForAuth,
  resolveAuthConfirmedAtColumn,
} from "../src/commands/admin.js"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { scaffold, defaultScaffoldOptions } from "../src/commands/init.js"

describe("hashPasswordForAuth", () => {
  it("produces a bcrypt hash", async () => {
    const hash = await hashPasswordForAuth("test-password-123")
    expect(hash.startsWith("$2")).toBe(true)
  })
})

describe("clearAdminSeedPassword", () => {
  it("removes SUPATYPE_ADMIN_PASSWORD from .env", () => {
    const dir = join(tmpdir(), `supatype-admin-seed-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, ".env"),
      `${ADMIN_EMAIL_ENV}=admin@example.com\n${ADMIN_PASSWORD_ENV}=secret123\nJWT_SECRET=x\n`,
      "utf8",
    )
    try {
      clearAdminSeedPassword(dir)
      const content = readFileSync(join(dir, ".env"), "utf8")
      expect(content).toContain(`${ADMIN_EMAIL_ENV}=admin@example.com`)
      expect(content).not.toContain(ADMIN_PASSWORD_ENV)
      expect(content).toContain("JWT_SECRET=x")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("composePostgresPassword", () => {
  it("reads POSTGRES_PASSWORD from .env", () => {
    const dir = join(tmpdir(), `supatype-admin-pgpass-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, ".env"), "POSTGRES_PASSWORD=secret\n", "utf8")
    try {
      expect(composePostgresPassword(dir)).toBe("secret")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("defaults to postgres when unset", () => {
    const dir = join(tmpdir(), `supatype-admin-pgpass-default-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    try {
      expect(composePostgresPassword(dir)).toBe("postgres")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("gotrueJwtAud", () => {
  it("reads GOTRUE_JWT_AUD from .env", () => {
    const dir = join(tmpdir(), `supatype-admin-aud-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, ".env"), "GOTRUE_JWT_AUD=custom-aud\n", "utf8")
    try {
      expect(gotrueJwtAud(dir)).toBe("custom-aud")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("defaults to authenticated", () => {
    const dir = join(tmpdir(), `supatype-admin-aud-default-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    try {
      expect(gotrueJwtAud(dir)).toBe("authenticated")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("GOTRUE_NIL_INSTANCE_ID", () => {
  it("is the nil UUID GoTrue uses for lookup", () => {
    expect(GOTRUE_NIL_INSTANCE_ID).toBe("00000000-0000-0000-0000-000000000000")
  })
})

describe("resolveAuthConfirmedAtColumn", () => {
  it("prefers email_confirmed_at when both columns exist", async () => {
    const column = await resolveAuthConfirmedAtColumn(async () => ({
      rows: [{ column_name: "email_confirmed_at" }],
      rowCount: 1,
      command: "SELECT",
      oid: 0,
      fields: [],
    }))
    expect(column).toBe("email_confirmed_at")
  })

  it("falls back to confirmed_at for postgres init schema", async () => {
    const column = await resolveAuthConfirmedAtColumn(async () => ({
      rows: [{ value: "confirmed_at" }],
      rowCount: 1,
      command: "SELECT",
      oid: 0,
      fields: [],
    }))
    expect(column).toBe("confirmed_at")
  })
})

describe("init admin seed in .env", () => {
  it("writes SUPATYPE_ADMIN_* when scaffold options include credentials", () => {
    const dir = join(tmpdir(), `supatype-init-admin-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    try {
      scaffold(dir, {
        ...defaultScaffoldOptions("seeded-app"),
        adminEmail: "admin@example.com",
        adminPassword: "password123",
      })
      const env = readFileSync(join(dir, ".env"), "utf8")
      expect(env).toContain("SUPATYPE_ADMIN_EMAIL=admin@example.com")
      expect(env).toContain("SUPATYPE_ADMIN_PASSWORD=password123")
      expect(existsSync(join(dir, ".env"))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
