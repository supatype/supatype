import { createHash, generateKeyPairSync, randomBytes, sign as edSign, type KeyObject } from "node:crypto"

export interface MinisignKeys {
  keyId?: Buffer
  privateKey?: KeyObject
  publicKey?: KeyObject
}

/**
 * Build a minisign public-key string + signature file for the given mode, so a test can sign a
 * manifest without shelling out to the minisign tool.
 *
 * Layout mirrors the minisign format the verifier parses:
 *   public key payload: [2 algo]["Ed"][8 keyId][32 raw ed25519 pubkey]
 *   signature payload : [2 algo][8 keyId][64 ed25519 signature]
 */
export function makeMinisign(
  data: Buffer,
  mode: "legacy" | "prehashed",
  opts: MinisignKeys = {},
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
