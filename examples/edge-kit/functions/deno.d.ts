/**
 * Supatype edge functions (IDE / tsserver).
 * Runtime is Deno; this file covers APIs edge functions commonly use.
 * Do not add `@types/deno` to the app package.json — it leaks into the
 * whole project when root tsconfig has no `"types"` field.
 *
 * Optional: for the full Deno API, install the Deno VS Code/Cursor extension
 * and open `functions/` as a Deno-enabled workspace folder.
 */
/* eslint-disable @typescript-eslint/no-unused-vars */

interface DenoEnv {
  /** Returns the value of the environment variable, or `undefined` if unset. */
  get(key: string): string | undefined
  set(key: string, value: string): void
  delete(key: string): void
  has(key: string): boolean
  toObject(): { [key: string]: string }
}

declare namespace Deno {
  const env: DenoEnv

  namespace errors {
    class NotFound extends Error {}
    class PermissionDenied extends Error {}
  }

  interface DirEntry {
    name: string
    isFile: boolean
    isDirectory: boolean
    isSymlink: boolean
  }

  interface FileInfo {
    isFile: boolean
    isDirectory: boolean
    isSymlink: boolean
    size: number
    mtime: Date | null
  }

  function readDir(path: string): AsyncIterable<DirEntry>
  function readTextFile(path: string): Promise<string>
  function stat(path: string): Promise<FileInfo>

  function serve(
    options: { port: number; hostname?: string; onListen?: (params: { hostname: string; port: number }) => void },
    handler: (req: Request) => Response | Promise<Response>,
  ): void
}
