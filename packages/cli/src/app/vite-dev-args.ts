/**
 * Arguments for the Vite dev server `supatype dev` starts in proxy mode.
 *
 * 0.9.1 release test (FF21): Vite on its default host listens wherever Node resolves `localhost`,
 * which is [::1] on Windows, while the proxy dials the upstream's 127.0.0.1 (the Docker gateway
 * reaches only the host's IPv4 loopback, as host.docker.internal). The App URL answered 502, or
 * served another project's app holding 127.0.0.1 on the same port. Binding Vite to the upstream's
 * own address and port, with strictPort, puts it where the proxy looks or fails it loudly.
 */

/** Characters that mean a script needs a shell: chaining, pipes, redirects, quoting, variables. */
const SHELL_SYNTAX = /[&|;<>()$`"'\\*?{}]/

/** Vite commands that run a server and take --host, --port and --strictPort. */
const SERVER_COMMANDS = new Set(["dev", "serve", "preview"])

/**
 * The arguments a package.json script passes to Vite, or null when the script is not a plain Vite
 * command line: one that needs a shell is left to the package manager, which runs it whole.
 */
export function viteScriptArgs(body: string): string[] | null {
  if (SHELL_SYNTAX.test(body)) return null
  const tokens = body.trim().split(/\s+/)
  if (tokens[0] === "vite" || tokens[0]?.includes("vite/bin/vite")) return tokens.slice(1)
  if (tokens[0] === "node" && tokens[1]?.includes("vite/bin/vite")) return tokens.slice(2)
  return null
}

/** The address Vite should bind for an upstream on this machine's loopback; undefined otherwise. */
function loopbackHost(hostname: string): string | undefined {
  if (hostname === "localhost" || hostname === "127.0.0.1") return "127.0.0.1"
  if (hostname === "[::1]") return "::1"
  return undefined
}

/** True when the script already sets `flag`, as `--flag value` or `--flag=value`. */
function setsFlag(args: readonly string[], flag: string): boolean {
  return args.some((arg) => arg === flag || arg.startsWith(`${flag}=`))
}

/**
 * The flags that bind Vite to the upstream's address and port, leaving out any the script already
 * sets. None for a command that is not a server (`vite build`) or an upstream that does not parse.
 */
export function viteUpstreamFlags(scriptArgs: readonly string[], upstream: string | undefined): string[] {
  const command = scriptArgs[0]
  if (command !== undefined && !command.startsWith("-") && !SERVER_COMMANDS.has(command)) return []
  let url: URL
  try {
    url = new URL(upstream?.trim() ?? "")
  } catch {
    return []
  }
  const host = loopbackHost(url.hostname)
  const flags: string[] = []
  if (host !== undefined && !setsFlag(scriptArgs, "--host")) flags.push("--host", host)
  if (url.port !== "" && !setsFlag(scriptArgs, "--port")) flags.push("--port", url.port)
  if (url.port !== "" && !setsFlag(scriptArgs, "--strictPort")) flags.push("--strictPort")
  return flags
}
