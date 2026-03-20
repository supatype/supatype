/**
 * Checksum and signature verification for engine binaries.
 *
 * Two-step verification:
 * 1. Verify minisign signature on checksums.sha256 file
 * 2. Verify SHA256 hash of binary against signed checksum file
 *
 * Both steps MUST pass before the CLI executes the binary.
 */

import { createHash } from "node:crypto"
import { readFile, unlink } from "node:fs/promises"

/**
 * Embedded minisign public key.
 *
 * This key is used to verify the signature on the checksum file.
 * It ensures the checksum file was produced by Supatype's CI,
 * not by an attacker who compromised the CDN.
 *
 * Generated with: minisign -G
 * The corresponding private key is stored as a GitHub Actions secret.
 *
 * TODO: Replace with actual public key once generated.
 */
export const MINISIGN_PUBLIC_KEY = "RWS0000000000000000000000000000000000000000000000000"

/**
 * Verify the minisign signature on a checksum file.
 *
 * Uses a pure-JS minisign verification (Ed25519).
 * Returns true if the signature is valid, false otherwise.
 */
export async function verifySignature(
  checksumPath: string,
  signaturePath: string,
  publicKey: string = MINISIGN_PUBLIC_KEY,
): Promise<boolean> {
  // Minisign signature format:
  // Line 1: untrusted comment
  // Line 2: base64-encoded signature
  // Line 3 (optional): trusted comment
  // Line 4 (optional): base64-encoded global signature

  try {
    const sigContent = await readFile(signaturePath, "utf8")
    const checksumContent = await readFile(checksumPath)

    const sigLines = sigContent.trim().split("\n")
    if (sigLines.length < 2) return false

    // Parse the signature (line 2 is the base64-encoded signature)
    const sigBase64 = sigLines[1]!.trim()
    const sigBytes = Buffer.from(sigBase64, "base64")

    // Minisign signature: 2 bytes algorithm + 8 bytes key ID + 64 bytes Ed25519 sig
    if (sigBytes.length < 74) return false

    const algorithm = sigBytes.subarray(0, 2)
    const keyId = sigBytes.subarray(2, 10)
    const signature = sigBytes.subarray(10, 74)

    // Parse public key
    const pkBytes = Buffer.from(publicKey.slice(2), "base64") // Skip "RW" prefix
    if (pkBytes.length < 42) return false

    // Public key: 2 bytes algorithm + 8 bytes key ID + 32 bytes Ed25519 pubkey
    const pkKeyId = pkBytes.subarray(2, 10)
    const pk = pkBytes.subarray(10, 42)

    // Verify key IDs match
    if (!keyId.equals(pkKeyId)) return false

    // Verify Ed25519 signature using Node.js crypto
    const { verify, createPublicKey } = await import("node:crypto")

    const publicKeyObj = createPublicKey({
      key: Buffer.concat([
        // Ed25519 public key DER prefix
        Buffer.from("302a300506032b6570032100", "hex"),
        pk,
      ]),
      format: "der",
      type: "spki",
    })

    const isValid = verify(null, checksumContent, publicKeyObj, signature)

    // If there's a trusted comment (line 3-4), verify the global signature too
    if (sigLines.length >= 4 && isValid) {
      const trustedComment = sigLines[2]?.replace(/^trusted comment: ?/, "") || ""
      const globalSigBase64 = sigLines[3]!.trim()
      const globalSig = Buffer.from(globalSigBase64, "base64")

      const globalMessage = Buffer.concat([signature, Buffer.from(trustedComment)])
      const globalValid = verify(null, globalMessage, publicKeyObj, globalSig)
      return globalValid
    }

    return isValid
  } catch {
    return false
  }
}

/**
 * Verify the SHA256 checksum of a binary against a signed checksum file.
 *
 * The checksum file format follows sha256sum output:
 * <hash>  <filename>
 */
export async function verifyChecksum(
  binaryPath: string,
  checksumPath: string,
  expectedFilename: string,
): Promise<boolean> {
  const checksumContent = await readFile(checksumPath, "utf8")

  // Find the line matching our filename
  const lines = checksumContent.trim().split("\n")
  let expectedHash: string | undefined

  for (const line of lines) {
    // Format: "<hash>  <filename>" (two spaces)
    const parts = line.trim().split(/\s+/)
    if (parts.length >= 2 && parts[1] === expectedFilename) {
      expectedHash = parts[0]!.toLowerCase()
      break
    }
  }

  if (!expectedHash) {
    throw new Error(
      `No checksum found for ${expectedFilename} in checksum file`,
    )
  }

  const binaryData = await readFile(binaryPath)
  const actualHash = createHash("sha256").update(binaryData).digest("hex")

  return actualHash === expectedHash
}

/**
 * Run the full two-step verification pipeline.
 * Deletes the binary if verification fails.
 *
 * Step 1: Verify minisign signature on checksums.sha256
 * Step 2: Verify SHA256 hash of binary against signed checksum
 */
export async function verifyBinary(
  binaryPath: string,
  checksumPath: string,
  signaturePath: string,
  artifactName: string,
): Promise<void> {
  // Step 1: Verify signature
  const sigValid = await verifySignature(checksumPath, signaturePath)
  if (!sigValid) {
    await safeDelete(binaryPath)
    throw new Error(
      "Engine checksum signature verification failed.\n" +
      "The checksum file may have been tampered with.\n" +
      "If this persists, report at https://github.com/supatype/supatype/issues",
    )
  }

  // Step 2: Verify checksum
  const checksumValid = await verifyChecksum(binaryPath, checksumPath, artifactName)
  if (!checksumValid) {
    await safeDelete(binaryPath)
    throw new Error(
      "Engine binary checksum mismatch.\n" +
      "This could indicate a corrupt download or a tampered binary.\n" +
      "Try again or report at https://github.com/supatype/supatype/issues",
    )
  }
}

/**
 * Simple checksum-only verification (no signature).
 * Used as a fallback when signature files are not available.
 */
export async function verifyChecksumOnly(
  binaryPath: string,
  checksumPath: string,
  artifactName: string,
): Promise<void> {
  const valid = await verifyChecksum(binaryPath, checksumPath, artifactName)
  if (!valid) {
    await safeDelete(binaryPath)
    throw new Error(
      "Engine binary checksum mismatch.\n" +
      "This could indicate a corrupt download or a tampered binary.\n" +
      "Try again or report at https://github.com/supatype/supatype/issues",
    )
  }
}

async function safeDelete(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch {
    // Ignore deletion errors
  }
}
