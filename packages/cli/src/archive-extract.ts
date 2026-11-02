/**
 * Unpack a downloaded release archive (a .zip on Windows, a .tar.gz elsewhere) into a directory.
 *
 * On Windows, Git Bash's tar is usually first on PATH and reads a drive letter (`C:\...`) as a
 * remote host, so a .zip is expanded with PowerShell's Expand-Archive, which takes Windows paths
 * as they are.
 */
import { spawnSync } from "node:child_process"
import { mkdirSync } from "node:fs"

/** Unpacks `archivePath` into `destDir`, creating it; throws, naming the archive, when that fails. */
export function extractArchive(archivePath: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true })
  const result = archivePath.endsWith(".zip")
    ? spawnSync(
        "powershell.exe",
        ["-NoProfile", "-Command", `Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force`],
        { stdio: "inherit" },
      )
    : spawnSync("tar", ["-xzf", archivePath, "-C", destDir], { stdio: "inherit" })
  if (result.status !== 0) throw new Error(`Failed to extract ${archivePath}`)
}
