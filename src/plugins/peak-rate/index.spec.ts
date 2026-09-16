import { describe, expect, it } from 'vitest'
import { Config } from './index.ts'

describe('Config schema', () => {
  it('applies defaults to an empty object', () => {
    expect(Config({})).toEqual({
      providers: ['deepseek-official'],
      peakWindows: [[1, 4], [6, 10]],
      multiplier: 2,
    })
  })

  it('applies defaults to a partial config', () => {
    expect(Config({ providers: ['x'] })).toEqual({
      providers: ['x'],
      peakWindows: [[1, 4], [6, 10]],
      multiplier: 2,
    })
  })

  it('accepts a full config', () => {
    expect(Config({ providers: ['x'], peakWindows: [[0, 24]], multiplier: 3 })).toEqual({
      providers: ['x'],
      peakWindows: [[0, 24]],
      multiplier: 3,
    })
  })

  it('rejects start >= end', () => {
    expect(() => Config({ peakWindows: [[4, 1]] })).toThrow()
  })

  it('rejects end > 24', () => {
    expect(() => Config({ peakWindows: [[0, 25]] })).toThrow()
  })

  it('rejects start < 0', () => {
    expect(() => Config({ peakWindows: [[-1, 3]] })).toThrow()
  })

  it('rejects start === end', () => {
    expect(() => Config({ peakWindows: [[2, 2]] })).toThrow()
  })

  it('rejects non-array peakWindows', () => {
    expect(() => Config({ peakWindows: 'not-array' } as never)).toThrow()
  })

  it('rejects non-number multiplier', () => {
    expect(() => Config({ multiplier: 'not-number' } as never)).toThrow()
  })
})