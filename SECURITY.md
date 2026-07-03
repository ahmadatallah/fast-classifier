# Security Policy

## Supported versions

fast-classifier is pre-1.0. Only the latest 0.x release receives security fixes.

| Version        | Supported |
| -------------- | --------- |
| latest 0.x     | yes       |
| anything older | no        |

## Reporting a vulnerability

Please report vulnerabilities privately via **GitHub Security Advisories**: open the repository's _Security_ tab → _Report a vulnerability_. Do not open a public issue for anything that could expose users' mail or credentials. You should get a first response within a few days.

## Token scoping guidance

fast-classifier talks to your actual mailbox, so treat its credentials accordingly:

- Create tokens at Fastmail → Settings → Privacy & Security → Integrations → API tokens.
- Scope the JMAP token to **Mail read + write only** — no contacts, calendars, files, and no sending.
- Use a **read-only** token if you only run `analyze` / `plan` / `verify`.
- The JMAP API token and the MCP endpoint token are **distinct credentials**; keep both scoped.
- Tokens live in the environment only (`FASTMAIL_API_TOKEN`, `FASTMAIL_MCP_TOKEN`). The config loader actively rejects secret-shaped keys (`token`, `apiKey`, `password`, …) and token-shaped values in config files, so a credential cannot end up committed inside a config.
- Errors, reports, and MCP tool results pass through a redaction chokepoint that scrubs token-shaped strings and the current values of both token env vars.

## Threat model: the never-delete guarantee

The design goal is that no bug, misconfiguration, or prompt-injected agent can destroy mail:

- The `MailProvider` interface has **no delete or destroy methods**.
- The JMAP client runtime-asserts that no outgoing request carries a `destroy`-class key and throws before any bytes leave the process.
- `archive()` is the only sanctioned "removal": it drops the Inbox label and keeps every other label.
- Dry-run mode wraps the provider in a proxy whose mutating methods throw, mutating CLI commands require `--execute`, runs planning more than 100 mutations require confirmation, and the MCP server forces dry-run unless started with `--allow-execute`.

**Worst case under this model:** mail is mislabeled or archived — recoverable from All Mail / Archive — never lost. If you find any path that violates this (any way to destroy a message through this codebase), that is a security vulnerability; please report it as above.

## What the hygiene CI gate checks

`bun run hygiene` (`scripts/check-hygiene.mjs`) runs locally and in CI on every push, scanning all tracked and untracked-but-not-ignored files for:

- **Fastmail-shaped API tokens** (the `fmu1-…` format) — everywhere, in every file.
- **Bearer credentials** (long `Bearer`-prefixed strings) — everywhere. Test files that must plant a fake token opt out with a reviewed, grep-able marker comment.
- **Personal email domains** of the original author — everywhere.
- **Email addresses in docs and examples** must sit on documentation-safe domains (`example.com/org/net`, `*.example`, `*.test`, `*.invalid`). Classifier test fixtures may use real brand domains (that is the product's subject matter), but docs and examples may not carry real addresses.

A failed check fails the build, so credentials and PII cannot land on the default branch unnoticed.
