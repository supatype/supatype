import { randomUUID } from "node:crypto"

/**
 * A file-name fragment that no other call produces, in this process or any other.
 *
 * For files written into a directory every CLI process shares (the system temp directory, the
 * CLI's own source directory). A timestamp alone repeats across processes started in the same
 * millisecond, and two such processes then read and run each other's files: one project's config,
 * or one command's engine request, under another's name.
 */
export function uniqueFileToken(): string {
  return `${Date.now()}-${process.pid}-${randomUUID()}`
}
