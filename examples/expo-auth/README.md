# Expo auth example

Full **Supatype project** + Expo app that exercises native auth:

- `supatype.config.ts` + `schema/` (typed `Profile` model)
- Local docker stack via `supatype dev` (Kong gateway)
- Email / password, magic link, password reset
- Google / GitHub OAuth (PKCE via `openOAuth`)
- Session persistence: Secure Store (native) / localStorage (web)
- Deep-link completion via `createAuthUrlListener`
- Signed-in screen upserts/reads `profile` over REST
- **Lobby chat** tab with realtime `chat_message` INSERT (WebSocket via Kong)

## Prerequisites

- Docker (for `supatype dev`)
- Expo Go **SDK 54** (or a matching simulator)

## Setup

From the monorepo root:

```bash
pnpm install
pnpm --filter @supatype/client build
pnpm --filter @supatype/react build
pnpm --filter @supatype/react-native build
pnpm --filter @supatype/react-native-auth build
pnpm --filter @supatype/cli build

cd examples/expo-auth
cp .env.example .env
pnpm exec supatype keys          # mints JWTs + EXPO_PUBLIC_* in .env
pnpm exec supatype push --yes    # migrate schema + regenerate types
pnpm exec supatype dev           # terminal 1 — Compose stack, Kong :18473
pnpm start                       # terminal 2 — Expo
```

Open in Expo Go. On a physical device, set `EXPO_PUBLIC_SUPATYPE_URL` to your LAN IP
(e.g. `http://10.x.x.x:18473`) after `supatype dev` (or edit `.env` and restart Metro).

Allowlist the redirect URI on the auth server (printed on the auth screen), e.g.
`supatype-expo-auth://auth/callback`.

## Smoke checklist

Automated (from this directory, against the **Supatype** gateway):

```bash
# with `supatype dev` already running
pnpm smoke
```

Defaults to `EXPO_PUBLIC_SUPATYPE_URL` / `EXPO_PUBLIC_SUPATYPE_ANON_KEY` from `.env`,
or `http://localhost:18473` + `ANON_KEY`. Override with `SUPATYPE_URL` / `SUPATYPE_ANON_KEY`.

Manual UI:

1. Sign up / sign in → Profile tab shows your display name (editable).
2. Change display name → Save profile → persists after refresh.
3. Kill and relaunch (native) or refresh the browser (web) → still signed in.
4. Sign out → auth screen returns.
5. Magic link / OAuth when providers + email are configured.
6. Open **Chat** tab — send a message; open a second device/simulator to see realtime delivery.

Bundle check: `pnpm exec expo export --platform web --output-dir dist-smoke`

## Notes

- Scheme: `supatype-expo-auth` (`app.json`).
- Metro is configured for the pnpm workspace (`metro.config.js`).
- Machine-local engine/server binaries: `supatype.local.config.ts.example`.
- This example is private and not published to npm.
