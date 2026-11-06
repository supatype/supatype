# Changelog

## Unreleased

### Bug Fixes

* **forms:** a form over a client with no API address or anon key shows the client's
  `MissingClientValuesError` as its error, calls `onError` with it, and stops loading. The client
  throws that error from the request rather than answering with it, and the forms passed it on as
  an unhandled rejection, so every sign-in and sign-up form stayed on its spinner.
* **forms:** the error a form shows for a client with no API address or anon key is the
  `MissingClientValuesError` itself, a `SupatypeError` like every other request's error now is,
  rather than a plain `{ message }`.
