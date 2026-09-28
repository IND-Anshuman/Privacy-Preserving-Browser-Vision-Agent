/**
 * NER label mapping and the span shape the L2 layer produces.
 *
 * Split out of models.ts so the mapping and the subword merge are unit-testable
 * WITHOUT loading a 27 MB model, which is the only way they get tested at all.
 */
import type { PiiClass } from '@/lib/schema'

export interface NerSpan {
  label: string
  score: number
  start: number
  end: number
  text: string
}

/**
 * The PII model's 24 classes → our taxonomy.
 *
 * Deliberate choices, spelled out because a silent mapping is how a privacy
 * tool ends up labelling things wrongly:
 *   · US_SSN → AADHAAR: both are a 9-or-12-digit national identifier. The
 *     corpus's AADHAAR class is a national ID; SSN is the closest analogue.
 *   · NRP → PERSON: nationality/religious/political group is a personal
 *     attribute and must be redacted like one.
 *   · URL → null: a URL is not PII on its own, and over-redacting every link
 *     would make the redacted frame useless.
 *   · TITLE → null: an honorific is not identifying without the name.
 */
export function mapL2Label(label: string): PiiClass | null {
  const l = label.toUpperCase().replace(/^[BI]-/, '')
  switch (l) {
    case 'PERSON':
    case 'NRP':
      return 'PERSON'
    case 'PASSWORD':
      return 'PASSWORD'
    case 'EMAIL_ADDRESS':
      return 'EMAIL'
    case 'PHONE_NUMBER':
      return 'PHONE'
    case 'CREDIT_CARD':
      return 'CREDIT_CARD'
    case 'IP_ADDRESS':
    case 'MAC_ADDRESS':
    case 'IMEI':
      return 'IP_ADDRESS'
    case 'LOCATION':
    case 'COORDINATE':
      return 'LOCATION'
    case 'ORGANIZATION':
      return 'ORG'
    case 'US_SSN':
    case 'US_ITIN':
      return 'AADHAAR'
    case 'US_BANK_NUMBER':
    case 'FINANCIAL':
      return 'BANK_ACCOUNT'
    case 'US_PASSPORT':
      return 'PASSPORT'
    case 'US_DRIVER_LICENSE':
    case 'US_LICENSE_PLATE':
      return 'DL'
    case 'IBAN_CODE':
      return 'IBAN'
    case 'DATE_TIME':
      return 'DATE'
    case 'AGE':
      return 'DOB'
    case 'URL':
    case 'TITLE':
    case 'O':
      return null
    default:
      return null
  }
}

/** Every label the model can emit, for a coverage assertion in the tests. */
export const PII_MODEL_LABELS = [
  'AGE', 'COORDINATE', 'CREDIT_CARD', 'DATE_TIME', 'EMAIL_ADDRESS', 'FINANCIAL',
  'IBAN_CODE', 'IMEI', 'IP_ADDRESS', 'LOCATION', 'MAC_ADDRESS', 'NRP',
  'ORGANIZATION', 'PASSWORD', 'PERSON', 'PHONE_NUMBER', 'TITLE', 'URL',
  'US_BANK_NUMBER', 'US_DRIVER_LICENSE', 'US_ITIN', 'US_LICENSE_PLATE',
  'US_PASSPORT', 'US_SSN',
]
