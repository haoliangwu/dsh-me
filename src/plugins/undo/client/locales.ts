/** `undo` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'buttonAria': '撤销',
  'redoAria': '重做',
} satisfies Record<string, string>

/** English dictionary mirroring the Chinese key set. */
export const en: Record<keyof typeof zh, string> = {
  'buttonAria': 'Undo',
  'redoAria': 'Redo',
}

/** The undo namespace key union. */
export type UndoKey = keyof typeof zh