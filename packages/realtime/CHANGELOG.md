# Changelog

## 0.9.3

### Features

* **Private channels are enforced.** A channel the schema declares (`Channel<"lot:{id}", ...>`) is now
  judged for every socket, whether or not the client says `private`. The server asks
  `_supatype.realtime_channel_access(topic)` as the caller (their role and their claims) when a socket
  joins, caches the answer, and refuses a broadcast or a presence track the answer does not allow with
  no further database call. Before this, any holder of the anon key could join a channel, hear its
  broadcasts, send on it and appear in its presence. A declared channel is enforced at once, for old
  clients too, and `realtime.channels: "declared"` (or `REALTIME_CHANNELS=declared`, which can only
  tighten it) also refuses broadcast and presence on a channel nothing declares. A join that fails to
  reach the database is refused with a retryable message, never admitted.
* **Access is re-checked.** On a new token (a user whose access was taken away loses the channel, with a
  presence leave), on a schema push, when a table a channel's rules read changes (batched to one a
  second), and every `REALTIME_CHANNEL_RECHECK_S` seconds (default 300) as a backstop.
* **Send rules can check the event name and payload shape**, evaluated in the server on every
  broadcast from `_supatype.realtime_channel_send_checks()`, with no database call.
* **Broadcast from the database.** A row `_supatype.realtime_send` writes to `_supatype.realtime_outbox`
  is delivered as a broadcast to every member admitted to the channel.
* **Every refusal and withdrawal carries a `code`.** A `system` error frame now has a fixed, closed
  `code` (`join_denied`, `not_declared`, `does_not_fit`, `unavailable`, `shared_instance`, `withdrawn`,
  `send_denied`, `track_denied`, `payload_refused`, `refused`) beside the human `message`, so a client
  acts on the code and not on the wording. A refused broadcast or presence track uses `send_denied`,
  `track_denied` or `payload_refused`, which tell the client the channel itself is still healthy.
* The first frame of a socket carries `features: ["private_channels"]` so a client can tell this server
  from one that ignores the flag. A shared (multi-tenant) instance does not enforce channel rules and
  refuses a join opened as private.

### Bug Fixes

* **A new token re-checks every held channel.** A channel joined with the service role records no
  declaration, so a token change re-checked only declared channels and left it with the service
  role's rights after the socket switched to a user token. Every held channel is now judged again.
* **The channel catalog is read again at the timed re-check.** It was read at start and after a push
  the watcher saw, so a missed push left a stale mode, stale content checks, or "no channel functions"
  from before the first push, which enforced nothing on any declared channel. The backstop re-check
  now re-reads it first.
* **postgres_changes payloads change shape.** Values now match what REST returns. `json` and `jsonb`
  columns arrive as the parsed value, where they were the JSON text. `timestamptz` arrives as ISO 8601,
  `2024-01-01T12:00:00+00:00`, where it was `2024-01-01 12:00:00+00`, which Safari and Firefox read as
  `Invalid Date`; `timestamp` is `2024-01-01T12:00:00` and `timetz` has a full offset. Microseconds
  are kept, and arrays of these types arrive as arrays. A value that cannot be read is passed on as it
  came. Code that called `JSON.parse` on a json column must stop.
