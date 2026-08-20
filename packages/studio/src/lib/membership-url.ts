/**
 * Where the Studio membership API lives, given the admin client's base URL.
 *
 * Self-host exposes the routes *beside* `/studio/proxy`, not inside it: the proxy
 * forwards to the data plane, and membership is not data-plane traffic, posting
 * through it would look for `/rest/v1/admin/studio-members`.
 *
 * Cloud already scopes the project in the path and exposes the routes as siblings
 * of its proxy.
 */
export function membershipBase(clientUrl: string): string {
  const trimmed = clientUrl.replace(/\/$/, "")

  const selfHostProxy = "/studio/proxy"
  if (trimmed.endsWith(selfHostProxy)) {
    return `${trimmed.slice(0, -selfHostProxy.length)}/admin`
  }
  if (trimmed.endsWith("/proxy")) {
    return trimmed.slice(0, -"/proxy".length)
  }
  return `${trimmed}/admin`
}
