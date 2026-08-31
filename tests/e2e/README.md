# Browser end-to-end tests

Playwright, Chromium only, driving a **running** stack.

## Running them

```sh
bash tests/integration/scripts/studio-ui-e2e.sh
```

That brings compose up, creates a Studio admin, and runs the suite. To drive a
stack you already have:

```sh
cd tests/e2e
E2E_BASE_URL=http://127.0.0.1:18473 pnpm e2e
pnpm e2e:headed          # watch it happen
pnpm report              # the HTML report from the last run
pnpm install:browser     # first time, or in CI
```

## Why these tests exist

The rest of the repository tests Studio's **server** surface: the bundle is
served with a 200, `/studio/session` answers, `/studio-config` answers. All of
that stays green through a bundle that loads and then throws, an asset referenced
at the wrong base path, or a sign-in form wired to nothing.

So these assert what a person would notice: the page renders, its assets come
from the path it is mounted on, a wrong password is refused, and a right one gets
you in.

## Two conventions worth keeping

**No `webServer` block.** The integration scripts already know how to bring a
stack up, and a second way to start the same thing is a second thing to keep in
step. Point `E2E_BASE_URL` at a stack instead.

**The script is `e2e`, not `test`.** A script called `test` joins turbo's default
test pipeline, where it fails: that pipeline provides no stack. Naming it `e2e`
keeps `pnpm turbo run test` meaning "the tests that need nothing".

## Expected non-200s

Two 4xx are states, not faults, and the specs allow exactly these:

| | |
|---|---|
| `401` before sign-in | the point of the sign-in page |
| `404 /studio-config` | "schema not pushed yet" — a project with no generated admin config genuinely is that, and Studio reads it and carries on |
