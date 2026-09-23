import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js"

/** UTF-8 string → lowercase hex SHA-256 (browser + Node). */
export function sha256Hex(input: string): string {
  return bytesToHex(sha256(utf8ToBytes(input)))
}
