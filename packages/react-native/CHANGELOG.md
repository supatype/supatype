# Changelog

## Unreleased

### Bug Fixes

* **createAuthUrlListener:** an auth link whose exchange throws instead of answering
  `{ data, error }` (a client with no API address or anon key throws from its first request) is
  handed to `onError` and logged once with `console.error`. It was an unhandled rejection, and
  `onError` never heard of it. A `getInitialURL` that rejects is reported the same way.
