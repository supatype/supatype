import { describe, expect, it } from "vitest"
import { applyManifestMaps, flattenHookSource, isCacheMap, isHookDeployAnswer, isHookDeployBody, isHookMap, unflattenHookSource } from "../src/index.js"

/**
 * The CLI and the self-host control plane write the manifest's maps and read the hook deploy body;
 * each had its own copy until both drew them from here.
 */
describe("applyManifestMaps", () => {
  it("sets a map, removes an empty one, and leaves one not given", () => {
    const manifest: Record<string, unknown> = { functions_enabled: true, validators: { t: { c: { function: "v" } } }, cache: { t: { enabled: true } } }
    const changed = applyManifestMaps(manifest, { hooks: { t: { beforeChange: { function: "h" } } }, cache: {} })
    expect(changed).toBe(true)
    expect(manifest).toEqual({ functions_enabled: true, validators: { t: { c: { function: "v" } } }, hooks: { t: { beforeChange: { function: "h" } } } })
  })

  it("says nothing changed when every map is already there", () => {
    const manifest: Record<string, unknown> = { hooks: { t: { beforeChange: { function: "h" } } } }
    expect(applyManifestMaps(manifest, { hooks: { t: { beforeChange: { function: "h" } } }, validators: {} })).toBe(false)
  })
})

describe("the hook deploy contract", () => {
  it("flattens a handler's adapter import and puts it back", () => {
    const source = 'import { hook } from "../_supatype/hooks.ts"\nexport default hook(() => ({}))\n'
    expect(flattenHookSource(source)).toContain('from "./_supatype-hooks.ts"')
    expect(unflattenHookSource(flattenHookSource(source))).toBe(source)
  })

  it("reads a body, and maps whose entries name their function", () => {
    expect(isHookDeployBody({ handlers: [{ name: "h", source: "x" }], map: {} })).toBe(true)
    expect(isHookDeployBody({ handlers: [{ name: "h" }] })).toBe(false)
    expect(isHookMap({ t: { beforeChange: { function: "h", onUnavailable: "reject" } } })).toBe(true)
    expect(isHookMap({ t: { beforeChange: { timeout: 5 } } })).toBe(false)
    expect(isCacheMap({ t: { maxTtl: "60" } })).toBe(false)
  })
})

/** Per-hook deploys: the body names hooks to keep, and the answer says which were kept or locked. */
describe("the per-hook deploy contract", () => {
  it("takes keep in the body, and refuses a keep that is not a list of names", () => {
    expect(isHookDeployBody({ handlers: [], map: {}, keep: ["a", "b"] })).toBe(true)
    expect(isHookDeployBody({ handlers: [], map: {}, keep: "a" })).toBe(false)
    expect(isHookDeployBody({ handlers: [], map: {}, keep: [1] })).toBe(false)
  })

  it("reads an answer with refused, kept and locked, and refuses one of the wrong shape", () => {
    expect(isHookDeployAnswer({ handlers: ["a"], tables: ["t"] })).toBe(true)
    expect(isHookDeployAnswer({ handlers: [], tables: [], refused: [{ name: "b", reason: "link" }], kept: ["b"], locked: ["c"], restarted: true })).toBe(true)
    expect(isHookDeployAnswer({ handlers: [], tables: [], refused: [{ name: "b" }] })).toBe(false)
    expect(isHookDeployAnswer({ tables: [] })).toBe(false)
  })
})
