/**
 * 0.9.2 release test (N-S14): an Expo web export with no values threw `MissingClientValuesError`
 * telling the developer to add the script tag to `index.html`, which an Expo Router app does not
 * have. Its page comes from `app/+html.tsx`, so that is the file the error names. The client tells
 * an Expo page by `globalThis.expo`, which Expo's runtime sets on the web as on a phone; the CLI's
 * `EXPO_PUBLIC_` names are read by the app's own code, which the client never sees.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { createClient, MissingClientValuesError } from "../src/index.js"

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A page with no `/supatype-env.js` script and no `__SUPATYPE_ENV__`, Expo's when `expo` is set. */
function page(expo: boolean): void {
  vi.stubGlobal("window", globalThis)
  vi.stubGlobal("document", { scripts: [] })
  if (expo) vi.stubGlobal("expo", { modules: {} })
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("no request may be sent"))))
}

async function firstCallMessage(): Promise<string> {
  try {
    await createClient({}).from("posts").select()
  } catch (err) {
    if (err instanceof MissingClientValuesError) return err.message
    throw err
  }
  throw new Error("expected the first call to fail")
}

describe("the missing-values error in an Expo app", () => {
  it("names app/+html.tsx, not index.html", async () => {
    page(true)
    const message = await firstCallMessage()
    expect(message).toContain("app/+html.tsx")
    expect(message).toContain('<script src="/supatype-env.js" />')
    expect(message).not.toContain("index.html")
    expect(message).not.toContain("vite-ignore")
  })

  it("says a native build takes the values at build time, under Expo's names", async () => {
    page(true)
    const message = await firstCallMessage()
    expect(message).toContain("EXPO_PUBLIC_SUPATYPE_URL")
    expect(message).toContain("A native build has no page")
    expect(message).toContain("supatype build -- <your build command>")
  })

  it("still names index.html in a page that is not Expo's", async () => {
    page(false)
    const message = await firstCallMessage()
    expect(message).toContain('add <script src="/supatype-env.js" vite-ignore></script> to index.html')
    expect(message).not.toContain("+html.tsx")
  })
})
