# Changelog

## Unreleased

### Bug Fixes

* **LoginForm, SignUpForm, MagicLinkForm, ResetPassword:** an auth request that throws instead of
  answering `{ data, error }` (a client with no API address or anon key throws from its first
  request) is shown as the form's error, handed to `onError` and logged once with `console.error`.
  The forms only reset their button; the error went nowhere and the rejection was unhandled.
