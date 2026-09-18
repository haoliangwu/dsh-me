import { describe, expect, it } from 'vitest'
import { Config } from './index.ts'

describe('Config schema', () => {
  it('applies defaults to an empty object', () => {
    expect(Config({})).toEqual({
      maxHops: 5,
      autoWake: true,
    })
  })

  it('applies defaults to a partial config', () => {
    expect(Config({ autoWake: false })).toEqual({
      maxHops: 5,
      autoWake: false,
    })
  })

  it('accepts a full config', () => {
    expect(Config({ maxHops: 9, autoWake: false })).toEqual({
      maxHops: 9,
      autoWake: false,
    })
  })

  it('rejects a non-number maxHops', () => {
    expect(() => Config({ maxHops: 'many' } as never)).toThrow()
  })

  it('rejects a non-integer maxHops', () => {
    expect(() => Config({ maxHops: 2.5 })).toThrow()
  })

  it('rejects a maxHops below 1', () => {
    expect(() => Config({ maxHops: 0 })).toThrow()
  })

  it('rejects a non-boolean autoWake', () => {
    expect(() => Config({ autoWake: 'yes' } as never)).toThrow()
  })
})