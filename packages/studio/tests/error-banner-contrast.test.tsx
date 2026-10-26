import { readFileSync } from "node:fs"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ErrorBanner } from "../src/components/ErrorBanner.js"

/**
 * Fresh-test cosmetic: refusal banners were dark red text (`--destructive`, 30.6% lightness) on the
 * dark page, about 2:1. The banner's text now uses `--destructive-text`, a token a theme sets for
 * text on its own background, and the dark theme's value reads at WCAG AA (4.5:1) or better.
 */

const CSS = readFileSync(new URL("../src/globals.css", import.meta.url), "utf8")

/** An `h s% l%` token from the stylesheet's root block. */
function token(name: string): [number, number, number] {
  const match = new RegExp(String.raw`--${name}:\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%`).exec(CSS)
  if (match === null) throw new Error(`no --${name} token`)
  return [Number(match[1]), Number(match[2]) / 100, Number(match[3]) / 100]
}

function luminance([h, s, l]: [number, number, number]): number {
  const k = (n: number): number => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const channel = (n: number): number => {
    const c = l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(0) + 0.7152 * channel(8) + 0.0722 * channel(4)
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05)
}

describe("the error banner", () => {
  it("writes its message in the token meant for text", () => {
    const html = renderToStaticMarkup(<ErrorBanner message="Refused" onRetry={() => {}} />)
    expect(html).toMatch(/data-ui="error-banner-message" class="[^"]*text-destructive-text/)
    expect(html).not.toMatch(/text-destructive(?![-\w/])/)
  })

  it("has a text token that reads at AA on the page background", () => {
    expect(contrast(token("destructive-text"), token("background"))).toBeGreaterThanOrEqual(4.5)
  })
})
