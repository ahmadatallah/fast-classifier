// The "German power-user" starter config — the (anonymized) rule set that
// reached 87% coverage on the origin 6,551-email inbox. Copy it next to your
// project as fast-classifier.config.ts and edit the maps to your senders.
//
// In your own project import from the package instead:
//   import { defineConfig } from 'fast-classifier/config'
import { defineConfig } from '../src/config/index.js'

const domains = (map: Record<string, string[]>) =>
  Object.entries(map).flatMap(([category, list]) =>
    list.map((domain) => ({ kind: 'domain' as const, domain, category })),
  )

export default defineConfig({
  categories: [
    { name: 'Paypal', label: 'Inbox/Paypal' },
    { name: 'Finance', label: 'Inbox/Finance' },
    { name: 'Work', label: 'Inbox/Work' },
    { name: 'Dev', label: 'Inbox/Dev' },
    { name: 'Travel', label: 'Inbox/Travel' },
    { name: 'Stores', label: 'Inbox/Stores' },
    { name: 'Telecom', label: 'Inbox/Telecom' },
    { name: 'Official', label: 'Inbox/Official', description: 'government, visa, tax' },
    { name: 'Jobs', label: 'Inbox/Jobs' },
    { name: 'Apartment', label: 'Inbox/Apartment' },
    { name: 'Health', label: 'Inbox/Health' },
    { name: 'Media', label: 'Inbox/Media' },
    { name: 'Accounts', label: 'Inbox/Accounts', description: 'sign-in and account notices' },
    { name: 'Personal', label: 'Inbox/Personal' },
  ],

  rules: [
    ...domains({
      Paypal: ['paypal.de', 'paypal.com'],
      Finance: [
        'revolut.com',
        'klarna.com',
        'klarna.de',
        'n26.com',
        'kraken.com',
        'stripe.com',
        'vivid.money',
        'schufa.de',
        'traderepublic.com',
        'wise.com',
        'coinbase.com',
        'splitwise.com',
      ],
      // your employer's domain files as Work
      Work: ['your-company.com'],
      Dev: [
        'github.com',
        'cloudflare.com',
        'heroku.com',
        'notion.so',
        '1password.com',
        'perplexity.ai',
        'docusign.net',
        'apple.com',
        'microsoft.com',
        'samsung.com',
        'openai.com',
        'vercel.com',
        'gitlab.com',
        'adobe.com',
      ],
      Travel: [
        'deutschebahn.com',
        'bahn.de',
        'flixbus.com',
        'trip.com',
        'eurowings.com',
        'airbnb.com',
        'uber.com',
        'bolt.eu',
        'free-now.com',
        'tier.app',
        'ryanairemail.com',
        'vueling.com',
        'gotogate.com',
        'airhelp.com',
      ],
      Stores: [
        'amazon.de',
        'amazon.com',
        'zalando.de',
        'backmarket.com',
        'lieferando.de',
        'mediamarkt.de',
        'refurbed.com',
        'dhl.de',
        'myhermes.de',
        'ups.com',
      ],
      Telecom: ['o2.de', 'o2online.de', 'ionos.de', 'fastmail.com', 'vodafone.com'],
      Official: ['hamburg.de', 'tlscontact.com', 'taxfix.de'],
      Jobs: ['linkedin.com', 'honeypot.io', 'xing.com', 'personio.de'],
      Apartment: ['immomio.de', 'housinganywhere.com', 'immowelt.de', 'immoscout24.de'],
      Health: ['tk.de', 'urbansportsclub.com', 'doctolib.de'],
      Media: [
        'substack.com',
        'netflix.com',
        'audible.de',
        'steampowered.com',
        'ea.com',
        'discord.com',
        'bandcamp.com',
      ],
      Accounts: ['instagram.com', 'x.com'],
    }),

    // Relay/aggregator senders (Apple private relay, gmail-hosted services…)
    // carry no domain signal — match the display name instead.
    { kind: 'name', pattern: 'bolt|wolt|free ?now|uber|tier|lime|miles|flix', category: 'Travel' },
    { kind: 'name', pattern: 'openai|vercel|github|cursor|warp|mapbox', category: 'Dev' },
    { kind: 'name', pattern: 'klarna|revolut|kraken|n26|stripe|paypal', category: 'Finance' },
  ],

  // exact senders that must never be swept, even when they say "unsubscribe"
  keepList: ['notifications@example.com', 'billing@example.org'],

  detection: {
    // mail from your own domains files as Personal
    personalDomains: ['your-domain.example'],
  },

  sweep: { targetLabel: 'Promotion' },
  needsAction: { label: 'Needs action', windowDays: 60 },
})
