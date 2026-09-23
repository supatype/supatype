import React, { useEffect, useMemo, useRef, useState } from "react"
import { useMutation, useQuery, useSubscription } from "@supatype/react"
import { supatype } from "./client.js"
import type { Database } from "../../../supatype/generated/database"
import { Avatar, Badge, Button, Card, Input, Note, PageHeader, ProvesNote, Row } from "./components/ui.js"

type ChatMessage = Database["public"]["Tables"]["chat_message"]["Row"]

const ROOM = "lobby"

/**
 * Lobby chat: a row written by someone else arriving here without a refetch.
 *
 * The subscription is the assertion. A socket that opens and never delivers looks exactly like a
 * working one, so this renders what arrived rather than re-reading the table: if replication is
 * broken, the list stops growing while the badge still says SUBSCRIBED, which is visible.
 *
 * It is also where all three refusals live, and deliberately not on a screen of their own. The old
 * "Rules" tab listed the three mechanisms with a **Try it** button beside each, which taught the
 * taxonomy and nothing about the experience. Here you write a message that is too long, too short
 * or shouted, the write is refused, and the difference between the three is what the error can
 * tell you: a bound and a constraint come back as database errors, while the validator names the
 * field and says what to change.
 */
export function LobbyScreen({ userId, email }: { userId: string; email: string }): React.ReactElement {
  const [live, setLive] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState("")
  const [here, setHere] = useState(0)
  const [typing, setTyping] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const logRef = useRef<HTMLDivElement | null>(null)

  const me = useMemo(() => email.split("@")[0] ?? "you", [email])

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
      // exercised rather than an optimistic one that would hide a broken socket.
      setLive((current) => (current.some((m) => m.id === row.id) ? current : [...current, row]))
    },
  })

  /**
   * Who else is here, and who is typing, neither of which is a row.
   *
   * `postgres_changes` above carries what was written down. These two carry what was not: presence
   * is who is here *now*, broadcast is a message with no database behind it. A chat that stored
   * "typing…" as a row would write to disk on every keystroke to show something true for two
   * seconds.
   */
  useEffect(() => {
    const channel = supatype.realtime.channel(`lobby:${ROOM}`)

    channel.onPresence((event) => {
      setHere((count) => Math.max(0, count + event.joins.length - event.leaves.length))
    })
    channel.onBroadcast("typing", (payload) => {
      const who = (payload as { who?: string }).who ?? "someone"
      setTyping(who)
      setTimeout(() => setTyping(null), 2_000)
    })
    channel.subscribe((s) => {
      if (s === "SUBSCRIBED") channel.track({ at: Date.now(), who: me })
    })

    return () => channel.unsubscribe()
  }, [me])

  // Keep the newest message in view, the way every chat does.
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [live.length])

  function announceTyping(): void {
    supatype.realtime.channel(`lobby:${ROOM}`).broadcast("typing", { who: me })
  }

  const { mutate, loading } = useMutation<Database, "chat_message", ChatMessage>(
    "chat_message",
    "insert",
  )

  async function send(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    const body = draft.trim()
    if (body === "") return
    setRefusal(null)

    // Deliberately not pre-validated in the browser. A client-side check would hide which of the
    // three mechanisms refused the write, and this screen exists to make that visible.
    const { error } = await mutate({ room: ROOM, body })
    if (error) {
      setRefusal(error.message)
      return
    }
    setDraft("")
  }

  return (
    <>
      <PageHeader
        title="Lobby"
        subtitle="Everyone at the conference, in one room."
        action={
          <Row gap={8}>
            <Badge tone={status === "SUBSCRIBED" ? "accent" : "warn"} dot>
              {status === "SUBSCRIBED" ? "live" : status.toLowerCase()}
            </Badge>
            <Badge>{here > 0 ? `${here} here` : "just you"}</Badge>
          </Row>
        }
      />

      <ProvesNote>
        <p>
          Three realtime paths at once. <code>postgres_changes</code> carries what was written
          down; <strong>presence</strong> is who is here now; <strong>broadcast</strong> is the
          typing indicator, which is never a row.
        </p>
        <p>
          A badge reading <code>SUBSCRIBED</code> proves only that the gateway upgraded the
          connection. Messages appearing without a refetch is what proves delivery.
        </p>
        <p>
          Try sending <code>hi</code> (under two characters), something over 500 characters, or
          <code> HELLO EVERYONE</code>. Each is refused by a different mechanism: a model
          constraint, a field bound, and a validator. Only the validator can name the field and say
          what to change, which is the whole reason all three exist.
        </p>
      </ProvesNote>

      <Card padded={false}>
        <div className="ks-chat">
          <div className="ks-chat__log" ref={logRef}>
            {live.length === 0 && (
              <p className="ks-faint ks-small" style={{ margin: "auto" }}>
                Nothing said yet. Whatever you send arrives back through the socket, not from local
                state.
              </p>
            )}
            {live.map((message) => {
              const mine = message.auth_user_id === userId
              const who = message.authorName ?? (mine ? me : "attendee")
              return (
                <div
                  key={message.id}
                  className={mine ? "ks-chat__msg ks-chat__msg--mine" : "ks-chat__msg"}
                >
                  <Avatar name={who} size={28} />
                  <div>
                    {!mine && <div className="ks-chat__who">{who}</div>}
                    <div className="ks-chat__bubble">{message.body}</div>
                  </div>
                </div>
              )
            })}
          </div>

          <div className="ks-chat__foot">
            <div className="ks-chat__typing">
              {typing !== null ? `${typing} is typing…` : ""}
            </div>
            <form onSubmit={(e) => void send(e)}>
              <Row gap={8}>
                <Input
                  value={draft}
                  invalid={refusal !== null}
                  aria-label="Message"
                  onChange={(e) => {
                    setDraft(e.target.value)
                    setRefusal(null)
                    announceTyping()
                  }}
                  placeholder="Say something to the lobby"
                />
                <Button variant="primary" disabled={loading || draft.trim() === ""}>
                  Send
                </Button>
              </Row>
            </form>
            {refusal !== null && (
              <div style={{ marginTop: 10 }}>
                <Note tone="error">{refusal}</Note>
              </div>
            )}
          </div>
        </div>
      </Card>
    </>
  )
}
