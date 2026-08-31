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

## What it does not cover

Presence and broadcast, which are separate channel features, and row-level
filtering of change events. This example is about delivery.
