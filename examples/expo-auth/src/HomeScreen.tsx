import React, { useCallback, useEffect, useRef, useState } from "react"
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native"
import type { AugmentedDatabase } from "@supatype/client"
import { useAuth, useSupatype } from "@supatype/react"
import { defaultDisplayName, type useProfileDisplayName } from "./useProfileDisplayName"

type ProfileState = ReturnType<typeof useProfileDisplayName>

export function HomeScreen({ profileState }: { profileState: ProfileState }): React.ReactElement {
  const client = useSupatype<AugmentedDatabase>()
  const { user, signOut } = useAuth()
  const { profile, initialLoading, error: loadError, refetch } = profileState

  const [draft, setDraft] = useState("")
  const [savedDisplayName, setSavedDisplayName] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const syncedProfileId = useRef<string | null>(null)

  const userId = user?.id

  useEffect(() => {
    if (userId === undefined) return
    if (profile === null) {
      if (!initialLoading) {
        const fallback = defaultDisplayName(user?.email)
        if (syncedProfileId.current !== userId) {
          syncedProfileId.current = userId
          setSavedDisplayName(null)
          setDraft(fallback)
        }
      }
      return
    }
    if (syncedProfileId.current === profile.id) return
    syncedProfileId.current = profile.id
    const name = profile.displayName?.trim() ?? defaultDisplayName(user?.email)
    setSavedDisplayName(name)
    setDraft(name)
    setSaveError(null)
  }, [profile, userId, user?.email, initialLoading])

  const saveProfile = useCallback(async () => {
    if (userId === undefined || saving) return
    const displayName = draft.trim()
    if (displayName === "") {
      setSaveError("Display name cannot be empty.")
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      const { data, error } = await client
        .from("profile")
        .upsert({ id: userId, displayName })
        .select("displayName")
        .single()
      if (error !== null) {
        setSaveError(error.message)
        return
      }
      const persisted = data?.displayName?.trim() ?? displayName
      setSavedDisplayName(persisted)
      setDraft(persisted)
      await refetch()
    } finally {
      setSaving(false)
    }
  }, [client, draft, refetch, saving, userId])

  const baseline = savedDisplayName ?? ""
  const isDirty = draft.trim() !== baseline.trim()

  if (user === null) {
    return (
      <View style={styles.container}>
        <Text style={styles.muted}>Sign in to view your profile.</Text>
      </View>
    )
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Profile</Text>
      <Text style={styles.email}>{user.email ?? user.id}</Text>

      {initialLoading ? (
        <ActivityIndicator style={styles.loader} color="#0f766e" />
      ) : loadError !== null ? (
        <Text style={styles.error}>{loadError.message}</Text>
      ) : (
        <>
          <Text style={styles.label}>Display name</Text>
          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            placeholder="How others see you in chat"
            editable={!saving}
            autoCapitalize="words"
            returnKeyType="done"
            onSubmitEditing={() => void saveProfile()}
          />
          <Pressable
            style={[styles.save, (!isDirty || saving || draft.trim() === "") && styles.saveDisabled]}
            onPress={() => void saveProfile()}
            disabled={!isDirty || saving || draft.trim() === ""}
          >
            <Text style={styles.saveText}>{saving ? "Saving…" : "Save profile"}</Text>
          </Pressable>
        </>
      )}

      {saveError !== null ? <Text style={styles.error}>{saveError}</Text> : null}

      <Pressable
        style={styles.signOut}
        onPress={() => {
          void signOut()
        }}
        accessibilityRole="button"
        accessibilityLabel="Sign out"
      >
        <Text style={styles.signOutText}>Sign out</Text>
      </Pressable>

      <Text style={styles.hint}>
        Your display name is stored on your profile and used as your chat author name for new
        messages.
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 24,
    paddingTop: 80,
    gap: 12,
    backgroundColor: "#ffffff",
  },
  title: {
    fontSize: 24,
    fontWeight: "700",
    color: "#111827",
  },
  email: {
    fontSize: 16,
    color: "#0f766e",
    marginBottom: 8,
  },
  label: {
    fontSize: 13,
    fontWeight: "600",
    color: "#374151",
    marginTop: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: "#d1d5db",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: "#111827",
  },
  save: {
    marginTop: 4,
    backgroundColor: "#0f766e",
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: "center",
  },
  saveDisabled: {
    opacity: 0.5,
  },
  saveText: {
    color: "#ffffff",
    fontWeight: "600",
    fontSize: 14,
  },
  signOut: {
    marginTop: 16,
    backgroundColor: "#111827",
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: "center",
  },
  signOutText: {
    color: "#ffffff",
    fontWeight: "600",
    fontSize: 14,
  },
  loader: {
    marginTop: 16,
  },
  error: {
    fontSize: 13,
    color: "#b91c1c",
  },
  muted: {
    color: "#6b7280",
  },
  hint: {
    marginTop: 24,
    fontSize: 13,
    color: "#6b7280",
    lineHeight: 18,
  },
})
