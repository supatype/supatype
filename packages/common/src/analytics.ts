import { config } from "./config.js"

interface AnalyticsClient {
  capture(event: string, properties?: Record<string, unknown>): void
  identify(userId: string, properties?: Record<string, unknown>): void
  pageView(path?: string): void
  optIn(): void
  optOut(): void
}

class PostHogAnalytics implements AnalyticsClient {
  private posthog: { capture: Function; identify: Function; opt_in_capturing: Function; opt_out_capturing: Function } | null = null
  private initialized = false

  private async init(): Promise<void> {
    if (this.initialized || typeof window === "undefined") return
    if (!config.posthogKey) return
    this.initialized = true

    try {
      const ph = await import("posthog-js")
      ph.default.init(config.posthogKey, {
        api_host: config.posthogHost,
        capture_pageview: false, // Manual page views
        persistence: "localStorage+cookie",
        respect_dnt: true,
      })
      this.posthog = ph.default as unknown as typeof this.posthog
    } catch {
      // PostHog not available — analytics disabled
    }
  }

  capture(event: string, properties?: Record<string, unknown>): void {
    this.init().then(() => this.posthog?.capture(event, properties)).catch(() => {})
  }

  identify(userId: string, properties?: Record<string, unknown>): void {
    this.init().then(() => this.posthog?.identify(userId, properties)).catch(() => {})
  }

  pageView(path?: string): void {
    this.capture("$pageview", { $current_url: path ?? window.location.href })
  }

  optIn(): void {
    this.init().then(() => this.posthog?.opt_in_capturing()).catch(() => {})
  }

  optOut(): void {
    this.init().then(() => this.posthog?.opt_out_capturing()).catch(() => {})
  }
}

export const analytics: AnalyticsClient = new PostHogAnalytics()
