import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native"
import type { AugmentedDatabase, ChannelStatus } from "@supatype/client"
import { RealtimeClient } from "@supatype/client"
import { useAuth, useQuery, useSupatype } from "@supatype/react"

export const LOBBY_ROOM = "lobby"

type ChatRow = AugmentedDatabase["public"]["Tables"]["chat_message"]["Row"] & {
  auth_user_id?: string | null
}

type ProfileRow = AugmentedDatabase["public"]["Tables"]["profile"]["Row"]

function realtimeWsBase(httpUrl: string): string {
  return `${httpUrl.replace(/\/$/, "")}/realtime/v1`
}

export function ChatScreen({
  authorName,
  currentUserId,
}: {
  authorName: string
  currentUserId: string | undefined
}): React.ReactElement {
  const client = useSupatype<AugmentedDatabase>()
  const { user, session } = useAuth()
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [liveMessages, setLiveMessages] = useState<ChatRow[]>([])
  const [subStatus, setSubStatus] = useState<ChannelStatus>("SUBSCRIBING")
  const seenIds = useRef(new Set<string>())

  const { data: initialRows, loading, error: loadError, refetch } = useQuery<
    AugmentedDatabase,
    "chat_message",
    ChatRow
  >("chat_message", {
    filter: { room: LOBBY_ROOM },
    order: { column: "created_at", ascending: true },
    limit: 100,
    enabled: user !== null,
  })

  const { data: profileRows, refetch: refetchProfiles } = useQuery<
    AugmentedDatabase,
    "profile",
    ProfileRow
  >("profile", {
    limit: 200,
    enabled: user !== null,
  })

  useEffect(() => {
    void refetchProfiles()
  }, [authorName, refetchProfiles])

  const profilesByUserId = useMemo(() => {
    const map = new Map<string, string>()
    for (const row of profileRows ?? []) {
      const name = row.displayName?.trim()
      if (name !== undefined && name !== "") map.set(row.id, name)
    }
    return map
  }, [profileRows])

  const messages = mergeMessages(initialRows ?? [], liveMessages, seenIds.current)

  useEffect(() => {
    const token = session?.accessToken
    if (token === undefined || token === "") return

    const rt = new RealtimeClient(realtimeWsBase(client.url), {
      apikey: token,
      Authorization: `Bearer ${token}`,
    })

    const channel = rt
      .channel("public:chat_message")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "chat_message",
          filter: `room=eq.${LOBBY_ROOM}`,
        },
        (payload) => {
          const raw = payload.new as ChatRow | null
          if (raw === null || seenIds.current.has(raw.id)) return
          const row: ChatRow = {
            ...raw,
            created_at: normalizeMessageTimestamp(raw.created_at, payload.commitTimestamp),
          }
          seenIds.current.add(row.id)
          setLiveMessages((prev) => [...prev, row])
        },
      )
      .subscribe((status) => setSubStatus(status))

    return () => {
      channel.unsubscribe()
      rt.disconnect()
    }
  }, [client.url, session?.accessToken])

  const sendMessage = useCallback(async () => {
    const body = draft.trim()
    if (body === "" || user === null || sending) return
    setSending(true)
    setSendError(null)
    const authorNameForMessage = authorName
    const { data, error } = await client
      .from("chat_message")
      .insert({
        room: LOBBY_ROOM,
        body,
        auth_user_id: user.id,
        authorName: authorNameForMessage,
      } as AugmentedDatabase["public"]["Tables"]["chat_message"]["Insert"])
      .select("id,room,body,auth_user_id,authorName,created_at")
      .single()
    setSending(false)
    if (error !== null) {
      setSendError(error.message)
      return
    }
    if (data !== null && !seenIds.current.has(data.id)) {
      seenIds.current.add(data.id)
      setLiveMessages((prev) => [...prev, data as ChatRow])
    }
    setDraft("")
  }, [authorName, client, draft, sending, user])

  if (user === null) {
    return (
      <View style={styles.centered}>
        <Text style={styles.muted}>Sign in to use lobby chat.</Text>
      </View>
    )
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={80}
    >
      <View style={styles.header}>
        <Text style={styles.title}>Lobby chat</Text>
        <Text style={styles.status}>
          Realtime: {subStatus === "SUBSCRIBED" ? "live" : subStatus.toLowerCase()}
        </Text>
      </View>

      {loading ? (
        <ActivityIndicator style={styles.loader} color="#0f766e" />
      ) : loadError !== null ? (
        <View style={styles.centered}>
          <Text style={styles.error}>{loadError.message}</Text>
          <Pressable onPress={() => void refetch()} style={styles.retry}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={messages}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <View style={styles.bubble}>
              <Text style={styles.author}>
                {resolveAuthorLabel(item, profilesByUserId, currentUserId, authorName)}
              </Text>
              <Text style={styles.body}>{item.body}</Text>
            </View>
          )}
          ListEmptyComponent={
            <Text style={styles.muted}>No messages yet — say hello.</Text>
          }
        />
      )}

      {sendError !== null ? <Text style={styles.error}>{sendError}</Text> : null}

      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder="Message the lobby…"
          editable={!sending}
          onSubmitEditing={() => void sendMessage()}
          returnKeyType="send"
        />
        <Pressable
          style={[styles.send, sending ? styles.sendDisabled : null]}
          onPress={() => void sendMessage()}
          disabled={sending || draft.trim() === ""}
        >
          <Text style={styles.sendText}>{sending ? "…" : "Send"}</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  )
}

