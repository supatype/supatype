declare module "posthog-js" {
  interface PostHog {
    init(token: string, config?: Record<string, unknown>): void
    capture(event: string, properties?: Record<string, unknown>): void
    identify(userId: string, properties?: Record<string, unknown>): void
    opt_in_capturing(): void
    opt_out_capturing(): void
  }
  const posthog: PostHog
  export default posthog
}
