import { resolve, sep } from "node:path"

/**
 * A host path as the generated compose file names it: absolute, with forward slashes.
 *
 * Absolute because compose resolves a relative bind source against `--project-directory`, and
 * without that flag against the compose file's own folder, `.supatype/self-host`. The CLI always
 * passes the flag. Someone running `docker compose -f .supatype/self-host/docker-compose.yml` by
 * hand does not, and the server came up with that folder as its project: no admin config, manifest,
 * API config, functions or hooks, and an empty `.supatype/self-host/.supatype` left on the host
 * (SA3). Every compose command renders the file again on this machine, so a project that moved is
 * named at its new place the next time one runs. Forward slashes because Docker Desktop on Windows
 * reads `C:/...` as a host path and YAML needs no escaping for them.
 */
export function composeHostPath(path: string): string {
  const absolute = resolve(path)
  return sep === "\\" ? absolute.replace(/\\/g, "/") : absolute
}
