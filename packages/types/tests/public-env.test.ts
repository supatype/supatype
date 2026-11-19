import { describe, expect, it } from "vitest"
import {
  FRONTEND_PUBLIC_PREFIXES,
  PUBLIC_ENV_LIMITS,
  prefixedPublicEnv,
  publicEnvFor,
  publicEnvProblems,
  secretLookingReason,
  publicEnvRefusal,
  ENVIRONMENT_NAME,
  PUBLIC_ENV_SOURCES,
  PUBLIC_ENV_SOURCE_LABELS,
  isPublicEnvDeclaration,
  isPublicEnvEntry,
} from "../src/index.js"

const jwt = (claims: Record<string, unknown>): string =>
  ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".")

describe("publicEnvProblems: names", () => {
  it("accepts upper-case names with digits and underscores", () => {
    expect(publicEnvProblems({ STRIPE_PUBLISHABLE_KEY: "pk_live_1", MAPS_2: "x" })).toEqual([])
  })

  it.each(["stripe_key", "1KEY", "KEY-NAME", "KEY NAME", "", "KEY.X"])("refuses the name %j", (name) => {
    const problems = publicEnvProblems({ [name]: "x" })
    expect(problems).toHaveLength(1)
    expect(problems[0]?.name).toBe(name)
  })

  it("refuses a name longer than the limit", () => {
    expect(publicEnvProblems({ ["A".repeat(PUBLIC_ENV_LIMITS.nameBytes + 1)]: "x" })).toHaveLength(1)
    expect(publicEnvProblems({ ["A".repeat(PUBLIC_ENV_LIMITS.nameBytes)]: "x" })).toEqual([])
  })

  it("refuses a name that already carries a framework prefix, and the names Supatype's own values use", () => {
    for (const name of ["VITE_X", "PUBLIC_X", "NEXT_PUBLIC_X", "EXPO_PUBLIC_X", "SUPATYPE_URL", "SUPATYPE_ANON_KEY", "SUPATYPE_ANYTHING"]) {
      expect(publicEnvProblems({ [name]: "x" }), name).toHaveLength(1)
    }
  })
})

describe("publicEnvProblems: sizes", () => {
  it("refuses a value over the limit, counted in bytes", () => {
    expect(publicEnvProblems({ A: "x".repeat(PUBLIC_ENV_LIMITS.valueBytes) })).toEqual([])
    expect(publicEnvProblems({ A: "x".repeat(PUBLIC_ENV_LIMITS.valueBytes + 1) })).toHaveLength(1)
    expect(publicEnvProblems({ A: "é".repeat(PUBLIC_ENV_LIMITS.valueBytes / 2 + 1) })).toHaveLength(1)
  })

  it("refuses more names than the limit", () => {
    const many = Object.fromEntries(Array.from({ length: PUBLIC_ENV_LIMITS.names + 1 }, (_, i) => [`K${i}`, "x"]))
    const problems = publicEnvProblems(many)
    expect(problems.some((p) => p.name === "")).toBe(true)
  })

  it("refuses a total over the limit", () => {
    const big = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`K${i}`, "x".repeat(PUBLIC_ENV_LIMITS.valueBytes)]))
    expect(PUBLIC_ENV_LIMITS.valueBytes * 10).toBeGreaterThan(PUBLIC_ENV_LIMITS.totalBytes)
    expect(publicEnvProblems(big).some((p) => p.name === "")).toBe(true)
  })
})

describe("secretLookingReason", () => {
  it.each([
    ["a Stripe secret key", "sk_live_51Habcdefghijkl"],
    ["a Stripe test secret key", "sk_test_51Habcdefghijkl"],
    ["a restricted key", "rk_live_51Habcdefghijkl"],
    ["a PEM private key", "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----"],
    ["an RSA private key", "-----BEGIN RSA PRIVATE KEY-----\nMIIE"],
    ["an OpenSSH private key", "-----BEGIN OPENSSH PRIVATE KEY-----"],
    ["a service role token", jwt({ role: "service_role" })],
  ])("refuses %s", (_label, value) => {
    expect(secretLookingReason(value)).toBeDefined()
  })

  it.each([
    ["a publishable key", "pk_live_51Habcdefghijkl"],
    ["an anon token", jwt({ role: "anon" })],
    ["an address", "https://api.example.com"],
    ["a word that only contains sk_", "risk_factor_high"],
    ["a public key block", "-----BEGIN PUBLIC KEY-----\nMIIB"],
  ])("accepts %s", (_label, value) => {
    expect(secretLookingReason(value)).toBeUndefined()
  })

  it("refuses a value equal to a secret it was told about", () => {
    expect(secretLookingReason("abc123secret", ["abc123secret"])).toBeDefined()
    expect(secretLookingReason("abc123secret", ["other"])).toBeUndefined()
  })

  it("never echoes the value in the reason", () => {
    const reason = secretLookingReason("sk_live_51Habcdefghijkl")
    expect(reason).not.toContain("51Habcdefghijkl")
  })
})

