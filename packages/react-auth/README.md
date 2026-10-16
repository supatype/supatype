# `@supatype/react-auth`

Pre-built auth UI for React on Supatype: `LoginForm`, `SignUpForm` and `OAuthButton`.

Every component must render inside a `<SupatypeProvider>` from `@supatype/react`.

## Install

```bash
npm install @supatype/client @supatype/react @supatype/react-auth
```

## Styling: the forms ship no stylesheet

`LoginForm` and `SignUpForm` render plain, accessible markup and apply no styles of their own.
There is no CSS file to import and nothing to add to a Tailwind `content` list. Rendered with no
classes, they look like browser defaults: each label inline beside a narrow input, and a grey button.

Style them with your app's own classes. `className` goes on the `<form>`; `classNames` puts a class on
each element inside it:

| Slot | Element |
|---|---|
| `title` | the `<h2>` heading |
| `error` | the message shown when the auth service refuses the request |
| `field` | the wrapper around each label and input |
| `label` | each `<label>` |
| `input` | each `<input>` |
| `submit` | the submit `<button>` |
| `message` | the "check your email" confirmation `SignUpForm` shows |

```tsx
import { LoginForm, SignUpForm, type AuthFormClassNames } from "@supatype/react-auth"

const classNames: AuthFormClassNames = {
  title: "text-lg font-semibold",
  field: "flex flex-col gap-1",
  label: "text-sm font-medium",
  input: "rounded-md border px-3 py-2",
  submit: "rounded-md bg-emerald-700 px-4 py-2 text-white",
  error: "text-sm text-red-700",
}

<LoginForm className="flex flex-col gap-4" classNames={classNames} onSuccess={() => navigate("/")} />
<SignUpForm className="flex flex-col gap-4" classNames={classNames} />
```

Define the classes once and spread them onto both forms, so they cannot drift apart. The error
message is red by default and loses that colour once `classNames.error` is set.

An app that styles bare elements globally (`label`, `input`, `button`) can skip `classNames`.

`OAuthButton` is styled by default and drops its own styles when given a `className`:

```tsx
<OAuthButton provider="github" redirectTo="/dashboard" />
<OAuthButton provider="google" className="btn" />
```
