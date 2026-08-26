# Agent instructions

This package holds the subscription-usage code shared by two applications:
LearnWhale (`~/learn_whale`, consumed by `automation/`) and my-claw
(`~/my-claw`, consumed by `server/`). It was extracted because both repositories
carried copies that drifted 527 lines apart while a code comment was the only
thing asking anyone to keep them in sync.

## After landing a change here

Consumers pin a specific commit, so a change here reaches nobody until they are
bumped. Once a change lands on `main`, **offer to bump both consumers**, naming
the new commit. Do not bump one and leave the other: divergence between them is
the problem this repository exists to prevent.

In each consumer:

```
make sync-usage
```

That runs `npm install` against the new commit and updates both `package.json`
and the lockfile together. A policy test in each repository fails if the
dependency spec is anything other than a `git+https` URL pinned to a full
40-character commit, so a half-finished bump cannot land quietly.

## Editing from a consumer

The installed copy under a consumer's `node_modules/` is not editable. It is
gitignored, so a change there produces no diff, and the next `npm ci` erases it.
A needed change means a pull request here first, then a bump.

## Scope

This package owns vendor access and machine-local inventory: the providers, the
usage cache, the subscription reader, and the file and process helpers they
share.

It does not own scheduling, dispatch, eligibility scoring, or budget math, which
belong to LearnWhale; nor HTTP routes, the refresh worker, or UI, which belong to
my-claw. Freshness policy belongs to the caller — the two disagree deliberately,
and `Freshness` in `src/cache/store.ts` explains why.

## Conventions

- Node 24, ESM, TypeScript 6.0.3. All three repositories pin the same compiler,
  guarded by a version-consistency test in each consumer, because this package
  ships raw TypeScript that each consumer type-checks with its own `tsc`.
- No build step. `exports` point at `.ts` sources; both consumers run under
  `tsx`, which transforms them under `node_modules`. Plain Node does not.
- Providers never throw. Every failure becomes an `unavailableSnapshot`.
- Every external surface — `fetch`, the filesystem, the clock, the lock — is
  injectable, so tests touch neither the network nor real credentials.
- Run `make lint`, `make check`, and `make test` before pushing.
