# Changelog

## Unreleased

### Bug Fixes

* **records:** a record path whose id names no record shows "not found" in place of an edit form.
  `/models/post/access` read `access` as a record id and opened an empty form under Postgres's
  `invalid input syntax for type uuid: "access"`; a well-formed id with no row behind it opened the
  same empty form. Both are now a not-found page, built on a shared `PageError` primitive.
* **validation:** count messages agree with their number: "at least 1 item", "1 character or
  fewer", rather than "at least 1 items". Covers the Rules tab, the form's own bound checks and the
  database's too-long refusal.
* **connect:** the Next.js server-client snippets write the session cookie in `setAll`, which
  `@supatype/ssr` now calls when it refreshes a session. The App Router one had an empty `setAll`
  that claimed middleware handled it; the Pages Router one wrote the value unencoded and dropped
  `Max-Age` and `SameSite`.

## 0.7.0

Highlights: the Realtime Inspector; a Schema objects view; reads through a metadata catalogue; the
SQL editor for owners, admins and developers on its own non-superuser login; a viewer role and an
elevated/self switch; a CORS origins page; who pushed each migration; Cloud member login linking.

### Features

* **settings:** the CORS tab shows the browser origins the project's gateway allows,
  and where each comes from (site URL, config, the platform, or saved here). Owners, admins and developers can
  add and remove origins, which saves the list in the project's database in place of the default,
  and reset it. Dev mode is called out, since it allows every origin anyway.

## 0.3.6 (2026-10-02)

### Features

* **seeds:** a Database > Seeds screen, reading `_supatype.seeds` the same way the migrations
  screen reads `_supatype.migrations`: through `proxy.sql`, with no new engine endpoint.

  It shows each run's file, status, what it wrote per model, when it ran, how long it took and
  which engine wrote it. Two things beyond a plain listing: a file whose latest run used a
  different document than the run before it is badged as having changed since it was applied,
  which is the question the screen exists to answer and cannot be answered from one row; and a
  run that wrote nothing says so rather than leaving the cell blank.

  A rolled back run is shown rather than hidden, and in red rather than the yellow a rolled back
  migration gets: that one is a deliberate operation and this one is a seed that failed.
