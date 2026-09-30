/** `debug` namespace dictionaries (the composer debug chip's copy). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'chip.label': 'Debug',
  'chip.on.aria': '调试模式已开启，按下关闭',
  'chip.on.title': '调试模式已开启 — 点击关闭（/debug off）',
  'chip.off.aria': '调试模式已关闭，按下开启',
  'chip.off.title': '调试模式已关闭 — 点击开启（/debug）',
  'chip.exitFailed': '退出调试模式失败',
} satisfies Record<string, string>

/** The debug namespace key union. */
export type DebugKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'chip.label': 'Debug',
  'chip.on.aria': 'Debug mode on, press to turn off',
  'chip.on.title': 'Debug mode on — click to turn off (/debug off)',
  'chip.off.aria': 'Debug mode off, press to turn on',
  'chip.off.title': 'Debug mode off — click to turn on (/debug)',
  'chip.exitFailed': 'Failed to exit debug mode',
} satisfies Record<DebugKey, string>
