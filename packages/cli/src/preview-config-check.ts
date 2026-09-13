import type { SupatypeProjectConfig } from "./project-config.js"

/**
 * Preview addresses that can never resolve, named before a push writes them.
 *
 * A preview address may be a path when this deployment serves the project's app: `app.mode` of
 * `static` or `proxy` puts the app at `/` on the same origin as the API, and Studio resolves the
 * path against the origin it is loaded from. That is the point of allowing a path at all, because
 * the origin is a deployment fact and repeating it in config only lets it go stale.
 *
 * With `app.mode: "none"` nothing is served at `/`. A path then resolves against an origin that
 * answers 404, so the share control hands somebody a link that looks right and opens nothing. The
 * failure surfaces to whoever was sent the link rather than to whoever configured it, which is the
 * worst place for it to land, so it is refused here instead.
 *
 * Returns the models at fault, so a caller can name all of them in one message rather than making
 * an operator fix them one push at a time.
 */
export function modelsWithUnresolvablePreview(config: SupatypeProjectConfig): string[] {
  if (config.app.mode !== "none") return []

  const livePreview = config.admin?.livePreview
  if (livePreview === undefined) return []

  return Object.entries(livePreview)
    .filter(([, entry]) => {
      const address =
        entry.urlPattern !== undefined && entry.urlPattern !== "" ? entry.urlPattern : entry.url
      // Nothing stated at all is not this check's business: Studio asks for the setting, and a
      // project that has not configured previews for a model is not misconfigured.
      if (address === undefined || address === "") return false
      return !namesAnOrigin(address)
    })
    .map(([model]) => model)
    .sort()
}

/** True when the address carries its own origin and needs nothing added to it. */
function namesAnOrigin(address: string): boolean {
  // Protocol-relative counts: `//example.com/x` already names a host.
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(address) || address.startsWith("//")
}

/** The refusal headline. The two ways out are hints, in the caller, as every other refusal does. */
export function unresolvablePreviewMessage(models: string[]): string {
  const plural = models.length > 1
  return (
    `admin.livePreview gives a path for ${models.join(", ")}, but app.mode is "none", ` +
    `so this deployment serves nothing at / for ${plural ? "those paths" : "that path"} ` +
    `to resolve against.`
  )
}
