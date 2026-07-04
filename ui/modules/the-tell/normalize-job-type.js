'use strict';

/**
 * MECHANICAL PORT of TrustQuote's lib/services/pricing/normalizeJobType.ts
 * (the wedge normalizer — source of truth). The Tell feed MUST group job
 * types exactly like the wedge does; its old local normalizer split
 * 'Whole Home Water Repipe (2 Bath)' away from the repipe family and
 * starved the margin floor (tell-sensors-v2 probe, 10 drafts).
 * PARITY LAW: __tests__/the-tell-normalize-parity.test.js runs THIS file
 * and the TS source against shared fixtures — drift is a red suite, so
 * never edit this port by hand; re-run the generator in that test's header.
 */

const CANONICAL_JOB_TYPES = [
  'water_heater',
  'drain_cleaning',
  'toilet',
  'faucet',
  'sink',
  'garbage_disposal',
  'water_line',
  'repipe',
  'sewer',
  'sump_pump',
  'gas_line',
  'leak_repair',
  'pressure_regulator',
]

const JOB_TYPE_SYNONYMS = {
  'water heater replacement': 'water_heater',
  'water heater install': 'water_heater',
  'tankless wh': 'water_heater',
  'water heater': 'water_heater',
  'hot water heater': 'water_heater',
  wh: 'water_heater',
  'w h': 'water_heater',
  tankless: 'water_heater',
  'tankless heater': 'water_heater',
  'tankless water heater': 'water_heater',

  drain: 'drain_cleaning',
  'drain snake': 'drain_cleaning',
  'drain clean': 'drain_cleaning',
  'drain cleaning': 'drain_cleaning',
  'clogged drain': 'drain_cleaning',
  rooter: 'drain_cleaning',
  snake: 'drain_cleaning',
  snaking: 'drain_cleaning',

  toilet: 'toilet',
  wc: 'toilet',
  'water closet': 'toilet',
  commode: 'toilet',
  'toilet auger': 'toilet',

  faucet: 'faucet',
  'faucet repair': 'faucet',
  'kitchen faucet': 'faucet',
  'lavatory faucet': 'faucet',
  'tub shower faucet': 'faucet',

  sink: 'sink',
  lavatory: 'sink',
  basin: 'sink',

  disposal: 'garbage_disposal',
  'garbage disposal': 'garbage_disposal',
  garburator: 'garbage_disposal',
  insinkerator: 'garbage_disposal',

  'water line': 'water_line',
  'water distribution': 'water_line',
  'water distribution system': 'water_line',
  'main water line': 'water_line',
  'water service': 'water_line',
  'service line': 'water_line',

  're pipe': 'repipe',
  'copper repipe': 'repipe',
  repipe: 'repipe',
  repiping: 'repipe',
  'pipe replacement': 'repipe',

  sewer: 'sewer',
  'building sewer': 'sewer',
  'building sewer lateral': 'sewer',
  'sewer line': 'sewer',
  'sewer main': 'sewer',
  'main line': 'sewer',

  sump: 'sump_pump',
  'sump pump': 'sump_pump',

  'natural gas': 'gas_line',
  'natural gas system': 'gas_line',
  'gas line': 'gas_line',
  'gas pipe': 'gas_line',
  'gas piping': 'gas_line',

  leak: 'leak_repair',
  'leak repair': 'leak_repair',
  'pipe leak': 'leak_repair',
  'water leak': 'leak_repair',

  prv: 'pressure_regulator',
  regulator: 'pressure_regulator',
  'pressure regulator': 'pressure_regulator',
  'pressure reducing valve': 'pressure_regulator',
}

const JOB_TYPE_RULES = [
  {
    canonical: 'water_heater',
    patterns: [/\bwater heater\b/, /\btankless\b/, /\bwh\b/],
  },
  {
    canonical: 'drain_cleaning',
    patterns: [
      /\bdrain cleaning\b/,
      /\bdrain clean\b/,
      /\bdrain snake\b/,
      /\bclogged drain\b/,
      /\bsnake\b/,
      /\brooter\b/,
    ],
  },
  {
    canonical: 'toilet',
    patterns: [/\btoilet\b/, /\bwc\b/, /\bwater closet\b/, /\bcommode\b/],
  },
  {
    canonical: 'faucet',
    patterns: [/\bfaucet\b/],
  },
  {
    canonical: 'sink',
    patterns: [/\bsink\b/, /\blavatory\b/, /\bbasin\b/],
  },
  {
    canonical: 'garbage_disposal',
    patterns: [
      /\bgarbage disposal\b/,
      /\bdisposal\b/,
      /\bgarburator\b/,
      /\binsinkerator\b/,
    ],
  },
  {
    canonical: 'water_line',
    patterns: [
      /\bwater line\b/,
      /\bwater service\b/,
      /\bwater distribution\b/,
      /\bsupply lines?\b/,
    ],
  },
  {
    canonical: 'repipe',
    patterns: [/\brepipe\b/, /\bre pipe\b/, /\brepiping\b/],
  },
  {
    canonical: 'sewer',
    patterns: [/\bsewer\b/, /\bmain line\b/],
  },
  {
    canonical: 'sump_pump',
    patterns: [/\bsump pump\b/],
  },
  {
    canonical: 'gas_line',
    patterns: [
      /\bgas line\b/,
      /\bgas pipe\b/,
      /\bgas piping\b/,
      /\bnatural gas\b/,
    ],
  },
  {
    canonical: 'leak_repair',
    patterns: [/\bleak\b/],
  },
  {
    canonical: 'pressure_regulator',
    patterns: [
      /\bprv\b/,
      /\bpressure regulator\b/,
      /\bpressure reducing valve\b/,
    ],
  },
]

function normalizePhrase(raw) {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function findCanonicalBucket(phrase) {
  const exactMatch = JOB_TYPE_SYNONYMS[phrase]
  if (exactMatch) {
    return exactMatch
  }

  for (const rule of JOB_TYPE_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(phrase))) {
      return rule.canonical
    }
  }

  return null
}

function slugifyPhrase(phrase) {
  return phrase.replace(/\s+/g, '_')
}

function normalizeJobType(raw) {
  if (raw == null) {
    return ''
  }

  const phrase = normalizePhrase(raw)
  if (!phrase) {
    return ''
  }

  return findCanonicalBucket(phrase) ?? slugifyPhrase(phrase)
}

function canonicalLabel(key) {
  const normalizedKey = normalizeJobType(key)
  if (!normalizedKey) {
    return ''
  }

  return normalizedKey
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

module.exports = { CANONICAL_JOB_TYPES, normalizeJobType, canonicalLabel };
