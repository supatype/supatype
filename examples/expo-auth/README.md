# Expo auth example

Minimal Expo app that exercises `@supatype/react-native` + `@supatype/react-native-auth`:

- Email / password sign-in and sign-up
- Magic link
- Password reset request
- Google / GitHub OAuth (PKCE via `openOAuth`)
- Session persistence with Expo Secure Store
- Deep-link completion via `createAuthUrlListener`

## Prerequisites

1. A running Supatype stack (`supatype dev` or cloud project) with auth enabled.
2. OAuth providers configured if you want Google/GitHub buttons to work.
3. Redirect URI allowlisted on the auth server (printed on the auth screen), e.g.  
   `supatype-expo-auth://auth/callback` (custom scheme) or the Expo Go URL from `Linking.createURL`.

## Setup

From the monorepo root:

```bash
pnpm install
pnpm --filter @supatype/client build
pnpm --filter @supatype/react build
pnpm --filter @supatype/react-native build
pnpm --filter @supatype/react-native-auth build

cd examples/expo-auth
cp .env.example .env
# edit EXPO_PUBLIC_SUPATYPE_URL and EXPO_PUBLIC_SUPATYPE_ANON_KEY
pnpm start
```

Then open in Expo Go or a simulator.

## Smoke checklist

Automated (from monorepo root, against a GoTrue-compatible gateway):

```bash
pnpm --filter @supatype/client build
pnpm --filter @supatype/react-native build
pnpm exec tsx examples/expo-auth/scripts/smoke-native-auth.mts
```

Defaults to `http://localhost:54321` (local Supabase/GoTrue). Override with `SUPATYPE_URL` / `SUPATYPE_ANON_KEY`.

Manual UI:

1. Sign in with email/password → see “Signed in”.
2. Kill the app and relaunch → still signed in.
3. Sign out → auth screen returns.
4. Magic link (if email delivery works) → open link → signed in.
5. OAuth (provider configured) → browser sheet → return with session.

Bundle check: `cd examples/expo-auth && pnpm exec expo export --platform web --output-dir dist-smoke`

## Notes

- Scheme: `supatype-expo-auth` (`app.json`).
- Metro is configured for the pnpm workspace (`metro.config.js`).
- This example is intentionally private and not published to npm.