describe("publicEnvProblems: secrets", () => {
  it("names the key, never the value", () => {
    const problems = publicEnvProblems({ STRIPE: "sk_live_51Habcdefghijkl" })
    expect(problems).toHaveLength(1)
    expect(problems[0]?.name).toBe("STRIPE")
    expect(JSON.stringify(problems)).not.toContain("51Habcdefghijkl")
  })

  it("reports every problem at once", () => {
    expect(publicEnvProblems({ bad: "x", STRIPE: "sk_live_51Habcdefghijkl" })).toHaveLength(2)
  })
})

describe("publicEnvFor", () => {
  it("gives a plain string to every environment", () => {
    expect(publicEnvFor({ A: "1" }, "production")).toEqual({ A: "1" })
    expect(publicEnvFor({ A: "1" }, "staging")).toEqual({ A: "1" })
  })

  it("picks the environment's entry from a map", () => {
    const declared = { A: { production: "p", staging: "s" }, B: "all" }
    expect(publicEnvFor(declared, "production")).toEqual({ A: "p", B: "all" })
    expect(publicEnvFor(declared, "staging")).toEqual({ A: "s", B: "all" })
  })

  it("leaves a name out of an environment its map does not name", () => {
    expect(publicEnvFor({ A: { production: "p" } }, "staging")).toEqual({})
  })

  it("is empty for no declaration", () => {
    expect(publicEnvFor(undefined, "production")).toEqual({})
  })
})

describe("prefixedPublicEnv", () => {
  it("puts each value under every framework's prefix", () => {
    const out = prefixedPublicEnv({ MAPS_KEY: "m" })
    for (const prefix of FRONTEND_PUBLIC_PREFIXES) expect(out[`${prefix}MAPS_KEY`]).toBe("m")
    expect(Object.keys(out)).toHaveLength(FRONTEND_PUBLIC_PREFIXES.length)
  })
})

describe("publicEnvRefusal", () => {
  const problems = [{ name: "A", reason: "is bad" }, { name: "", reason: "too many" }]
  it("says each problem by name, and the set's own as such", () => {
    expect(publicEnvRefusal(problems)).toBe("A is bad; The public values: too many")
  })
  it("joins with the separator it is given", () => {
    expect(publicEnvRefusal(problems, " | ")).toBe("A is bad | The public values: too many")
  })
})

describe("where a value is set", () => {
  it("is the config or Studio, each with its label", () => {
    expect(PUBLIC_ENV_SOURCES).toEqual(["config", "studio"])
    expect(PUBLIC_ENV_SOURCE_LABELS).toEqual({ config: "set in supatype.config.ts", studio: "set in Studio" })
  })
})

describe("isPublicEnvEntry", () => {
  it("accepts a name, a value and a source", () => {
    expect(isPublicEnvEntry({ name: "A", value: "1", source: "config" })).toBe(true)
    expect(isPublicEnvEntry({ name: "A", value: "1", source: "studio" })).toBe(true)
  })
  it.each([null, "A", [], {}, { name: "A", value: "1" }, { name: "A", value: 1, source: "config" }, { name: "A", value: "1", source: "env" }])("refuses %j", (value) => {
    expect(isPublicEnvEntry(value)).toBe(false)
  })
})

describe("ENVIRONMENT_NAME", () => {
  it.each(["production", "staging", "a", "qa-1", "x_y"])("accepts %s", (name) => expect(ENVIRONMENT_NAME.test(name)).toBe(true))
  it.each(["", "Prod", "-a", "a b", "a".repeat(64)])("refuses %j", (name) => expect(ENVIRONMENT_NAME.test(name)).toBe(false))
})

describe("isPublicEnvDeclaration", () => {
  it("accepts a string for every environment and a map of environment to string", () => {
    expect(isPublicEnvDeclaration({ A: "1", B: { production: "p", staging: "s" } })).toBe(true)
    expect(isPublicEnvDeclaration({})).toBe(true)
  })
  it.each([null, "A=1", [], { A: 1 }, { A: null }, { A: { production: 1 } }, { A: { "Not Valid": "x" } }, { A: ["x"] }])("refuses %j", (value) => {
    expect(isPublicEnvDeclaration(value)).toBe(false)
  })
})