function mergeMessages(
  initial: ChatRow[],
  live: ChatRow[],
  seen: Set<string>,
): ChatRow[] {
  const merged = new Map<string, ChatRow>()
  // Live first, then initial — REST rows win on duplicate ids and keep `created_at`.
  for (const row of [...live, ...initial]) {
    merged.set(row.id, row)
    seen.add(row.id)
  }
  return [...merged.values()].sort((a, b) => messageSortTime(a) - messageSortTime(b))
}

function messageSortTime(row: ChatRow): number {
  return parseMessageTime(row.created_at) ?? Number.MAX_SAFE_INTEGER
}

function normalizeMessageTimestamp(
  createdAt: string | undefined | null,
  commitTimestamp: string | undefined,
): string {
  const parsed =
    parseMessageTime(createdAt) ??
    parseMessageTime(commitTimestamp) ??
    Date.now()
  return new Date(parsed).toISOString()
}

function parseMessageTime(value: string | undefined | null): number | null {
  if (value === undefined || value === null) return null
  const trimmed = value.trim()
  if (trimmed === "") return null
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed)
    return Number.isFinite(n) ? n : null
  }
  const ms = Date.parse(trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T"))
  return Number.isFinite(ms) ? ms : null
}

function resolveAuthorLabel(
  message: ChatRow,
  profilesByUserId: Map<string, string>,
  currentUserId: string | undefined,
  currentDisplayName: string,
): string {
  const authorId = message.auth_user_id
  if (authorId !== undefined && authorId !== null && authorId !== "") {
    if (authorId === currentUserId) return currentDisplayName
    const fromProfile = profilesByUserId.get(authorId)
    if (fromProfile !== undefined) return fromProfile
  }
  return message.authorName ?? "User"
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#ffffff",
  },
  header: {
    paddingTop: 72,
    paddingHorizontal: 16,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e5e7eb",
  },
  title: {
    fontSize: 22,
    fontWeight: "700",
    color: "#111827",
  },
  status: {
    marginTop: 4,
    fontSize: 12,
    color: "#0f766e",
  },
  loader: {
    marginTop: 24,
  },
  list: {
    padding: 16,
    gap: 10,
    flexGrow: 1,
  },
  bubble: {
    backgroundColor: "#f3f4f6",
    borderRadius: 10,
    padding: 10,
    marginBottom: 8,
  },
  author: {
    fontSize: 12,
    fontWeight: "600",
    color: "#374151",
    marginBottom: 4,
  },
  body: {
    fontSize: 15,
    color: "#111827",
  },
  composer: {
    flexDirection: "row",
    gap: 8,
    padding: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#e5e7eb",
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#d1d5db",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  send: {
    backgroundColor: "#0f766e",
    borderRadius: 8,
    paddingHorizontal: 16,
    justifyContent: "center",
  },
  sendDisabled: {
    opacity: 0.6,
  },
  sendText: {
    color: "#ffffff",
    fontWeight: "600",
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  muted: {
    color: "#6b7280",
    textAlign: "center",
  },
  error: {
    color: "#b91c1c",
    paddingHorizontal: 16,
    paddingBottom: 8,
    fontSize: 13,
  },
  retry: {
    marginTop: 12,
    padding: 8,
  },
  retryText: {
    color: "#0f766e",
    fontWeight: "600",
  },
})
