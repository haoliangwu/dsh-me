import { describe, expect, it } from 'vitest'
import { Config } from './index.ts'

describe('Config schema', () => {
  it('applies defaults to an empty object', () => {
    expect(Config({})).toEqual({
      notifyCompletion: true,
      notifyError: true,
      notifyQuestion: true,
      notifySound: true,
    })
  })

  it('applies defaults to a partial config', () => {
    expect(Config({ notifyError: false })).toEqual({
      notifyCompletion: true,
      notifyError: false,
      notifyQuestion: true,
      notifySound: true,
    })
  })

  it('accepts a full config', () => {
    expect(Config({
      notifyCompletion: false, notifyError: false, notifyQuestion: false, notifySound: false,
    })).toEqual({
      notifyCompletion: false,
      notifyError: false,
      notifyQuestion: false,
      notifySound: false,
    })
  })

  it('rejects a non-boolean toggle', () => {
    expect(() => Config({ notifyCompletion: 'yes' } as never)).toThrow()
  })

  it('rejects a non-boolean notifySound', () => {
    expect(() => Config({ notifySound: 'yes' } as never)).toThrow()
  })
})