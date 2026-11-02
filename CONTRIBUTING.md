# Contributing

Thank you for helping with Supatype. This file covers the agreement contributions need and the
checks a pull request has to pass.

## Contributor License Agreement

Every contribution needs a signed [Contributor License Agreement](CLA.md) (CLA). You sign it once,
through **CLA Assistant**, on your first pull request: the bot comments with a link, and the pull
request can merge once you have signed. The same agreement covers every Supatype repository,
including the schema engine.

In plain words:

- The CLA is a **licence grant, not an assignment**. You keep the copyright in your contribution.
- You grant Supatype Ltd a licence to use, distribute and relicense your contribution. Supatype
  needs that because the schema engine is offered under the Business Source License, under
  commercial terms, and under Apache 2.0 once each version reaches its Change Date, and because
  the packages in this repository are MIT or Apache 2.0.
- Contributing gives you no rights in Supatype's products beyond what their licences already give
  everyone.

If you contribute for an employer, your employer may need to sign a corporate agreement as well.
Ask at [licensing@supatype.com](mailto:licensing@supatype.com). The
[licensing page](https://www.supatype.com/licensing.html) explains what each licence allows.

## Licences in this repository

Licensing is per package; each package directory has its own `LICENSE` file and `license` field.
The client libraries, framework bindings and plugins are MIT; the CLI, the services and the rest of
the repository are Apache 2.0. See [NOTICE](NOTICE). A contribution to a package is made under
that package's licence.

## Before you open a pull request

The repository is a Turborepo with pnpm workspaces, and every package is ESM.

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm --filter @supatype/<package> test
```

- Add a test that fails without your change and passes with it.
- TypeScript runs with `exactOptionalPropertyTypes`: write optional properties as
  `...(x !== undefined && { key: x })`. Do not use `any`.
- Commit messages say what changed and why, with a conventional prefix such as `fix(cli):` or
  `docs:`.
- Describe any user-visible change in the pull request, so the release notes can carry it.
