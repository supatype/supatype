/**
 * Ambient types for IDE / tsserver (runtime is Deno in Docker).
 * Kept in sync with `@supatype/cli` edge-function ambient (`packages/cli/deno.d.ts`).
 */

interface DenoEnv {
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
  function stat(path: string): Promise<FileInfo>
  function readTextFile(path: string): Promise<string>

  function serve(
    options: { port: number; hostname?: string; onListen?: (params: { hostname: string; port: number }) => void },
    handler: (req: Request) => Response | Promise<Response>,
  ): void
}

/**
 * The slice of Node's `async_hooks` the worker uses. Deno provides the module at runtime; tsc has no
 * `@types/node` here, and without this the import resolved to nothing and `store` was untyped.
 */
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined
    run<R>(store: T, callback: () => R): R
  }
}
