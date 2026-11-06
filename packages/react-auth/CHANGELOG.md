# Changelog

## Unreleased

### Features

* **sso:** `SSOForm` signs the user in through their organisation's SAML identity provider. It
  takes a work email (or a bare domain), calls `signInWithSSO` with its domain and sends the
  browser to the identity provider. Like the other forms it disables itself while the request
  runs, shows the server's refusal (no provider for the domain, a disabled one) and calls
  `onError`. A sign-in the server refused on the way back is shown above the field and passed to
  `onError` too, through the same hook `OAuthButton` uses for its provider. It takes
  `redirectTo`, `onSuccess`, `onError`, `className`, `labels` and `classNames`.

### Bug Fixes

* **forms:** a form over a client with no API address or anon key shows the client's
  `MissingClientValuesError` as its error, calls `onError` with it, and stops loading. The client
  throws that error from the request rather than answering with it, and the forms passed it on as
  an unhandled rejection, so every sign-in and sign-up form stayed on its spinner.
* **forms:** the error a form shows for a client with no API address or anon key is the
  `MissingClientValuesError` itself, a `SupatypeError` like every other request's error now is,
  rather than a plain `{ message }`.
