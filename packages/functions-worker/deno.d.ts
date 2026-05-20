/** Ambient types for IDE / tsserver (runtime is Deno in Docker). */

interface DenoEnv {
  get(key: string): string | undefined
  set(key: string, value: string): void
  delete(key: string): void
}

declare namespace Deno {
  const env: DenoEnv

  interface DirEntry {
    name: string
    isFile: boolean
    isDirectory: boolean
  }

  interface FileInfo {
    isFile: boolean
    isDirectory: boolean
  }

  function readDir(path: string): AsyncIterable<DirEntry>
  function stat(path: string): Promise<FileInfo>
  function readTextFile(path: string): Promise<string>

  function serve(
    options: { port: number },
    handler: (req: Request) => Response | Promise<Response>,
  ): void
}
