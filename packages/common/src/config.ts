export type AppEnvironment = "development" | "staging" | "production"

function detectEnvironment(): AppEnvironment {
  if (typeof window === "undefined") return "production"
  const host = window.location.hostname
  if (host === "localhost" || host === "127.0.0.1") return "development"
  if (host.includes("staging")) return "staging"
  return "production"
}

function getEnvVar(name: string, fallback: string): string {
  // Vite-style env vars
  if (typeof import.meta !== "undefined") {
    const env = (import.meta as unknown as { env?: Record<string, string> }).env
    if (env?.[name]) return env[name]
  }
  return fallback
}

export const config = {
  environment: detectEnvironment(),
  platformUrl: getEnvVar("PUBLIC_SUPATYPE_PLATFORM_URL", "https://api.supatype.com"),
  platformAnonKey: getEnvVar("PUBLIC_SUPATYPE_PLATFORM_ANON_KEY", ""),
  posthogKey: getEnvVar("PUBLIC_POSTHOG_KEY", ""),
  posthogHost: getEnvVar("PUBLIC_POSTHOG_HOST", "https://eu.posthog.com"),
}
