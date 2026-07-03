/**
 * Built-in defaults, ported verbatim from the origin session that organized a
 * 6,551-email Fastmail inbox. Every list is overridable via config.
 */

export interface WeightedKeyword {
  phrase: string
  weight: number
}

const weigh = (weight: number, phrases: readonly string[]): readonly WeightedKeyword[] =>
  phrases.map((phrase) => ({ phrase, weight }))

/**
 * Needs-action keyword LANGUAGE PACKS. HIGH signals score +3 each; exclusions
 * (receipts, shipping, newsletters, confirmations) score -2 each. The origin
 * session's bilingual list is split by language so the generic default can be
 * English-only (needsAction.languages defaults to ['en']); German users opt in
 * with languages: ['en', 'de']. Trailing spaces in phrases are significant.
 *
 * Deviation from the origin list: the Dutch-ish stray 'actie' was dropped —
 * it belongs to neither pack.
 */
export const NEEDS_ACTION_PACKS: Record<
  'en' | 'de',
  { high: readonly WeightedKeyword[]; exclusion: readonly WeightedKeyword[] }
> = {
  en: {
    high: weigh(3, [
      'action required',
      'action needed',
      'please confirm',
      'confirm your',
      'verify your',
      'please verify',
      'identity',
      'respond',
      'response needed',
      'reply',
      'deadline',
      'overdue',
      'past due',
      'payment failed',
      'failed payment',
      'invoice',
      'reminder',
      'appointment',
      // deviation from the reference: the bare phrase 'sign ' matched mid-word
      // ('design update') — dropped; 'signature'/'to sign'/'docusign' (and the
      // German forms in the de pack) keep the coverage
      'signature',
      'docusign',
      'to sign',
      'complete your',
      'expires',
      'expiring',
      'renew',
      'renewal',
      'suspended',
      'kyc',
      'upload',
      'missing information',
      'outstanding',
      'rsvp',
      'interview',
      'confirm subscription',
      'update your payment',
      'last chance to',
    ]),
    exclusion: weigh(-2, [
      'receipt',
      'your order',
      'has shipped',
      'shipped',
      'delivered',
      'newsletter',
      'digest',
      'unsubscribe',
      'welcome to',
      'thanks for',
      'thank you for',
      'order confirmation',
      'payment received',
      'you paid',
      'has been sent',
      'statement is ready',
    ]),
  },
  de: {
    high: weigh(3, [
      'bestätige',
      'bestätigung',
      'antworten',
      'frist',
      'fällig',
      'überfällig',
      'zahlung fehlgeschlagen',
      'rechnung',
      'mahnung',
      'erinnerung',
      'zahlungserinnerung',
      'termin',
      'unterschrift',
      'unterschreiben',
      'zu unterschreiben',
      'vervollständigen',
      'läuft ab',
      'verlängern',
      'gesperrt',
      'nachweis',
      'ausstehend',
      'einladung',
      'bewerbung',
      'verifizieren',
      'zahlungsmethode',
      'abgelaufen',
    ]),
    exclusion: weigh(-2, [
      'quittung',
      'bestellung',
      'versand',
      'versandbestätigung',
      'zugestellt',
      'kontoauszug',
    ]),
  },
}

/**
 * @deprecated Full bilingual unions kept only for the package export surface;
 * the schema/compiler now resolve keywords from NEEDS_ACTION_PACKS via
 * needsAction.languages.
 */
export const DEFAULT_HIGH_KEYWORDS: readonly WeightedKeyword[] = [
  ...NEEDS_ACTION_PACKS.en.high,
  ...NEEDS_ACTION_PACKS.de.high,
]

/** @deprecated See DEFAULT_HIGH_KEYWORDS. */
export const DEFAULT_EXCLUSION_KEYWORDS: readonly WeightedKeyword[] = [
  ...NEEDS_ACTION_PACKS.en.exclusion,
  ...NEEDS_ACTION_PACKS.de.exclusion,
]

/**
 * Automated-sender detector (matched against the FROM ADDRESS): the inverse of
 * "a human wrote this".
 */
export const DEFAULT_AUTOMATED_PATTERN =
  'no.?reply|newsletter|notification|notifications|team@|support@|info@|hello@|service@|noreply|automated|updates?@|marketing|billing|invoice|receipt|do.?not.?reply|mailer|news@|@mail\\.|@email\\.|@e\\.|@em\\.|@updates?\\.|@notify'

/**
 * Big-brand detector (matched against address + display name). Trimmed from
 * the reference/human.mjs original to GLOBAL household names only — tokens a
 * random US/UK/EU user would recognize. The origin session's regional/niche
 * long tail (haspa, taxfix, lieferando, zalando, deutschebahn, instantdb,
 * val.town, …) moved verbatim into examples/fast-classifier.config.ts as a
 * detection.brandNamePattern override.
 */
export const DEFAULT_BRAND_PATTERN =
  'uber|linkedin|amazon|paypal|apple|google|github|klarna|revolut|kraken|stripe|netflix|substack|xing|bolt|airbnb|booking|fastmail|cloudflare|samsung|microsoft|audible|spotify|discord|steam|adobe|notion|slack|n26|dhl|ups'

/**
 * Exclusion for the needs-action "personal sender awaiting reply" bonus,
 * verbatim from reference/na-score.mjs (bare words on purpose — broader than
 * the @-anchored automated pattern, e.g. it excludes 'support' anywhere in
 * the address).
 */
export const DEFAULT_PERSONAL_REPLY_EXCLUSION_PATTERN =
  'no.?reply|newsletter|team|support|info|notification'

/** Freemail/consumer providers whose senders are likely people, not services. */
export const DEFAULT_PERSONAL_PROVIDER_PATTERN =
  'gmail\\.com|hotmail\\.|outlook\\.|yahoo\\.|web\\.de|gmx\\.|icloud\\.com|proton'

/** Relay/aggregator root domains that carry no domain signal — fall through to name rules. */
export const DEFAULT_RELAY_DOMAINS = ['appleid.com', 'google.com', 'gmail.com', 'hotmail.com']

/** Relay roots that indicate an account/service notification when no name rule fires. */
export const DEFAULT_ACCOUNT_DOMAINS = ['google.com', 'appleid.com']

/** Relay roots whose unmatched senders default to the personal category. */
export const DEFAULT_PERSONAL_PROVIDER_DOMAINS = ['gmail.com', 'hotmail.com']

/** Ops rhythm proven over 9,400+ mutations without a rate-limit death spiral. */
export const DEFAULT_OPS = {
  batchSize: 50,
  batchDelayMs: 220,
  stallBackoffMs: 1200,
  stallLimit: 6,
  progressEvery: 5,
} as const
