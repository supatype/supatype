"use client"

import React, { useEffect, useRef, useState } from "react"
import { CAPTCHA_SCRIPTS, type CaptchaProvider, type CaptchaSettings } from "../lib/captcha.js"

/** The part of a provider's script Studio uses: both hCaptcha and Turnstile have this shape. */
interface CaptchaApi {
  render(host: HTMLElement, options: CaptchaRenderOptions): string
  remove(widgetId: string): void
}

interface CaptchaRenderOptions {
  sitekey: string
  callback(token: string): void
  "expired-callback"(): void
  "error-callback"(): void
}

declare global {
  interface Window {
    hcaptcha?: CaptchaApi
    turnstile?: CaptchaApi
  }
}

function apiFor(provider: CaptchaProvider): CaptchaApi | undefined {
  return provider === "hcaptcha" ? window.hcaptcha : window.turnstile
}

/** The provider's script tag: the page's own when it already has one, else a new one in the head. */
function scriptFor(provider: CaptchaProvider): HTMLScriptElement {
  const existing = document.head.querySelector<HTMLScriptElement>(`script[data-captcha="${provider}"]`)
  if (existing !== null) return existing
  const script = document.createElement("script")
  script.src = CAPTCHA_SCRIPTS[provider]
  script.async = true
  script.defer = true
  script.dataset["captcha"] = provider
  document.head.appendChild(script)
  return script
}

export interface CaptchaWidgetProps {
  captcha: CaptchaSettings
  /** Draw a fresh widget when this changes: a captcha answer is good for one request. */
  round: number
  /** The widget's answer, or null once it has expired or failed. Must be stable between renders. */
  onToken(token: string | null): void
}

/** The project's captcha widget, drawn by the provider's own script into a box of its own. */
export function CaptchaWidget({ captcha, round, onToken }: CaptchaWidgetProps): React.ReactElement {
  const host = useRef<HTMLDivElement>(null)
  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    const box = host.current
    if (box === null) return
    const { provider, siteKey } = captcha
    let widgetId: string | undefined
    const draw = (): void => {
      const api = apiFor(provider)
      if (api === undefined || widgetId !== undefined) return
      widgetId = api.render(box, {
        sitekey: siteKey,
        callback: (token) => onToken(token),
        "expired-callback": () => onToken(null),
        "error-callback": () => onToken(null),
      })
    }
    const failed = (): void => setLoadFailed(true)

    // The provider's script is only fetched when the page does not have it, and the widget is drawn
    // once it is there.
    let detach = (): void => {}
    if (apiFor(provider) === undefined) {
      const script = scriptFor(provider)
      script.addEventListener("load", draw)
      script.addEventListener("error", failed)
      detach = () => {
        script.removeEventListener("load", draw)
        script.removeEventListener("error", failed)
      }
    }
    draw()
    return () => {
      detach()
      if (widgetId !== undefined) apiFor(provider)?.remove(widgetId)
    }
  }, [captcha, round, onToken])

  return (
    <div className="space-y-2">
      <div ref={host} className="flex justify-center" />
      {loadFailed && (
        <p className="text-center text-xs text-destructive-text" role="alert">
          The captcha could not be loaded, so sign-in is not possible. Check the network and reload.
        </p>
      )}
    </div>
  )
}
