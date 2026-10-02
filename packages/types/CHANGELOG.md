# Changelog

## Unreleased

### Breaking Changes

* **storage:** a bucket rule that is left out is refused, for every caller but the service role,
  the same as on a model. It used to mean "any signed-in user", so a bucket declaring only `read`
  and `create` let anyone signed in delete anyone's files. A bucket with no `access` at all now
  accepts no uploads. Declare each operation the bucket should allow; `supatype push` warns about
  each one left out.

### Features

* **storage:** `update` is a bucket rule, alongside `read`, `create` and `delete`, and governs
  overwriting an existing file (`x-upsert`). `BucketRule` names the union every operation takes.

* **access:** `After<TBase, TInterval>` and `Before<TBase, TInterval>` compose a base of `Now` or
  `StartOf<unit>` with a multi-unit interval, so "thirty days from now at 09:00" is expressible:
  `After<StartOf<"day">, { days: 30, hours: 9 }>`. `Ago` and `FromNow` carry a single amount and
  unit and could not say it. Both are unchanged and keep working; `After<Now, ...>` and
  `Before<Now, ...>` subsume them.

  The interval type is exact rather than merely assignable. A plain `extends TimeInterval`
  accepts `{ days: 30, dayz: 5 }`, because every unit is optional and excess property checking
  does not reach a type argument; the engine then reads the typo as absent and refuses the push,
  so the author hears about it minutes later instead of in the editor.

  The direction stays in the operand's name rather than becoming a signed number, because a
  negative amount reads as a double negative and the extractor already rejects one.
