# fast-classifier

Deterministic, rule-first email classifier for Fastmail: sweep newsletters, file everything into labels, flag what needs action — dry-run first, never deletes.

[![CI](https://github.com/ahmadatallah/fast-classifier/actions/workflows/ci.yml/badge.svg)](https://github.com/ahmadatallah/fast-classifier/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

fast-classifier was born from a live session that organized a real 6,551-email inbox: 3,849 newsletters swept in one run, 5,573 emails filed into 14 labels, and 87% rule coverage reached by iterating recon reports instead of training anything. The one-off scripts from that session are preserved read-only in [`reference/`](reference/); this repo is those scripts hardened into a typed, tested library with a CLI and an MCP server. Every core concept below shipped from that session.

**[▶ Watch the 20-second demo](https://ahmadatallah.github.io/fast-classifier/fast-classifier.mp4)** — the whole pitch in one terminal session (also attached to the [v0.1.0 release](https://github.com/ahmadatallah/fast-classifier/releases/tag/v0.1.0)).

## Safety model

Read this before installing — it is the point of the project.

- **Dry-run by default.** Every mutating command plans and reports but writes nothing until you pass `--execute`. Dry runs print a `DRY RUN — no changes will be made (pass --execute to apply)` banner, and in dry-run mode the provider is wrapped in a proxy whose mutating methods _throw_ — a planning-pass bug physically cannot mutate mail.
- **The never-delete guarantee.** The `MailProvider` interface has no delete methods and never will. The JMAP layer additionally runtime-asserts that no request carries a `destroy` key before any bytes leave the process. `archive()` only removes the Inbox label (and adds Archive) — the worst any bug can do is mislabel or archive mail, never lose it.
- **Confirmation above 100 mutations.** A run planning more than 100 mutations prompts for confirmation. `--yes` skips the prompt; a non-interactive run without `--yes` refuses the whole batch (`sweep`/`file` then exit 1).
- **`--max` cap.** Every scanning command accepts a hard cap on emails scanned per run.
- **Append-only TSV audit + resume.** `sweep` and `file` log every mutated email id to an append-only TSV _before_ the next batch runs, so an interrupted run resumes without duplicating work.
- **Tokens live in the environment only.** The config loader rejects secret-shaped keys and token-shaped values in config files, and errors/reports pass through a redaction chokepoint.
- **MCP-server writes are gated.** The MCP server forces every tool into dry-run unless started with `--allow-execute` (or `FAST_CLASSIFIER_ALLOW_WRITES=1`), and marks forced results with `forcedDryRun: true`.

## Quickstart

Not yet on npm — install from a clone (bun ≥ 1.1):

```sh
git clone https://github.com/ahmadatallah/fast-classifier.git
cd fast-classifier
bun install
bun run build && bun link   # puts `fast-classifier` and `fast-classifier-mcp` on your PATH
```

(Or skip building and run straight from source: `bun src/cli/main.ts <command>`.)

**Get a scoped Fastmail token.** In Fastmail: Settings → Privacy & Security → Integrations → API tokens. Scope it to **Mail read + write only** — no contacts, calendars, files, or sending. Use a read-only token if you only run `analyze`/`plan`. Note: the JMAP API token and the MCP endpoint token are **different credentials** — one does not work against the other's endpoint.

```sh
cp .env.example .env        # bun loads .env automatically; otherwise export in your shell
export FASTMAIL_API_TOKEN=...   # JMAP transport (the default)
export FASTMAIL_MCP_TOKEN=...   # MCP transport (-p mcp)
```

**The canonical loop** — recon, build **your** rules from **your** inbox, then execute:

```sh
fast-classifier init                # writes a starter fast-classifier.config.ts
fast-classifier analyze             # read-only recon: top senders and root domains
fast-classifier suggest             # match your top domains against the built-in catalog:
                                    # rule suggestions + unknown domains + paste-ready fragment
# paste the accepted suggestions into fast-classifier.config.ts
fast-classifier plan                # coverage % + top unmatched senders
# add rules for the unmatched senders and unknown domains, re-run plan — iterate
fast-classifier sweep               # dry run — inspect the report
fast-classifier sweep --execute     # label + archive bulk mail
fast-classifier file --execute      # file everything the rules match
fast-classifier needs-action        # score what likely needs a human reply
fast-classifier verify --cleared newsletter@example.com --label 'Inbox/Dev>=1'
```

## Core Concepts

### 1. The MCP Handshake (`src/provider/mcp`)

**What:** a hand-rolled, dependency-free client for Fastmail's official MCP endpoint (Streamable HTTP): captures the server-issued `mcp-session-id` header and echoes it on every later call, sends the dual `Accept: application/json, text/event-stream` header the server requires, parses SSE `data:` frames by taking the last JSON line, unwraps `structuredContent` (falling back to the text body), and converts `isError` results into typed transport errors.
**Origin:** a faithful, typed port of the session script `reference/mcp.mjs` that did all 9,400+ mutations.
**Quirk it encodes:** Fastmail wraps even single results in SSE frames — and the MCP token is a _distinct credential_ from the JMAP token.

### 2. The JMAP Client (`src/provider/jmap`)

**What:** session discovery (`apiUrl` + primary mail account), batched `methodCalls` (`Email/query` + `Email/get` chained by back-reference in one round trip), and bulk `Mailbox/set` label creation with client ids `c0, c1, …` plus modal-parent inference — new labels nest under whatever parent your existing labels use most.
**Origin:** the session's label-creation probes (`reference/jmapcreate.mjs`, `colortest.mjs`).
**Quirks it encodes:** `created`/`notCreated` partial results are surfaced per label name; label _color_ is not settable over JMAP (the session tried); Fastmail signals per-record throttling as a `SetError` of type `rateLimit` inside `notUpdated`/`notCreated` rather than HTTP 429 — the client converts it into the same backoff path.

### 3. The Rule-Based Classifier (`src/classify`)

**What:** a pure function `(sender) -> category | null` with 5-tier precedence: exact sender → registrable root domain → display-name rules on relay domains → relay account/personal fallbacks → your own domains. No state, no network, no ML.
**Origin:** 87% of 6,551 emails filed with zero machine learning — just rules iterated against recon reports.
**Quirk it encodes:** the session's naive `slice(-2)` domain split called `amazon.co.uk` "`co.uk`" — fixed with public-suffix-aware [tldts](https://github.com/remusao/tldts) and locked in by regression tests.

### 4. The Newsletter Sweep (`src/pipeline/sweep.ts`)

**What:** full-text `unsubscribe` heuristic in, keep-list out, label + archive. The keep-list is enforced **twice**: as a server-side `notFrom` filter _and_ re-checked client-side against every result.
**Origin:** 3,849 newsletters swept in one run, zero keepers lost.
**Quirk it encodes:** Fastmail's `-from:` search operator takes literal addresses only — domain negation is silently ignored — so the client-side re-check is mandatory, not defensive. An empty keep-list logs a warning.

### 5. The Inbox Filer (`src/pipeline/file.ts` + `src/provider/paging.ts`)

**What:** the shared read loop with a seen-set (nothing yielded twice), stall detection (consecutive all-seen pages → backoff, then stop), and careful cursor arithmetic split into two modes — `drain` (cursor advances only past items deliberately skipped) and `scan` (plain offset paging for read-only passes).
**Origin:** the session's hard-won answer to a trap: offset paging collapses when you mutate the very result you are paging — archiving shifts the window and the search re-serves already-processed ids.
**Shipped refinement:** pipelines _collect_ the full plan in `scan` mode, then execute — so dry-run and `--execute` see the identical plan.
**Quirks it encodes:** the 50-item MCP search cap, and servers that answer either with a bare array or `{ items: [...] }`.

### 6. The Needs-Action Scorer (`src/classify/needs-action.ts`)

**What:** a weighted keyword score over subject + snippet + sender name: 63 EN+DE phrases at **+3** ("action required", "deadline", "Frist", "Mahnung", …), 22 receipt/shipping/newsletter exclusions at **−2**, unread **+1**, personal-sender-awaiting-reply **+4**, threshold **3**, over a 60-day window.
**Origin:** surfaced the handful of emails needing a human among thousands.
**Quirk it encodes:** bilingual by necessity — a German inbox scores "Frist" exactly like "deadline".

### 7. Recon & Plan (`src/pipeline/analyze.ts`, `src/pipeline/plan.ts`)

**What:** read-only aggregation by sender and public-suffix-aware root domain, coverage %, and the top-unmatched-senders list.
**Origin:** the flywheel that reached 87% — run `plan`, add rules for the top unmatched senders, run `plan` again. No mutations at any point.

### 8. The Human-Sender Detector (`src/classify/human-sender.ts`)

**What:** "a human probably wrote this" = a spaced display name (`First Last`) AND an address that does not look automated (`no-reply`, `notifications@`, `billing@`, …) AND no big-brand token in address or name.
**Origin:** the difference between archiving a receipt and archiving your accountant.

### 9. The Verification Harness (`src/pipeline/verify.ts`)

**What:** post-run assertions — label exists / has exactly N / at least N emails, keep-senders still present in the inbox, cleared-senders gone. Read-only by construction.
**Origin:** every session run ended by proving it did what the plan said.

### 10. Ops Conventions (`src/provider/batching.ts` + `src/audit`)

**What:** mutations chunked at ≤ 50 per batch, 220 ms pacing between chunks, rate-limit retries with growing backoff, 1200 ms stall backoff in the pager, progress logged every 5 chunks, append-only TSV audit, JSON report per command.
**Origin:** 9,400+ mutations without a rate-limit death spiral.

## Transports

|                    | JMAP (default)                                      | MCP                                                      |
| ------------------ | --------------------------------------------------- | -------------------------------------------------------- |
| Token env var      | `FASTMAIL_API_TOKEN`                                | `FASTMAIL_MCP_TOKEN`                                     |
| Endpoint           | `api.fastmail.com/jmap/session`                     | `api.fastmail.com/mcp` (official)                        |
| Page size          | 100                                                 | 50 — server hard cap                                     |
| Keep-list negation | full server-side `NOT` filter                       | `-from:` literal addresses only; re-checked client-side  |
| Label creation     | explicit `Mailbox/set` (nested paths, modal parent) | no create tool — `addLabels` auto-creates missing labels |
| Search totals      | real totals (`calculateTotal`)                      | none (position-only paging)                              |

Pick with `-p jmap` / `-p mcp` or `provider.type` in config. The tokens are distinct credentials — see Quickstart.

## Configuration

```ts
// fast-classifier.config.ts
import { defineConfig } from 'fast-classifier/config'

export default defineConfig({
  categories: [{ name: 'Dev', label: 'Inbox/Dev' }],
  rules: [{ kind: 'domain', domain: 'github.com', category: 'Dev' }],
  keepList: ['important@example.com'],
  sweep: { targetLabel: 'Promotion' },
  needsAction: { label: 'Needs action', windowDays: 60 },
})
```

Discovery order: explicit `--config <path>` → `fast-classifier.config.ts` → `.mjs` → `.js` → `.json` in the working directory → built-in defaults. JSON configs work identically (rule patterns are plain strings in every format, so nothing is lost). Config files must never contain credentials — the loader rejects secret-shaped keys and token-shaped values.

**Build your config from your inbox.** `fast-classifier suggest` (or the `suggest_rules` MCP tool, or `suggestRules`/`toConfigFragment` from the library) scans your inbox read-only, matches uncovered root domains against a built-in catalog of well-known senders in 12 generic categories, and prints a paste-ready config fragment — anything not in the catalog is listed as unknown for you to decide. The defaults stay generic on purpose: the needs-action scorer's keyword packs are English-only unless you opt in with `needsAction: { languages: ['en', 'de'] }` (explicit `highKeywords`/`exclusionKeywords` replace the packs), and `detection.brandNamePattern` defaults to global household names — override it with your regional brands.

See [`examples/`](examples/) for a full real-world config — the German-power-user setup that reached 87% coverage, with the bilingual packs and the full brand-pattern override — plus its JSON twin and minimal variants.

## MCP server mode

`fast-classifier-mcp` runs an MCP server on stdio: it loads the config from the working directory, connects the configured provider, and reads the matching token from the environment. Register it with an MCP client, e.g.:

```sh
claude mcp add fast-classifier \
  --env FASTMAIL_API_TOKEN=your-jmap-token \
  -- fast-classifier-mcp
```

Tools (11): `classify_sender`, `analyze_inbox`, `plan_classification`, `suggest_rules`, `sweep_newsletters`, `file_inbox`, `score_needs_action`, `list_labels`, `ensure_labels`, `verify_run`, `get_effective_config`.

Mutating tools default to `dryRun: true` — the intended agent loop is call dry, inspect the report, then pass `dryRun: false`. Unless the server was started with `--allow-execute` (or `FAST_CLASSIFIER_ALLOW_WRITES=1`), `dryRun` is forced true regardless of arguments and results carry `forcedDryRun: true`, so agents can tell the difference between "planned" and "cannot execute". Human-facing output goes to stderr; stdout carries the protocol.

## CLI reference

```
fast-classifier [global options] <command>
```

Global options (accepted before or after the subcommand):

| Flag                    | Meaning                                                             |
| ----------------------- | ------------------------------------------------------------------- |
| `-c, --config <path>`   | path to `fast-classifier.config.{ts,mjs,js,json}`                   |
| `-p, --provider <type>` | mail transport: `jmap` or `mcp` (default: from config)              |
| `--execute`             | apply changes — mutating commands are dry-run by default            |
| `--max <n>`             | cap on emails scanned per run                                       |
| `--yes`                 | skip confirmation prompts for large mutation batches                |
| `--json`                | print the full report JSON to stdout instead of a summary           |
| `--report-dir <dir>`    | directory for reports and audit logs (default `./.fast-classifier`) |

Commands:

| Command                                                                      | Description                                                                                                                                                                      |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `analyze`                                                                    | read-only recon: who fills the inbox, by sender and root domain                                                                                                                  |
| `plan`                                                                       | classify without touching anything: coverage + unmatched senders                                                                                                                 |
| `suggest [dir] [--interactive] [--no-interactive] [--write]`                 | read-only scan: suggest config rules for your senders from the built-in domain catalog, plus a paste-ready config fragment                                                       |
| `sweep`                                                                      | label + archive bulk mail (keep-list wins; dry-run by default); audits to `sweep.log.tsv`                                                                                        |
| `file`                                                                       | file classified mail into per-category labels (dry-run by default); audits to `file.log.tsv`                                                                                     |
| `needs-action [--apply]`                                                     | score the recent window for mail needing a human response; `--apply` tags candidates with the needs-action label (never archives) — tagging requires `--apply` _and_ `--execute` |
| `labels list`                                                                | list labels with email totals                                                                                                                                                    |
| `labels ensure <names...>`                                                   | create the given labels if missing, nested as `'Parent/Child'` (dry-run by default)                                                                                              |
| `verify [--contains <addrs...>] [--cleared <addrs...>] [--label <specs...>]` | post-run assertions; label specs are `'Name'` (exists), `'Name=N'` (exactly N), `'Name>=N'` (at least N)                                                                         |
| `init [dir] [--from-inbox]`                                                  | write a starter `fast-classifier.config.ts` (refuses to overwrite); `--from-inbox` builds it from your inbox's suggestions instead                                               |
| `mcp`                                                                        | run the MCP server on stdio — prefer the standalone `fast-classifier-mcp` bin                                                                                                    |

Every command writes `<command>-report.json` (credentials redacted) into the report dir and echoes the path on stderr. Exit code 1 on errors, on failed `verify` checks, and when a `sweep`/`file` run is aborted by a declined confirmation.

## Fastmail API quirks appendix

Everything the session learned the hard way, all encoded in code and tests:

1. **50-item search cap (MCP).** `search_email` hard-caps at 50 per page; JMAP pages at 100. Expressed as `caps.maxPageSize`, clamped everywhere.
2. **Array vs `{ items }`.** The MCP server answers either with a bare array or `{ items: [...] }` for the same tool. Adapters normalize both.
3. **ISO-only `after:`.** `after:YYYY-MM-DD` is the only date operator Fastmail search reliably accepts.
4. **`-from:` is literal-address-only.** Domain negation is silently ignored — keep-lists must be re-checked client-side (`caps.serverSideNotFrom: 'address-only'`).
5. **Spaced values need quoting in the search DSL.** Unquoted, `in:Needs action` parses as `in:Needs` plus a free-text term `action` — silently wrong scope. The query builder double-quotes any value containing whitespace.
6. **`addLabels` auto-creates labels (MCP).** There is no create-label tool, but `update_email` `addLabels` auto-creates missing labels. `ensureLabels` pre-flights stay as typo protection.
7. **Archive ≠ `removeLabels: ['Inbox']`.** The server rejects removing Inbox via `removeLabels`; `archive_email` (MCP) / the paired inbox-null + archive-true patch (JMAP) is the sanctioned path.
8. **Label color is not settable via JMAP.** The session tried; Fastmail ignores it.
9. **Distinct tokens.** The JMAP API token and the MCP endpoint token are different credentials.
10. **`rateLimit` SetError backoff.** Fastmail signals per-record throttling as a `SetError` of type `rateLimit` in `notUpdated`/`notCreated`, not HTTP 429. Both are converted into the same retry/backoff path.
11. **MCP handshake details.** Capture-and-echo `mcp-session-id`, dual `Accept` header required, SSE `data:` frames even for single results, `structuredContent` unwrap with text-body fallback, rate limiting reported as a tool _error text_, not a status code.
12. **JMAP sort tie-break limitation.** No total-order tiebreaker exists among JMAP's standard sort properties, so equal `receivedAt` values at a page boundary can reorder between calls; the pager's seen-set and audit-resume pattern recover anything stepped over.

## Development

```sh
bun test            # 287 tests, no network — everything runs against MemoryMailProvider
bun run typecheck   # strict tsc (exactOptionalPropertyTypes, noUncheckedIndexedAccess)
bun run lint        # eslint + prettier check
bun run hygiene     # credential/PII gate (also runs in CI)
bun run build       # emits dist/ for plain Node (>= 20)
```

`reference/` holds the origin session's scripts — read-only ground truth for behavior questions; never edit them.

### Documentation site

`docs/` is an [Astro Starlight](https://starlight.astro.build) site: the narrative guides plus an API reference generated straight from the source by [starlight-typedoc](https://starlight-typedoc.vercel.app) — one theme, one sidebar, one search index.

```sh
bun install                       # once, at the repo root (bun workspaces)
cd docs && bunx --bun astro dev   # live-reloading docs at localhost:4321
cd docs && bunx --bun astro build # static site in docs/dist/
```

CI builds the site on every push (`.github/workflows/docs.yml`); deployment to GitHub Pages is parked until the repo is public — the workflow file documents the one-step re-enable.

- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md)
- Security policy: [SECURITY.md](SECURITY.md)
- License: [MIT](LICENSE)

Built with Claude Code from a real inbox-organizing session.
