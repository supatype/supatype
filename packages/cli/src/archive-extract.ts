/**
 * Unpack a downloaded release archive (a .zip on Windows, a .tar.gz elsewhere) into a directory.
 *
 * A .zip is unpacked with Windows' own bsdtar, System32\tar.exe, named by its full path. Git Bash's
 * tar is usually first on PATH and reads a drive letter (`C:\...`) as a remote host, so the bare
 * name is never used for a zip. PowerShell's Expand-Archive is the fallback for a Windows without
 * tar.exe (before Windows 10 1803). On GitHub's Windows runners, whose temp folder is the 8.3 name
 * `RUNNER~1`, an Expand-Archive unpack left the executable missing with no error reported.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"

/** How an unpack runs a program: spawnSync, or a stand-in in tests. */
export type ArchiveSpawn = (command: string, args: string[]) => Pick<SpawnSyncReturns<Buffer>, "status" | "stderr">

const runPiped: ArchiveSpawn = (command, args) => spawnSync(command, args, { stdio: "pipe" })

/** Windows' bundled bsdtar, which reads a zip and takes Windows paths as they are. */
export function systemTar(env: NodeJS.ProcessEnv = process.env): string {
  return join(env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe")
}

/** The program and arguments that unpack `archivePath` into `destDir`. */
export function unpackCommand(
  archivePath: string,
  destDir: string,
  tarExists: (path: string) => boolean = existsSync,
): { command: string; args: string[] } {
  if (!archivePath.endsWith(".zip")) return { command: "tar", args: ["-xzf", archivePath, "-C", destDir] }
  const tar = systemTar()
  if (tarExists(tar)) return { command: tar, args: ["-xf", archivePath, "-C", destDir] }
  const script = `$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${destDir}' -Force`
  return { command: "powershell.exe", args: ["-NoProfile", "-Command", script] }
}

/** Unpacks `archivePath` into `destDir`, creating it; throws, naming the archive and the reason, when that fails. */
export function extractArchive(archivePath: string, destDir: string, spawn: ArchiveSpawn = runPiped): void {
  mkdirSync(destDir, { recursive: true })
  const { command, args } = unpackCommand(archivePath, destDir)
  const result = spawn(command, args)
  if (result.status !== 0) {
    const reason = result.stderr?.toString().trim()
    throw new Error(`Failed to extract ${archivePath}${reason ? `: ${reason}` : ""}`)
  }
}
