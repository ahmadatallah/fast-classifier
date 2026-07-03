# Contributing to fast-classifier

Thanks for helping. This project has one non-negotiable: **nothing may ever delete mail.** Everything else below exists to keep that true while staying pleasant to work on.

## Setup

Requires [bun](https://bun.sh) ≥ 1.1 (the toolchain; the built package also runs on Node ≥ 20).

```sh
git clone https://github.com/ahmadatallah/fast-classifier.git
cd fast-classifier
bun install
bun test
```

## Command cheatsheet

| Command                  | What it does                      |
| ------------------------ | --------------------------------- |
| `bun test`               | full suite (fast, no network)     |
| `bun test test/classify` | scoped run while iterating        |
| `bun run typecheck`      | strict `tsc --noEmit`             |
| `bun run lint`           | eslint + prettier check           |
| `bun run format`         | prettier write                    |
| `bun run hygiene`        | credential/PII gate (CI-enforced) |
| `bun run build`          | emit `dist/`                      |
| `bun run coverage`       | tests with coverage               |

Style is enforced, not debated: prettier (no semicolons, single quotes, print width 100), strict TypeScript (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), ESM NodeNext (relative imports need the `.js` extension). Comments only for non-obvious constraints. An eslint boundary rule keeps core code (`src/` outside `cli/` and `mcp-server/`) from importing either shell.

## Test conventions

- `bun:test`, files under `test/` mirroring `src/` (`src/classify/rules.ts` → `test/classify/rules.test.ts`).
- **Never hit the network.** Use `MemoryMailProvider` and `makeEmail` from `src/provider/memory.ts` — it faithfully reproduces paging-under-mutation — or injected fakes (see `test/provider/jmap/fake-fetch.ts`).
- Never wait on real timers: paging/batching accept an injectable `sleep`; pipelines thread `ctx.sleep`.
- Test fixtures may use addresses on real brand domains (paypal.de and friends) — that is the subject matter. Docs, examples, and Markdown files must stick to `example.com`-style addresses (the hygiene gate enforces this).

## Safety invariant checklist for PRs

Every PR touching pipelines or providers must keep all of these true:

- [ ] **Mutations flow only through `executeActions()` / `MailProvider` methods.** No pipeline calls a transport directly, and no new mutating method lands on `MailProvider` without the same dry-run + audit treatment. Never add a delete/destroy capability in any form.
- [ ] **The dry-run proxy is respected.** Pipelines obtain their read side via `readProvider(ctx)`; in dry-run mode mutators throw `DryRunViolation`, and code must be structured so that guarantee holds (collect via `scan`, then execute — see the MODE CONTRACT in `src/provider/paging.ts`; non-mutating passes must never use `drain` mode).
- [ ] **A zero-mutation dry-run test is required** for any new or changed pipeline: run it with `dryRun: true` against a `MemoryMailProvider` and assert the provider's state is byte-for-byte unchanged (see `test/pipeline/dry-run.test.ts`).
- [ ] **`bun run hygiene` passes.** No tokens, no bearer strings, no personal domains, docs/examples emails on documentation-safe domains only.

Plus the mechanical gates: `bun test`, `bun run typecheck`, `bun run lint` all green.

## Adding a category or domain rule

Default detection lists live in `src/config/defaults.ts`; user-facing rules belong in config files. To extend the defaults (e.g. a new brand token or relay domain) or to fix a misclassification:

1. Add the entry in `src/config/defaults.ts` (keep the list comments accurate — several encode session-learned pitfalls, like trailing-space phrases).
2. Lock it with a regression test in `test/classify/rules.test.ts` (or `needs-action.test.ts` / `human-sender.test.ts`), building the exact scenario:

```ts
import { classifierConfigSchema } from '../../src/config/schema.js'
import { compileConfig } from '../../src/config/compile.js'
import { classify } from '../../src/classify/rules.js'
import { rootDomain } from '../../src/classify/domain.js'

// public-suffix aware: the origin session's naive split called amazon.co.uk 'co.uk'
expect(rootDomain('mail.amazon.co.uk')).toBe('amazon.co.uk')

const config = classifierConfigSchema.parse({
  categories: [{ name: 'Stores', label: 'Inbox/Stores' }],
  rules: [{ kind: 'domain', domain: 'example.com', category: 'Stores' }],
})
const match = classify({ email: 'orders@shop.example.com', name: 'Shop' }, compileConfig(config))
expect(match?.category).toBe('Stores') // subdomains resolve to the registrable root
```

3. If the behavior differs from the origin session scripts, check `reference/` first — those `.mjs` files are read-only ground truth, and deliberate deviations get a comment explaining why (see the `'sign '` note in `defaults.ts`).

## Questions

Open a discussion or issue. For anything security-sensitive, follow [SECURITY.md](SECURITY.md) instead.
