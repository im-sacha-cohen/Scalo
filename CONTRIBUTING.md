# Contributing to Scalo

Thanks for helping! Scalo is an open-core project: everything outside `ee/` is licensed under the
[GNU AGPL-3.0](LICENSE); the `ee/` directory is source-available under a [commercial license](ee/LICENSE).

## Before you start

- **Bugs and small fixes**: open a pull request directly.
- **Features**: open an issue first so we can agree on scope before you write code.
- **Security issues**: do not open a public issue, see [SECURITY.md](SECURITY.md).

## Development setup

```bash
npm install
cp .env.example .env     # set JWT_SECRET
npm run db:up            # PostgreSQL 16 in Docker
npm run migrate
npm run seed             # demo account
npm run dev              # http://localhost:5173
```

## Pull request checklist

- `npm run typecheck` and `npm test` pass (tests run against a real PostgreSQL database, see `README.md`).
- Schema changes ship as a new migration in `api/src/db/migrations/` with both `up` and `down`.
- New behaviour comes with integration tests in `api/test/`.
- User-facing text is in French for now (internationalisation is on the roadmap).
- `SPEC.md` is updated when an endpoint or a table changes.
- One topic per pull request, with a description of what changed and why.

## Contributor License Agreement

We ask every contributor to agree to the [Contributor License Agreement](CLA.md). It lets the project
distribute your contribution under the AGPL-3.0 and also as part of the commercial edition, which funds
the development of the open-source core. You keep the copyright on your work.

You agree by adding this line to your first pull request description:

> I have read the CLA and I agree to its terms.

## Where things go

| Directory | Content | License |
|---|---|---|
| `shared/`, `api/`, `web/` | The product: funnels, emails, CRM, automations, payments, courses | AGPL-3.0 |
| `ee/` | Team and agency features (roles, audit log, white label) | Commercial |

Contributions to `ee/` are welcome under the same CLA. We do not move features from the core to `ee/`.
