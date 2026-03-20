/**
 * Platform detection for engine binary downloads.
 * Maps Node.js platform/arch to the binary naming convention.
 */

export interface PlatformInfo {
  os: "linux" | "darwin" | "win"
  arch: "x64" | "arm64"
  binaryName: string
  ext: string
}

const PLATFORM_MAP: Record<string, { os: PlatformInfo["os"]; arch: PlatformInfo["arch"] }> = {
  "darwin-arm64": { os: "darwin", arch: "arm64" },
  "darwin-x64": { os: "darwin", arch: "x64" },
  "linux-arm64": { os: "linux", arch: "arm64" },
  "linux-x64": { os: "linux", arch: "x64" },
  "win32-x64": { os: "win", arch: "x64" },
}

const SUPPORTED_PLATFORMS = [
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
  "win-x64",
]

/**
 * Detect the current platform and return the binary info.
 * Throws on unsupported platforms with a helpful message.
 */
export function detectPlatform(): PlatformInfo {
  const key = `${process.platform}-${process.arch}`
  const mapped = PLATFORM_MAP[key]

  if (!mapped) {
    throw new Error(
      `Supatype engine is not available for ${process.platform}-${process.arch}.\n` +
      `Supported platforms: ${SUPPORTED_PLATFORMS.join(", ")}`,
    )
  }

  const ext = mapped.os === "win" ? ".exe" : ""

  return {
    os: mapped.os,
    arch: mapped.arch,
    binaryName: `supatype-engine${ext}`,
    ext,
  }
}

/**
 * Build the artifact filename for a given version and platform.
 */
export function getArtifactName(version: string, platform: PlatformInfo): string {
  return `supatype-engine-${version}-${platform.os}-${platform.arch}${platform.ext}`
}

/**
 * Build the CDN download URL for a given version and artifact.
 */
export function getCdnUrl(baseUrl: string, version: string, filename: string): string {
  return `${baseUrl}/v${version}/${filename}`
}
