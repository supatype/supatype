# Changelog

## 0.9.3

### Bug Fixes

* **postgres_changes payloads change shape.** Values now match what REST returns. `json` and `jsonb`
  columns arrive as the parsed value, where they were the JSON text. `timestamptz` arrives as ISO 8601,
  `2024-01-01T12:00:00+00:00`, where it was `2024-01-01 12:00:00+00`, which Safari and Firefox read as
  `Invalid Date`; `timestamp` is `2024-01-01T12:00:00` and `timetz` has a full offset. Microseconds
  are kept, and arrays of these types arrive as arrays. A value that cannot be read is passed on as it
  came. Code that called `JSON.parse` on a json column must stop.
