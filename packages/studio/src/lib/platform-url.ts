/**
 * Where Studio reaches the project's control plane, in each deployment mode.
 *
 * Cloud hands Studio its control plane's URL (`platformUrl`) and the project ref, and the platform
 * session travels as a cookie. Self-host reaches its control plane through the Studio proxy, at
 * `/platform/v1` beside the data plane, with the Studio session in the `Authorization` header like
 * every other proxied call, and asks it once which project it serves.
 */

/** The self-host control plane's base, given the admin client's URL (`.../studio/proxy`). */
export function selfHostPlatformBase(clientUrl: string): string {
  return `${clientUrl.replace(/\/$/, "")}/platform/v1`
}

/** A project-scoped control-plane URL, from either mode's base. */
export function projectPlatformUrl(base: string, projectRef: string, path: string): string {
  const tail = path.startsWith("/") ? path : `/${path}`
  return `${base.replace(/\/$/, "")}/projects/${encodeURIComponent(projectRef)}${tail}`
}
