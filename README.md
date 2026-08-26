# subscription-usage

This package reads how much of each paid AI subscription has been consumed. It
talks to Anthropic, OpenAI, xAI, and Cursor using each CLI's own on-disk
credentials, normalizes the answers into a common `UsageSnapshot`, and caches
them so that several processes on one machine share a single reading instead of
competing for the same rate limit.

It exists because two applications need exactly this and used to keep separate
copies of it. LearnWhale's nightly automation uses it to decide which model
families it can still afford to dispatch work to. my-claw uses it to render a
usage panel. Both run on the same machine as the same user, so both are pointed
at the same cache.

## What it does not do

The package owns vendor access and machine-local inventory, and nothing else.
Scheduling, dispatch, eligibility scoring, and budget math belong to LearnWhale.
HTTP routes, the refresh worker, and the UI belong to my-claw. Freshness policy
belongs to whichever application is asking, because the two disagree on purpose:
LearnWhale refuses a stale reading because it gates spending, while my-claw
prefers a stale panel to an empty one.

## Commands

| Command | What it does |
| --- | --- |
| `make setup` | Install dependencies with `npm ci` |
| `make lint` | Run ESLint across the package |
| `make check` | Type-check with `tsc --noEmit` |
| `make test` | Run lint, then the type check, then the test suite |

## Exports

The package ships raw TypeScript with no build step, because both consumers run
their code through `tsx`. Imports are namespaced by path; there is no root
barrel export.

| Import | Contents |
| --- | --- |
| `@kfrance/subscription-usage/types` | `UsageSnapshot`, `UsageWindow`, `UsageProvider`, `unavailableSnapshot` |
| `@kfrance/subscription-usage/providers` | One provider class per vendor |
| `@kfrance/subscription-usage/cache` | `CachedUsageStore` and its options |
| `@kfrance/subscription-usage/subscriptions` | Reader for the machine-local subscription inventory |
| `@kfrance/subscription-usage/lib` | File locking, atomic writes, command execution |

## Configuration and state

The subscription inventory is read from
`${XDG_CONFIG_HOME:-~/.config}/learnwhale/subscriptions.toml`, overridable with
`LEARNWHALE_AUTOMATION_META_LOOP_SUBSCRIPTIONS_PATH`.

Cached readings live in
`${XDG_STATE_HOME:-~/.local/state}/learnwhale/ai-usage/`, one file per service,
overridable with `AI_USAGE_CACHE_DIR`. That directory is deliberately outside
either application's checkout so both processes find the same readings, and it
sits under `learnwhale/` because that is the path LearnWhale's unattended
automation sandbox already grants write access to.

## Consuming this package

Both applications depend on a specific commit rather than a version, because the
package is never published and carries no version number. See `AGENTS.md` for
how to change the pinned commit and what to do after landing a change here.
