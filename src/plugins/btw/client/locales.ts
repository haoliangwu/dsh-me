/** `btw` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'running': 'btw 命令执行中…',
  'done': 'btw 命令完成',
  'failed': 'btw 命令失败',
  'copy': '复制',
  'copied': '已复制',
  'footnotes': '脚注',
  'title': 'btw',
} satisfies Record<string, string>

/** English dictionary mirroring the Chinese key set. */
export const en: Record<keyof typeof zh, string> = {
  'running': 'btw command running…',
  'done': 'btw command complete',
  'failed': 'btw command failed',
  'copy': 'Copy',
  'copied': 'Copied',
  'footnotes': 'Footnotes',
  'title': 'btw',
}

/** The btw namespace key union. */
export type BtwCommandKey = keyof typeof zh
