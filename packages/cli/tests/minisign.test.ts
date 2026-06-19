import { describe, it, expect } from "vitest"
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign as edSign,
  type KeyObject,
} from "node:crypto"
import { verifyMinisign } from "../src/binary-cache.js"

/**
 * Build a minisign public-key string + signature file for the given mode so we
 * can exercise {@link verifyMinisign} without shelling out to the minisign tool.
 *
 * Layout mirrors the minisign format the verifier parses:
 *   public key payload: [2 algo]["Ed"][8 keyId][32 raw ed25519 pubkey]
 *   signature payload : [2 algo][8 keyId][64 ed25519 signature]
 */
function makeMinisign(
  data: Buffer,
  mode: "legacy" | "prehashed",
  opts: { keyId?: Buffer; privateKey?: KeyObject; publicKey?: KeyObject } = {},
): { pubKeyStr: string; sigFile: string } {
  const { publicKey, privateKey } =
    opts.privateKey && opts.publicKey
      ? { publicKey: opts.publicKey, privateKey: opts.privateKey }
      : generateKeyPairSync("ed25519")

  const keyId = opts.keyId ?? randomBytes(8)

  // Raw 32-byte ed25519 key = SPKI DER minus its 12-byte prefix.
  const rawPub = publicKey.export({ format: "der", type: "spki" }).subarray(12)
  const pkPayload = Buffer.concat([Buffer.from("Ed"), keyId, rawPub])
  const pubKeyStr = `untrusted comment: test\n${pkPayload.toString("base64")}`

  const prehashed = mode === "prehashed"
  const signedData = prehashed
    ? createHash("blake2b512").update(data).digest()
    : data
  const signature = edSign(null, signedData, privateKey)

  const algo = prehashed ? Buffer.from("ED") : Buffer.from("Ed")
  const sigPayload = Buffer.concat([algo, keyId, signature])
  const sigFile =
    `untrusted comment: signature\n${sigPayload.toString("base64")}\n` +
    `trusted comment: timestamp\n${Buffer.alloc(64).toString("base64")}`

  return { pubKeyStr, sigFile }
}

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
