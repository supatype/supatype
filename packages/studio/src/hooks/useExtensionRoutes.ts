import { createContext, useContext } from "react"

/**
 * The paths a host's extension serves (`StudioExtension.routes`), without a leading slash.
 *
 * Core Studio marks a page it has not built as coming soon, on every host. A host that builds that
 * page itself (Cloud's backups, say) registers a route at the same path, and its route wins over the
 * placeholder (StudioCore registers extension routes first). The nav reads this to stop calling a
 * page coming soon on a host that serves it: the extension opts in by serving the path, and a host
 * that does not inherits nothing.
 */
export const ExtensionRoutesContext = createContext<ReadonlySet<string>>(new Set())

/** `href` without its leading slash, the form a route path takes. */
export function routePathOf(href: string): string {
  return href.replace(/^\/+/, "")
}

/** Whether the host's extension serves the page at `href`. */
export function useExtensionServes(): (href: string) => boolean {
  const served = useContext(ExtensionRoutesContext)
  return (href) => served.has(routePathOf(href))
}
