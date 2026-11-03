import { describe, it, expect } from "vitest"
import { generateKeyPairSync, randomBytes } from "node:crypto"
import { verifyMinisign } from "../src/binary-cache.js"
import { makeMinisign } from "./support/minisign.js"

describe("verifyMinisign", () => {
  const data = Buffer.from("the quick brown fox\n")

  it("accepts a valid legacy ('Ed') signature", () => {
    const keyId = randomBytes(8)
    const { publicKey, privateKey } = generateKeyPairSync("ed25519")
    const { pubKeyStr, sigFile } = makeMinisign(data, "legacy", { keyId, privateKey, publicKey })
    expect(() => verifyMinisign(data, sigFile, pubKeyStr)).not.toThrow()
  })

  it("accepts a valid prehashed ('ED', BLAKE2b-512) signature", () => {
    const keyId = randomBytes(8)
    const { publicKey, privateKey } = generateKeyPairSync("ed25519")
    const { pubKeyStr, sigFile } = makeMinisign(data, "prehashed", { keyId, privateKey, publicKey })
    expect(() => verifyMinisign(data, sigFile, pubKeyStr)).not.toThrow()
  })

  it("rejects a prehashed signature when the file was tampered", () => {
    const { pubKeyStr, sigFile } = makeMinisign(data, "prehashed")
    const tampered = Buffer.from("the quick brown dog\n")
    expect(() => verifyMinisign(tampered, sigFile, pubKeyStr)).toThrow(/verification FAILED/i)
  })

  it("rejects when the signature key id does not match the public key", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519")
    const { sigFile } = makeMinisign(data, "prehashed", {
      keyId: randomBytes(8),
      privateKey,
      publicKey,
    })
    // Public key advertising a different key id.
    const { pubKeyStr } = makeMinisign(data, "prehashed", {
      keyId: randomBytes(8),
      privateKey,
      publicKey,
    })
    expect(() => verifyMinisign(data, sigFile, pubKeyStr)).toThrow(/key ID mismatch/i)
  })

  it("rejects an unsupported algorithm", () => {
    const { pubKeyStr, sigFile } = makeMinisign(data, "legacy")
    // Corrupt the algorithm bytes in the signature payload to "XX".
    const lines = sigFile.split("\n")
    const sigBytes = Buffer.from(lines[1]!, "base64")
    sigBytes[0] = 0x58
    sigBytes[1] = 0x58
    lines[1] = sigBytes.toString("base64")
    expect(() => verifyMinisign(data, lines.join("\n"), pubKeyStr)).toThrow(
      /Unsupported minisign algorithm/i,
    )
  })
})
