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
  function utime(path: string, atime: Date | number, mtime: Date | number): Promise<void>
  function readTextFile(path: string | URL): Promise<string>

  /** What `serve` returns: stopping it (stop.ts) waits for the requests in flight. */
  interface HttpServer {
    /** Stops taking connections; resolves once the requests in flight have finished. */
    shutdown(): Promise<void>
    /** Resolves when the server has closed. */
    readonly finished: Promise<void>
  }

  function serve(
    options: { port: number; hostname?: string; onListen?: (params: { hostname: string; port: number }) => void },
    handler: (req: Request) => Response | Promise<Response>,
  ): HttpServer

  // What stop.ts uses to exit on a stop signal.
  const build: { readonly os: "darwin" | "linux" | "android" | "windows" | "freebsd" | "netbsd" | "aix" | "solaris" | "illumos" }
  function addSignalListener(signal: "SIGTERM" | "SIGINT", handler: () => void): void
  function exit(code?: number): never

  // What tests/ uses to start the worker as a child process and give it a functions directory.
  function test(name: string, fn: () => void | Promise<void>): void
  function execPath(): string
  function makeTempDir(options?: { prefix?: string }): Promise<string>
  function makeTempFile(options?: { prefix?: string; suffix?: string }): Promise<string>
  function mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
  function writeTextFile(path: string, data: string): Promise<void>
  function remove(path: string, options?: { recursive?: boolean }): Promise<void>

  interface CommandOptions {
    args?: string[]
    env?: Record<string, string>
    clearEnv?: boolean
    stdout?: "piped" | "inherit" | "null"
    stderr?: "piped" | "inherit" | "null"
  }

  interface ChildProcess {
    readonly stdout: ReadableStream<Uint8Array>
    readonly status: Promise<{ success: boolean; code: number }>
    kill(signal?: "SIGTERM" | "SIGKILL"): void
  }

  class Command {
    constructor(command: string, options?: CommandOptions)
    spawn(): ChildProcess
  }
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
