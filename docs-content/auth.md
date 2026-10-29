---
title: "Auth"
description: "Sign users in with email, magic links, phone codes or OAuth, manage sessions, tie tokens to access rules, and use the pre-built React and React Native UI."
---

Auth is built into the Supatype server. It signs users in, issues the tokens every request carries, and those tokens are what your schema's access rules check.

<h2 id="service">How it runs</h2>

The auth service is part of `supatype-server`, the same process that serves REST, GraphQL, storage and functions. It answers under `/auth/v1` on your project's API URL. It keeps its users, identities and sessions in the `auth` schema of your project's database and runs its own migrations when the server starts.

- `supatype dev` with `database.provider: "docker"` (what `supatype init` writes): the server runs in the Compose stack behind Kong. Your API URL is `API_EXTERNAL_URL` in the project's `.env`.
- `supatype dev` with `database.provider: "native"`: the server runs as a local process on `server.port`, `54321` by default.
- Self-host: `supatype self-host compose up` runs the same server image. It needs `JWT_SECRET` in `.env` and fills in a blank `ANON_KEY` or `SERVICE_ROLE_KEY` from it. See [Self-hosting](/docs/#self-host).

In local dev, sign-ups are confirmed automatically, so a new user gets a session straight away with no email round trip.

:::note
Who may open Studio, and what they may do there, is decided by Studio roles. See [Studio roles](/docs/studio-roles.html).
:::

<h2 id="methods">Sign-in methods</h2>

Each method below is a call on `supatype.auth`. The [client page](/docs/client.html#auth) shows the common ones in use.

| Method | Client call | Default |
| --- | --- | --- |
| Email and password | `signUp`, `signInWithPassword` | On |
| Magic link or email code | `signInWithOtp({ email })`, then `verifyOtp` for a code | On, needs a mail provider to deliver |
| Phone code (SMS, or WhatsApp with Twilio) | `signInWithOtp({ phone })`, `verifyOtp` | Off, needs an SMS provider |
| OAuth | `signInWithOAuth({ provider })` | Off until a provider is configured |
| Provider ID token (native Apple or Google sign-in) | `signInWithIdToken` | Off until the provider is configured |
| Anonymous | `signInAnonymously` | Off |

Password reset is `resetPasswordForEmail`, and `updateUser` changes the email, password or user metadata of the signed-in user. Passwords must be at least 6 characters unless you raise `SUPATYPE_PASSWORD_MIN_LENGTH`.

### Multi-factor

`supatype.auth.mfa` has `enroll`, `challenge`, `verify`, `challengeAndVerify` and `unenroll`. TOTP authenticator apps are on by default. Phone factors are off by default and need an SMS provider.

### Anonymous users

An anonymous sign-in creates a real user with a user id and a session. Turn it on with `SUPATYPE_EXTERNAL_ANONYMOUS_USERS_ENABLED=true`. Because the user has an id, an anonymous user passes `LoggedIn` and can own rows. The token carries `is_anonymous: true`.

<h2 id="oauth">OAuth providers</h2>

Each provider is switched on with environment variables named after it. For GitHub:

```ini title=".env"
# Replace http://localhost:54321 with your API URL (API_EXTERNAL_URL)
SUPATYPE_EXTERNAL_GITHUB_ENABLED=true
SUPATYPE_EXTERNAL_GITHUB_CLIENT_ID=your-client-id
SUPATYPE_EXTERNAL_GITHUB_SECRET=your-client-secret
SUPATYPE_EXTERNAL_GITHUB_REDIRECT_URI=http://localhost:54321/auth/v1/callback
```

The redirect URI is the auth service's callback: `/auth/v1/callback` on your API URL. Register the same URL with the provider. A provider with no client id, secret or redirect URI is refused when someone tries to use it.

Supported provider names: `apple`, `azure`, `bitbucket`, `discord`, `facebook`, `figma`, `fly`, `github`, `gitlab`, `google`, `kakao`, `keycloak`, `linkedin_oidc`, `notion`, `slack_oidc`, `snapchat`, `spotify`, `twitch`, `twitter`, `x`, `workos` and `zoom`. Upper-case the name for the variable, so `linkedin_oidc` becomes `SUPATYPE_EXTERNAL_LINKEDIN_OIDC_ENABLED`.

### The sign-in round trip

```ts
const { data, error } = await supatype.auth.signInWithOAuth({
  provider: "github",
  options: { redirectTo: "http://localhost:5173/auth/callback" },
})
if (error) throw new Error(error.message)
window.location.assign(data.url)

// On /auth/callback
const { error: callbackError } = await supatype.auth.getSessionFromUrl(window.location.href)
if (callbackError) console.error(callbackError.message)
```

`signInWithOAuth` returns the URL; it does not navigate for you. `redirectTo` must be on the same host as `SITE_URL`, a loopback address, or match an entry in `SUPATYPE_URI_ALLOW_LIST` (comma-separated, globs allowed). Anything else sends the user to `SITE_URL` instead. An app on another domain, or a mobile deep link, needs an allow list entry.

The web default is the implicit flow, which returns tokens in the URL fragment. Pass `flowType: "pkce"` in the options for a code exchange instead; mobile apps should always use PKCE. `getSessionFromUrl` handles both.

<h2 id="sessions">Sessions and tokens</h2>

A session is a short-lived access token and a refresh token.

- The access token is a JWT signed with `JWT_SECRET`, valid for one hour. The client sends it as `Authorization: Bearer` on every request.
- The client refreshes it about a minute before it expires, and again on load if a saved session has already expired. If the refresh fails, the session is cleared rather than kept with a dead token.
- Refresh tokens rotate: each refresh issues a new one.
- `signOut` ends the session on the server and clears it locally.

In the browser the session is saved to `localStorage` under `supatype.auth.session` and mirrored to a cookie named `st-auth-token`, which `@supatype/ssr` reads on the server. Set `auth: { persistSession: false }`, `storageKey` or `cookiePrefix` on `createClient` to change this. On React Native, `createNativeClient` from `@supatype/react-native` stores the session in `expo-secure-store` or AsyncStorage.

### What the token says

| Claim | Meaning |
| --- | --- |
| `sub` | The user id |
| `role` | The database role the API runs the request as: `authenticated` for a signed-in user |
| `email`, `phone` | The user's contact details |
| `app_metadata` | Set only through the admin API. Holds the application role that `Role<>` checks |
| `user_metadata` | Set by the user, for example through `signUp` options or `updateUser`. Never trust it for access |
| `aal`, `amr` | Assurance level and how the user signed in, for MFA |
| `session_id`, `is_anonymous` | The session, and whether the user signed in anonymously |

Requests made with only the anon key have no user. Requests made with the service role key pass every access rule; keep that key on the server.

<h2 id="access">Access rules</h2>

The access rules you declare in the schema compile to Postgres row level security that reads the verified token. Every request runs with the token's claims available to the database, so the same rule holds for REST, GraphQL and realtime. The rules themselves are listed on the [schema page](/docs/schema.html#access).

```ts title="schema/index.ts"
import type { Model, UUID, SupatypeAuthUserId, Public, LoggedIn, Owner } from "@supatype/types"

export type Profile = Model<{
  id: SupatypeAuthUserId
  display_name: string
}, {
  access: { read: Public; create: Owner<"id">; update: Owner<"id">; delete: Owner<"id"> }
}>

export type Bookmark = Model<{
  id: UUID
  owner_id: SupatypeAuthUserId
  post_id: UUID
}, {
  access: { read: Owner<"owner_id">; create: LoggedIn; update: Owner<"owner_id">; delete: Owner<"owner_id"> }
}>
```

A profile keyed on the user id lets each user write only their own row. Bookmarks are private to whoever saved them.

### What the rules become

The engine installs a small set of SQL functions in the `auth` schema, and every policy calls them:

| Rule or function | SQL |
| --- | --- |
| `auth.uid()` | The token's `sub` as a `uuid`, or `NULL` when there is no user |
| `auth.role()` | `app_metadata.role`, falling back to the top-level `role` claim, then `anon` |
| `auth.claim(path)` | A nested claim by dotted path, used by `Claim<>` |
| `LoggedIn` | `(SELECT auth.uid()) IS NOT NULL` |
| `Owner<"owner_id">` | `(SELECT auth.uid()) = "owner_id"` |
| `Role<"admin">` | `(SELECT auth.role()) = 'admin'` |

Because `auth.uid()` is `NULL` for a request with no user, an owner rule never matches an anonymous request, even on a row whose owner column is empty. The calls are wrapped in `SELECT` so Postgres evaluates them once per query rather than once per row.

To give a user an application role for `Role<>`, set `app_metadata.role` through the auth admin API with the service role key. Users cannot set it themselves.

<h2 id="ui">Pre-built UI</h2>

Two packages give you ready-made sign-in screens. Both use `useAuth()` from `@supatype/react`, so they must sit inside a `<SupatypeProvider>`.

| Package | Components |
| --- | --- |
| `@supatype/react-auth` | `LoginForm`, `SignUpForm`, `OAuthButton` |
| `@supatype/react-native-auth` | `LoginForm`, `SignUpForm`, `MagicLinkForm`, `OAuthButton`, `ResetPassword`, `AuthGate`, `AuthThemeProvider` |

### Web

```tsx title="src/SignIn.tsx"
import { SupatypeProvider } from "@supatype/react"
import { LoginForm, OAuthButton } from "@supatype/react-auth"
import { supatype } from "./supatype"

export function SignIn() {
  return (
    <SupatypeProvider client={supatype}>
      <LoginForm onSuccess={() => window.location.assign("/")} />
      <OAuthButton provider="github" redirectTo="http://localhost:5173/auth/callback" />
    </SupatypeProvider>
  )
}
```

The web forms are plain, unstyled markup: pass `className` and `labels` to fit your app. `OAuthButton` has a default style and an icon for GitHub, Google and Apple, which a `className` replaces. It sends the browser to the provider; your callback page still calls `getSessionFromUrl`.

### React Native

```tsx title="App.tsx"
import * as SecureStore from "expo-secure-store"
import * as WebBrowser from "expo-web-browser"
import * as Linking from "expo-linking"
import { SupatypeProvider } from "@supatype/react"
import { createNativeClient } from "@supatype/react-native"
import { AuthGate, LoginForm, OAuthButton } from "@supatype/react-native-auth"

const client = createNativeClient({
  url: process.env.EXPO_PUBLIC_SUPATYPE_URL!,
  anonKey: process.env.EXPO_PUBLIC_SUPATYPE_ANON_KEY!,
  secureStore: SecureStore,
})
const redirectTo = Linking.createURL("auth/callback")

export default function App() {
  return (
    <SupatypeProvider client={client}>
      <AuthGate fallback={<><LoginForm /><OAuthButton provider="google" redirectTo={redirectTo} webBrowser={WebBrowser} /></>}>
        {/* signed-in app */}
      </AuthGate>
    </SupatypeProvider>
  )
}
```

`AuthGate` renders its children only when there is a session, and `fallback` otherwise. The native `OAuthButton` uses PKCE and opens the provider in `expo-web-browser`. Wrap the tree in `AuthThemeProvider` to change colours and spacing.

<h2 id="config">Configuration</h2>

### Email delivery

Confirmation, magic link and reset emails go through the `email` block in `supatype.config.ts`:

```ts title="supatype.config.ts"
email: {
  provider: "smtp", // "console" | "smtp" | "resend" | "ses"
  smtp: { host: "smtp.example.com", port: 587, user: "apikey", pass: process.env.SMTP_PASS, admin_email: "no-reply@example.com" },
},
```

:::note[Console sends nothing]
`console`, the default, logs that a message would have been sent but leaves out the body, so the link is not in the log. To try magic links or password reset, configure a real provider.
:::

For Resend, set `SUPATYPE_RESEND_API_KEY` and `SUPATYPE_RESEND_FROM` in `.env`. For SES, set `SUPATYPE_SES_FROM`; credentials come from the environment's AWS configuration.

### Environment variables

The server reads the project's `.env` when it starts, so `SUPATYPE_*` auth variables placed there take effect after a restart. In the Docker stacks, a few values are set by the generated Compose file and are read from the plain names shown.

| Variable | What it does |
| --- | --- |
| `JWT_SECRET` | Signs every token. Required for self-host. Change it and every issued token, including the anon and service role keys, stops working |
| `ANON_KEY`, `SERVICE_ROLE_KEY` | Keys signed with `JWT_SECRET`. `supatype keys --write` generates them |
| `SITE_URL` | Self-host: your app's URL, the default place users land after confirming or signing in |
| `SUPATYPE_URI_ALLOW_LIST` | Other URLs `redirectTo` may point at, comma-separated |
| `DISABLE_SIGNUP` (self-host), `SUPATYPE_DISABLE_SIGNUP` (native dev) | `true` stops new sign-ups |
| `SUPATYPE_MAILER_AUTOCONFIRM` | `true` skips email confirmation. On in dev, and on by default in self-host until you set it to `false` |
| `SUPATYPE_EXTERNAL_<PROVIDER>_*` | OAuth providers, see [above](#oauth) |
| `SUPATYPE_EXTERNAL_ANONYMOUS_USERS_ENABLED` | Allow anonymous sign-in |
| `SUPATYPE_EXTERNAL_EMAIL_MAGIC_LINK_ENABLED` | `false` turns magic links off |
| `SUPATYPE_PASSWORD_MIN_LENGTH` | Minimum password length, at least 6 |
| `SUPATYPE_EXTERNAL_PHONE_ENABLED`, `SUPATYPE_SMS_PROVIDER` | Phone sign-in. The provider is `twilio`, `twilio_verify`, `messagebird`, `textlocal` or `vonage` |

:::note[Self-host]
Self-host turns auto-confirm on unless you set `SUPATYPE_MAILER_AUTOCONFIRM=false`. Set it, and configure email delivery, before you open sign-up to the public.
:::

To create users from a seed file, see [Seeding users](/docs/seeding.html#users).
