/**
 * Built-in defaults, ported verbatim from the origin session that organized a
 * 6,551-email Fastmail inbox. Every list is overridable via config.
 */

export interface WeightedKeyword {
  phrase: string
  weight: number
}

/**
 * Needs-action HIGH signals (+3 each). Bilingual EN+DE by necessity — a German
 * user's inbox scores on "Frist" as much as "deadline". Trailing spaces are
 * significant ('sign ' avoids matching 'design').
 */
export const DEFAULT_HIGH_KEYWORDS: readonly WeightedKeyword[] = [
  'action required',
  'action needed',
  'please confirm',
  'confirm your',
  'verify your',
  'please verify',
  'identity',
  'bestätige',
  'bestätigung',
  'antworten',
  'respond',
  'response needed',
  'reply',
  'deadline',
  'frist',
  'fällig',
  'overdue',
  'überfällig',
  'past due',
  'payment failed',
  'zahlung fehlgeschlagen',
  'failed payment',
  'invoice',
  'rechnung',
  'mahnung',
  'reminder',
  'erinnerung',
  'zahlungserinnerung',
  'appointment',
  'termin',
  // deviation from the reference: the bare phrase 'sign ' matched mid-word
  // ('design update') — dropped; 'signature'/'to sign'/'docusign'/German
  // forms below keep the coverage
  'signature',
  'unterschrift',
  'unterschreiben',
  'docusign',
  'to sign',
  'zu unterschreiben',
  'complete your',
  'vervollständigen',
  'expires',
  'expiring',
  'läuft ab',
  'verlängern',
  'renew',
  'renewal',
  'suspended',
  'gesperrt',
  'kyc',
  'upload',
  'nachweis',
  'missing information',
  'ausstehend',
  'outstanding',
  'rsvp',
  'einladung',
  'interview',
  'bewerbung',
  'actie',
  'verifizieren',
  'confirm subscription',
  'update your payment',
  'zahlungsmethode',
  'abgelaufen',
  'last chance to',
].map((phrase) => ({ phrase, weight: 3 }))

/** Needs-action exclusions (-2 each): receipts, shipping, newsletters, confirmations. */
export const DEFAULT_EXCLUSION_KEYWORDS: readonly WeightedKeyword[] = [
  'receipt',
  'quittung',
  'your order',
  'bestellung',
  'has shipped',
  'shipped',
  'versand',
  'versandbestätigung',
  'delivered',
  'zugestellt',
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
  'kontoauszug',
].map((phrase) => ({ phrase, weight: -2 }))

/**
 * Automated-sender detector (matched against the FROM ADDRESS): the inverse of
 * "a human wrote this".
 */
export const DEFAULT_AUTOMATED_PATTERN =
  'no.?reply|newsletter|notification|notifications|team@|support@|info@|hello@|service@|noreply|automated|updates?@|marketing|billing|invoice|receipt|do.?not.?reply|mailer|news@|@mail\\.|@email\\.|@e\\.|@em\\.|@updates?\\.|@notify'

/** Big-brand detector (matched against address + display name). Verbatim from reference/human.mjs. */
export const DEFAULT_BRAND_PATTERN =
  'uber|linkedin|amazon|paypal|apple|google|github|klarna|revolut|kraken|stripe|netflix|substack|meetup|crunchbase|ahrefs|xing|bolt|lieferando|wolt|trip|airbnb|booking|o2|ionos|fastmail|cloudflare|instantdb|hashcards|val\\.town|executeprogram|samsung|microsoft|audible|spotify|discord|steam|adobe|notion|slack|gorillas|holafly|mubi|taxfix|schufa|haspa|n26|vivid|deutschebahn|flixbus|dhl|hermes|ups|zalando|mediamarkt'

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
