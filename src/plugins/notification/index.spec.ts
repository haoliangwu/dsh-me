import { describe, expect, it } from 'vitest'
import { appleScriptString, buildOsascriptScript, Config, truncateUtf8 } from './index.ts'

describe('Config schema', () => {
  it('applies defaults to an empty object', () => {
    expect(Config({})).toEqual({
      notifyCompletion: true,
      notifyError: true,
      notifyQuestion: true,
      notifyApproval: true,
      notifySound: true,
    })
  })

  it('applies defaults to a partial config', () => {
    expect(Config({ notifyError: false })).toEqual({
      notifyCompletion: true,
      notifyError: false,
      notifyQuestion: true,
      notifyApproval: true,
      notifySound: true,
    })
  })

  it('accepts a full config', () => {
    expect(Config({
      notifyCompletion: false, notifyError: false, notifyQuestion: false, notifyApproval: false, notifySound: false,
    })).toEqual({
      notifyCompletion: false,
      notifyError: false,
      notifyQuestion: false,
      notifyApproval: false,
      notifySound: false,
    })
  })

  it('rejects a non-boolean toggle', () => {
    expect(() => Config({ notifyCompletion: 'yes' } as never)).toThrow()
  })

  it('rejects a non-boolean notifyApproval', () => {
    expect(() => Config({ notifyApproval: 'yes' } as never)).toThrow()
  })

  it('rejects a non-boolean notifySound', () => {
    expect(() => Config({ notifySound: 'yes' } as never)).toThrow()
  })
})

describe('osascript notification script', () => {
  it('escapes double quotes and backslashes in AppleScript literals', () => {
    expect(appleScriptString('say "hi" \\ ok')).toBe('"say \\"hi\\" \\\\ ok"')
  })

  it('collapses newlines to spaces for a one-line script', () => {
    expect(appleScriptString('line1\nline2\r\n')).toBe('"line1 line2 "')
  })

  it('builds the complete display notification script', () => {
    expect(buildOsascriptScript('审批', 'bash：需要写文件'))
      .toBe('display notification "bash：需要写文件" with title "审批"')
  })

  it('bounds title and body to macOS-friendly lengths', () => {
    const script = buildOsascriptScript('t'.repeat(120), 'b'.repeat(300))
    expect(script).toContain(`"${'t'.repeat(64)}"`)
    expect(script).toContain(`"${'b'.repeat(168)}"`)
    expect(script.length).toBeLessThan(280)
  })

  it('truncates by UTF-8 bytes, not code points', () => {
    // 一个 CJK 字符 = 3 bytes；预算 9 bytes 恰好装 3 个。
    expect(truncateUtf8('审批通知', 9)).toBe('审批通')
    // 预算 8 bytes 装不下第 3 个字符，整字符丢弃不劈开。
    expect(truncateUtf8('审批通知', 8)).toBe('审批')
    // ASCII 按字节计，多字节字符不会撕裂。
    expect(truncateUtf8('abc中文', 5)).toBe('abc')
    expect(truncateUtf8('abc中文', 6)).toBe('abc中')
  })

  it('keeps a CJK notification inside the byte budget', () => {
    const script = buildOsascriptScript('审批'.repeat(30), '需要写入文件'.repeat(60))
    // 截断后仍是整字符。
    expect(script).toMatch(/^display notification "[\u4e00-\u9fff]*" with title "[\u4e00-\u9fff]*"$/)
  })
})