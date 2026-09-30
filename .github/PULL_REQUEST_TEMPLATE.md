## What and why

<!-- What this pull request changes, and the problem it solves. Link the issue: "Closes #123". One topic per pull request. -->

## How it was tested

<!-- Commands you ran, cases you checked by hand. -->

## Checklist

- [ ] `npm run typecheck` and `npm test` pass (and `npm run test:ee` / `npm run check:core` when `ee/` or the extension points are touched)
- [ ] Schema changes ship as a new migration in `api/src/db/migrations/` with both `up` and `down`
- [ ] New behaviour comes with integration tests in `api/test/`
- [ ] `SPEC.md` is updated when an endpoint or a table changes
- [ ] No secret, API key or personal data in the code, the tests or the screenshots

## Contributor License Agreement

<!-- Required for your first pull request: keep the line below (see CONTRIBUTING.md and CLA.md). -->

I have read the CLA and I agree to its terms.
