import { describe, expect, it } from 'vitest'
import { Config } from './index.ts'

describe('Config schema', () => {
  it('defaults defaultLevel to lite', () => {
    expect(Config({})).toEqual({ defaultLevel: 'lite' })
  })

  it('accepts every legal level', () => {
    for (const level of ['lite', 'full', 'ultra', 'wenyan-lite', 'wenyan-full', 'wenyan-ultra', 'off']) {
      expect(Config({ defaultLevel: level })).toEqual({ defaultLevel: level })
    }
  })

  it('rejects an illegal level', () => {
    expect(() => Config({ defaultLevel: 'medium' } as never)).toThrow()
    expect(() => Config({ defaultLevel: '' } as never)).toThrow()
  })
})