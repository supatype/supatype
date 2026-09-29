# Changelog

## Unreleased

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
