# Changelog

## Unreleased

### Features

* **auth:** an SSO page for the project's SAML identity providers, replacing "SSO is coming soon".
  It lists each provider by name with its entity ID, domains and whether it is enabled; adds one
  from a metadata URL or an uploaded or pasted metadata XML, with its domains, NameID format and an
  optional attribute mapping; edits one in place, keeping its NameID format; disables and enables
  one; and removes one after saying that users who signed in through it can no longer sign in that
  way. It shows the entity ID and ACS URL to give an identity provider, read from the server's own
  SP metadata, and says when SAML is off, while still letting providers be set up first. Changes are
  offered to owners and admins, the roles the auth server lets change them; developers see the page
  read-only.
* **auth:** the SSO page shows whether each of a provider's domains is verified, and a Verify action
  beside an unverified one. Verify asks the auth server to check the domain and shows the DNS TXT
  record to add (`_supatype-challenge.<domain>` and its value), what DNS holds there now, and Check
  again. The page explains that until a domain is verified, a SAML login whose email already has an
  account is refused, and once it is verified such logins link to that account. Its SAML-off notice
  names `auth.sso.saml.enabled` in supatype.config.ts, then a restart of `supatype dev`.

### Bug Fixes

* **auth:** the Users provider filter offers each SAML provider by name, `sso:acme`, and lists the
  users who signed in through it. It offered only the providers switched on in the config, so a
  user with an `sso:acme` badge could not be filtered to. A provider is offered for as long as it
  is set up, whether SAML is on or not, so its users can still be found.
* **auth:** the Users list and a user's linked identities name a SAML user's identity provider,
  `sso:acme`, where they showed `sso:` and the provider's full ID. A provider that has been removed,
  or was added without a name, is shown by the first block of its ID.
* **auth:** a viewer can open the SSO page, read-only, as a developer can. It refused them with
  "can't manage the project's users". Editors still have no SSO page.
* **auth:** the Configuration page says SAML SSO is set by `auth.sso.saml.enabled` in
  supatype.config.ts or `SUPATYPE_SAML_ENABLED` in `.env`. It said the variable could only be set in
  the auth server's environment, which was true while the compose file did not pass it.
* **logs:** the API logs page says request logging is coming soon, as the other unbuilt log pages
  do. It mounted a log table with search and filters over a list that never filled, which read as a
  project nobody had called.
* **records:** a record path whose id names no record shows "not found" in place of an edit form.
  `/models/post/access` read `access` as a record id and opened an empty form under Postgres's
  `invalid input syntax for type uuid: "access"`; a well-formed id with no row behind it opened the
  same empty form. Both are now a not-found page, built on a shared `PageError` primitive.
* **validation:** count messages agree with their number: "at least 1 item", "1 character or
  fewer", rather than "at least 1 items". Covers the Rules tab, the form's own bound checks and the
  database's too-long refusal.
* **connect:** the Next.js server-client snippets match how `@supatype/ssr` refreshes. The App
  Router one, for Server Components, has no `setAll`, so its client never refreshes the session and
  spends no refresh token the browser holds; it had an empty `setAll` that claimed middleware
  handled it. The Pages Router one writes the session cookie in `setAll`, which `@supatype/ssr`
  calls when it refreshes a session; it wrote the value unencoded and dropped `Max-Age` and
  `SameSite`.

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
