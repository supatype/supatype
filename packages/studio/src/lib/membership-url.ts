/** Where the client sits, and whether this is a cloud deployment. */
function stripProxy(clientUrl: string): { base: string; cloud: boolean } {
  const trimmed = clientUrl.replace(/\/$/, "")

  const selfHostProxy = "/studio/proxy"
  if (trimmed.endsWith(selfHostProxy)) {
    return { base: trimmed.slice(0, -selfHostProxy.length), cloud: false }
  }
  // Cloud already scopes the project in the path and exposes its routes as siblings of its proxy.
  if (trimmed.endsWith("/proxy")) {
    return { base: trimmed.slice(0, -"/proxy".length), cloud: true }
  }
  return { base: trimmed, cloud: false }
}

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
  const { base, cloud } = stripProxy(clientUrl)
  return cloud ? base : `${base}/admin`
}

/**
 * The origin this deployment serves the project's own app from, when there is one.
 *
 * With `app.mode` set to `static` or `proxy`, self-host serves the project's app at `/` on the same
 * origin as the API. That makes the origin a deployment fact rather than something a project should
 * have to write down: repeating it in config is retyping what Studio was handed, and it goes stale
 * the moment the deployment moves.
 *
 * **Undefined for cloud, and that is the point.** Cloud hosts the API and Studio; the project's app
 * is somewhere else entirely, and guessing at the cloud origin would produce a preview link that
 * looks right and opens nothing. A project on cloud states an absolute URL, and this says so by
 * having no answer rather than a wrong one.
 */
export function appOrigin(clientUrl: string): string | undefined {
  const { base, cloud } = stripProxy(clientUrl)
  return cloud ? undefined : base
}
