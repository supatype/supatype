import React, { useEffect, useState } from "react"
import { useMutation, useQuery, useSubscription } from "@supatype/react"
import type { Database } from "../../../supatype/generated/database"

type ChatMessage = Database["public"]["Tables"]["chat_message"]["Row"]

const ROOM = "lobby"

/**
 * Lobby chat: a row written by someone else arriving here without a refetch.
 *
 * The subscription is the assertion. A socket that opens and never delivers looks exactly like a
 * working one, so this renders what arrived rather than re-reading the table: if replication is
 * broken, the list stops growing while the box still says SUBSCRIBED, which is visible.
 */
export function LobbyScreen(): React.ReactElement {
  const [live, setLive] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState("")

  // The backlog, once. Everything after it arrives on the socket.
  const { data: history } = useQuery<Database, "chat_message", ChatMessage>("chat_message", {
    filter: { room: ROOM },
    order: { column: "created_at", ascending: true },
    limit: 50,
  })
  useEffect(() => {
    if (history) setLive(history)
  }, [history])

  const { status } = useSubscription<ChatMessage>("lobby-chat", {
    table: "chat_message",
    event: "INSERT",
    filter: `room=eq.${ROOM}`,
    callback: (payload) => {
      const row = payload.new
      if (!row) return
      // The writer sees their own insert arrive the same way everyone else does, so one path is
      // exercised rather than an optimistic one that hides a broken socket.
      setLive((current) => (current.some((m) => m.id === row.id) ? current : [...current, row]))
    },
  })

  const { mutate, loading } = useMutation<Database, "chat_message", ChatMessage>(
    "chat_message",
    "insert",
  )

  async function send(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    const body = draft.trim()
    if (body === "") return
    setDraft("")
    await mutate({ room: ROOM, body })
  }

  return (
    <section>
      <p className="ks-muted">
        Socket: <strong>{status}</strong> — and a status of SUBSCRIBED proves only that the gateway
        upgraded the connection. The messages below are what proves delivery.
      </p>

      <ul className="ks-list ks-list--chat">
        {live.map((message) => (
          <li key={message.id}>
            <span className="ks-muted">{message.authorName ?? "anon"}:</span> {message.body}
          </li>
        ))}
      </ul>

      <form className="ks-row" onSubmit={(e) => void send(e)}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Say something to the lobby"
          maxLength={500}
        />
        <button disabled={loading || draft.trim() === ""}>Send</button>
      </form>
    </section>
  )
}
