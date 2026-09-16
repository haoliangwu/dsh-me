import { describe, expect, it } from 'vitest'
import { Config } from './index.ts'

describe('Config schema', () => {
  it('applies defaults to an empty object', () => {
    expect(Config({})).toEqual({
      notifyCompletion: true,
      notifyError: true,
      notifyQuestion: true,
    })
  })

  it('applies defaults to a partial config', () => {
    expect(Config({ notifyError: false })).toEqual({
      notifyCompletion: true,
      notifyError: false,
      notifyQuestion: true,
    })
  })

  it('accepts a full config', () => {
    expect(Config({ notifyCompletion: false, notifyError: false, notifyQuestion: false })).toEqual({
      notifyCompletion: false,
      notifyError: false,
      notifyQuestion: false,
    })
  })

  it('rejects a non-boolean toggle', () => {
    expect(() => Config({ notifyCompletion: 'yes' } as never)).toThrow()
  })
})