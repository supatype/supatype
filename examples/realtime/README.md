# Realtime

A change in the database arriving at a subscriber.

Realtime is on by default, so every other example already runs the service. None
of them subscribed to anything, which meant the only thing ever proven was that
the gateway would upgrade a WebSocket. **A socket that opens and never delivers a
row looks exactly like a working one** until somebody waits for a message that
does not come.

So this example waits, with a deadline, and exits non-zero when nothing arrives.

## Running it

```sh
pnpm dev       # in one terminal: Postgres, the schema, the stack
pnpm verify    # in another
```

`verify` subscribes to `public:message`, writes a row over REST, and asserts the
`INSERT` reaches the subscriber:

```
  subscribed to public:message
  inserted a row over REST
  received the INSERT: hello at 2026-08-31T06:02:58.573Z
PASS: a write reached the subscriber
```

Stop the realtime container and run it again to see it fail, which is the point:

```
FAIL: the channel never subscribed (last status: never reported)
```

## The one thing worth copying

`client.from("message").subscribe(cb)` registers the listener. It does **not**
open the socket — `.subscribe()` on the returned channel does:

```ts
const sub = supatype.from("message").subscribe(onChange, { event: "INSERT" })
sub.channel.subscribe((status) => { /* SUBSCRIBED, CHANNEL_ERROR, ... */ })
```

Without that second line the callback is never called, and the failure is a
timeout with nothing to say why. Wait for `SUBSCRIBED` before writing the row
you expect to be told about, or the write races the subscription and the event
is missed for a reason that has nothing to do with realtime.

## Broadcast and presence

```sh
pnpm verify:channels
```

The other two channel features, asserted between **two** clients, because one
that only works when sender and receiver share a connection is not a feature
anyone can use:

```
  ok   broadcast reached the other client: {"from":"sender","at":1788159108931}
  ok   presence join seen by the other client: [{"user_id":"anonymous","who":"sender"}]
PASS: broadcast and presence both delivered between two clients
```

Neither touches the database, so they are checked separately from
`postgres_changes`: a stack whose replication is broken still serves them, and a
stack whose socket is fine can still fail them.

## What it does not cover

Row-level filtering of change events, and change events for a user whose access
rules hide the row. Everything here is public, so absence of an event would be
ambiguous; access control has its own examples.
