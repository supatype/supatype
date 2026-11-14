/**
 * Arguments for the Vite dev server `supatype dev` starts in proxy mode.
 *
 * 0.9.1 release test (FF21): Vite on its default host listens wherever Node resolves `localhost`,
 * which is [::1] on Windows, while the proxy dials the upstream's 127.0.0.1 (the Docker gateway
 * reaches only the host's IPv4 loopback, as host.docker.internal). The App URL answered 502, or
 * served another project's app holding 127.0.0.1 on the same port. Binding Vite to the upstream's
 * own address and port, with strictPort, puts it where the proxy looks or fails it loudly.
 *
 * That holds where Docker Desktop runs (macOS, Windows), which forwards host.docker.internal to the
 * host's loopback. Docker Engine on Linux maps the name to the docker0 bridge address instead, where
 * a Vite bound to 127.0.0.1 is not listening, so the App URL answered 502 on 0.9.2 (reported by a
 * tester on Linux). On Linux Vite listens on every interface, which covers the loopback and the bridge.
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

/**
 * The address Vite should bind for an upstream on this machine's loopback, or undefined for any
 * other upstream. Every interface on Linux, for the reason in this file's header.
 */
function loopbackHost(hostname: string, platform: NodeJS.Platform): string | undefined {
  const ipv4 = hostname === "localhost" || hostname === "127.0.0.1"
  if (!ipv4 && hostname !== "[::1]") return undefined
  if (platform === "linux") return ipv4 ? "0.0.0.0" : "::"
  return ipv4 ? "127.0.0.1" : "::1"
}

/** The upstream URL, or undefined when it is unset or does not parse. */
function parseUpstream(upstream: string | undefined): URL | undefined {
  try {
    return new URL(upstream?.trim() ?? "")
  } catch {
    return undefined
  }
}

/**
 * Set on the app `supatype dev` starts: the address it should listen on. dev passes it to Vite as
 * `--host` when it runs Vite itself. Any other start script, or a framework other than Vite, can read
 * it instead, as the `vite.config.ts` init writes does.
 */
export const DEV_APP_HOST_ENV = "SUPATYPE_DEV_APP_HOST"

/** The address the app should listen on for this upstream, or undefined when it is not a loopback. */
export function devAppHost(upstream: string | undefined, platform: NodeJS.Platform): string | undefined {
  const url = parseUpstream(upstream)
  return url ? loopbackHost(url.hostname, platform) : undefined
}

/** True when the script already sets `flag`, as `--flag value` or `--flag=value`. */
function setsFlag(args: readonly string[], flag: string): boolean {
  return args.some((arg) => arg === flag || arg.startsWith(`${flag}=`))
}

/**
 * The flags that bind Vite to the upstream's address and port, leaving out any the script already
 * sets. None for a command that is not a server (`vite build`) or an upstream that does not parse.
 */
export function viteUpstreamFlags(
  scriptArgs: readonly string[],
  upstream: string | undefined,
  platform: NodeJS.Platform,
): string[] {
  const command = scriptArgs[0]
  if (command !== undefined && !command.startsWith("-") && !SERVER_COMMANDS.has(command)) return []
  const url = parseUpstream(upstream)
  if (!url) return []
  const host = loopbackHost(url.hostname, platform)
  const flags: string[] = []
  if (host !== undefined && !setsFlag(scriptArgs, "--host")) flags.push("--host", host)
  if (url.port !== "" && !setsFlag(scriptArgs, "--port")) flags.push("--port", url.port)
  if (url.port !== "" && !setsFlag(scriptArgs, "--strictPort")) flags.push("--strictPort")
  return flags
}
