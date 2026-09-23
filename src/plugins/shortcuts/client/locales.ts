/** `shortcuts` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'title': '键盘快捷键',
  'actionSidebar': '收起/展开侧边栏',
  'actionRightbar': '开/关右面板',
  'actionHelp': '打开帮助浮层',
  'rebindHint': '在 profile 配置中通过插件 dsh-ui-shortcuts 的 bindings 字段改键。',
  'close': '关闭',
} satisfies Record<string, string>

/** English dictionary mirroring the Chinese key set. */
export const en: Record<keyof typeof zh, string> = {
  'title': 'Keyboard shortcuts',
  'actionSidebar': 'Toggle sidebar',
  'actionRightbar': 'Toggle right panel',
  'actionHelp': 'Open help overlay',
  'rebindHint': 'Rebind via the bindings config of the dsh-ui-shortcuts plugin in your profile.',
  'close': 'Close',
}

/** The shortcuts namespace key union. */
export type ShortcutsKey = keyof typeof zh