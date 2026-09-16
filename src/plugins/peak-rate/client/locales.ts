/** `peak` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'badge': '🔥 {multiplier}×',
  'title': '高峰时段 · 费用为低峰的 {multiplier}× ({windows} UTC)',
} satisfies Record<string, string>

/** English dictionary mirroring the Chinese key set. */
export const en: Record<keyof typeof zh, string> = {
  'badge': '🔥 {multiplier}×',
  'title': 'Peak hours · {multiplier}× off-peak rate ({windows} UTC)',
}

/** The peak namespace key union. */
export type PeakKey = keyof typeof zh