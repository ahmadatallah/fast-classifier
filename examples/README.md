# Examples

Config discovery order is: `--config <path>` → `fast-classifier.config.ts` → `.mjs` → `.js` → `.json` in the working directory → built-in defaults. Copy any of these next to where you run the CLI and edit the maps to your senders.

Tokens never go in config files — the loader rejects them. Export `FASTMAIL_API_TOKEN` (JMAP) or `FASTMAIL_MCP_TOKEN` (MCP) in your environment instead.

## Gallery

### [`fast-classifier.config.ts`](fast-classifier.config.ts) — the full German-power-user config

The (anonymized) rule set that reached 87% coverage on the origin 6,551-email inbox: 14 categories, 81 domain rules built with a small `domains()` helper, 3 display-name rules for relay senders that carry no domain signal, a keep-list, and `personalDomains` so mail from your own domains files as Personal.

### [`fast-classifier.config.json`](fast-classifier.config.json) — the JSON twin

The exact same config as plain JSON, for setups that cannot load TypeScript configs. Nothing is lost in translation: rule patterns are plain strings in every format (the schema compiles them to case-insensitive regexes), so the JSON and TS files parse to identical configs.

## Minimal variants

### Sweep-only

Just clear the newsletter backlog — no categories, no filing:

```ts
// fast-classifier.config.ts
import { defineConfig } from 'fast-classifier/config'

export default defineConfig({
  // senders that must never be swept, even when their mail says "unsubscribe"
  keepList: ['alerts@example.com', 'billing@example.org'],
  sweep: { targetLabel: 'Promotion' },
})
```

```sh
fast-classifier sweep            # dry run — check the report and top swept senders
fast-classifier sweep --execute
```

### Needs-action-only

Only surface mail that likely needs a human response, over a shorter window:

```ts
// fast-classifier.config.ts
import { defineConfig } from 'fast-classifier/config'

export default defineConfig({
  needsAction: { label: 'Needs action', threshold: 3, windowDays: 30 },
})
```

```sh
fast-classifier needs-action                     # score and list candidates
fast-classifier needs-action --apply --execute   # additionally tag them (never archives)
```

The built-in scorer is bilingual EN+DE; override `needsAction.highKeywords` / `exclusionKeywords` (arrays of `{ phrase, weight }`) to tune it.

### MCP transport

Use Fastmail's official MCP endpoint instead of JMAP — same rules, different transport:

```ts
// fast-classifier.config.ts
import { defineConfig } from 'fast-classifier/config'

export default defineConfig({
  provider: { type: 'mcp' },
  categories: [{ name: 'Dev', label: 'Inbox/Dev' }],
  rules: [{ kind: 'domain', domain: 'github.com', category: 'Dev' }],
})
```

```sh
export FASTMAIL_MCP_TOKEN=...   # NOT the JMAP token — distinct credential
fast-classifier plan
```

MCP trade-offs (handled automatically, listed in the README quirks appendix): search pages cap at 50, keep-list negation is re-checked client-side, and labels are auto-created by `addLabels` rather than created explicitly. You can also flip transports per run with `-p mcp` / `-p jmap`.
