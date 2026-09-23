import type { AugmentedDatabase } from "@supatype/client"
import { useAuth, useQuery } from "@supatype/react"

type ProfileRow = AugmentedDatabase["public"]["Tables"]["profile"]["Row"]

export function defaultDisplayName(email: string | undefined): string {
  return email?.split("@")[0] ?? "Expo user"
}

/** Signed-in user's profile row + a display name fallback for chat / forms. */
export function useProfileDisplayName(): {
  profile: ProfileRow | null
  displayName: string
  userId: string | undefined
  loading: boolean
  initialLoading: boolean
  error: Error | null
  refetch: () => void
} {
  const { user } = useAuth()
  const userId = user?.id

  const { data: rows, loading, error, refetch } = useQuery<
    AugmentedDatabase,
    "profile",
    ProfileRow
  >("profile", {
    filter: userId !== undefined ? { id: userId } : undefined,
    limit: 1,
    enabled: userId !== undefined,
  })

  const profile = rows?.[0] ?? null
  const trimmed = profile?.displayName?.trim()
  const displayName =
    trimmed !== undefined && trimmed !== "" ? trimmed : defaultDisplayName(user?.email)

  return {
    profile,
    displayName,
    userId,
    loading,
    initialLoading: loading && rows === null,
    error: error !== null ? new Error(error.message) : null,
    refetch,
  }
}
