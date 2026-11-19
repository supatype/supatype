import { strict as assert } from "node:assert"
import { describe, test } from "node:test"
import { setManifestKey } from "../src/manifest.js"

/** The one write a route makes to the stack's manifest: set a key to a map, or take it out when the map is empty. */
describe("setManifestKey", () => {
  test("sets the key and says the manifest changed", () => {
    const manifest: Record<string, unknown> = { a: 1 }
    assert.equal(setManifestKey(manifest, "public_env", { X: "1" }), true)
    assert.deepEqual(manifest, { a: 1, public_env: { X: "1" } })
  })

  test("says nothing changed when the key already holds the same map", () => {
    const manifest: Record<string, unknown> = { public_env: { X: "1" } }
    assert.equal(setManifestKey(manifest, "public_env", { X: "1" }), false)
  })

  test("takes the key out for an empty map", () => {
    const manifest: Record<string, unknown> = { a: 1, public_env: { X: "1" } }
    assert.equal(setManifestKey(manifest, "public_env", {}), true)
    assert.deepEqual(manifest, { a: 1 })
  })

  test("says nothing changed for an empty map and no key", () => {
    const manifest: Record<string, unknown> = { a: 1 }
    assert.equal(setManifestKey(manifest, "public_env", {}), false)
    assert.deepEqual(manifest, { a: 1 })
  })
})
