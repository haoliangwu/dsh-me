import { describe, expect, it } from 'vitest'
import { appleScriptString, buildOsascriptScript, Config } from './index.ts'

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
    expect(script).toContain(`"${'t'.repeat(48)}"`)
    expect(script).toContain(`"${'b'.repeat(192)}"`)
    expect(script.length).toBeLessThan(280)
  })
})