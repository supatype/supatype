import { NextResponse, type NextRequest } from "next/server"

const LOCALES = ["en", "fr"] as const
const DEFAULT_LOCALE = "en"

/**
 * Pick the reader's locale on the edge, before anything renders.
 *
 * The schema declares `LocaleConfig<["en","fr"], "en">`, and a `Localized` column holds every
 * locale at once. Something has to decide which one this request gets, and doing it here means the
 * choice is made once per request rather than in every component that reads a translated field.
 *
 * A cookie wins over the browser's header, because a reader who switched languages meant it.
 */
export function middleware(request: NextRequest): NextResponse {
  const fromCookie = request.cookies.get("locale")?.value
  const fromHeader = request.headers.get("accept-language")?.split(",")[0]?.slice(0, 2)

  const locale = [fromCookie, fromHeader].find(
    (candidate): candidate is (typeof LOCALES)[number] =>
      typeof candidate === "string" && (LOCALES as readonly string[]).includes(candidate),
  ) ?? DEFAULT_LOCALE

  const response = NextResponse.next()
  response.headers.set("x-locale", locale)
  if (fromCookie !== locale) response.cookies.set("locale", locale, { path: "/" })
  return response
}

export const config = {
  // Everything but Next's own assets: the locale decision belongs to pages and route handlers.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
}
