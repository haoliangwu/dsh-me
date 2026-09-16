import { describe, expect, it } from 'vitest'
import { formatWindows, isPeak, isPeakRate, isWeekend } from './peak-rate.ts'

const DEFAULT_WINDOWS: readonly (readonly [number, number])[] = [[1, 4], [6, 10]]

describe('isPeak', () => {
  it('is peak inside default windows', () => {
    expect(isPeak(new Date('2026-08-17T02:30:00Z'), DEFAULT_WINDOWS)).toBe(true)
    expect(isPeak(new Date('2026-08-17T08:00:00Z'), DEFAULT_WINDOWS)).toBe(true)
  })

  it('is off-peak outside default windows', () => {
    expect(isPeak(new Date('2026-08-17T00:59:00Z'), DEFAULT_WINDOWS)).toBe(false)
    expect(isPeak(new Date('2026-08-17T04:00:00Z'), DEFAULT_WINDOWS)).toBe(false)
    expect(isPeak(new Date('2026-08-17T10:00:00Z'), DEFAULT_WINDOWS)).toBe(false)
    expect(isPeak(new Date('2026-08-17T05:00:00Z'), DEFAULT_WINDOWS)).toBe(false)
  })

  it('respects non-default windows', () => {
    expect(isPeak(new Date('2026-08-17T05:00:00Z'), [[5, 6]])).toBe(true)
    expect(isPeak(new Date('2026-08-17T05:00:00Z'), DEFAULT_WINDOWS)).toBe(false)
  })

  it('is always off-peak for empty windows', () => {
    expect(isPeak(new Date('2026-08-17T02:00:00Z'), [])).toBe(false)
  })
})

describe('isWeekend (Beijing time, UTC+8)', () => {
  it('is weekend for a Beijing Saturday', () => {
    // Beijing 2026-08-22 10:00 = UTC 2026-08-22 02:00.
    expect(isWeekend(new Date('2026-08-22T02:00:00Z'))).toBe(true)
  })

  it('is weekend for a Beijing Sunday', () => {
    // Beijing 2026-08-23 15:00 = UTC 2026-08-23 07:00.
    expect(isWeekend(new Date('2026-08-23T07:00:00Z'))).toBe(true)
  })

  it('treats the start of a Beijing Saturday as weekend even when UTC is still Friday', () => {
    // Beijing 2026-08-22 00:00 = UTC 2026-08-21 16:00.
    expect(isWeekend(new Date('2026-08-21T16:00:00Z'))).toBe(true)
  })

  it('treats the start of a Beijing Monday as a weekday even when UTC is still Sunday', () => {
    // Beijing 2026-08-24 00:00 = UTC 2026-08-23 16:00.
    expect(isWeekend(new Date('2026-08-23T16:00:00Z'))).toBe(false)
  })

  it('is a weekday for a Beijing Friday', () => {
    // Beijing 2026-08-21 10:00 = UTC 2026-08-21 02:00.
    expect(isWeekend(new Date('2026-08-21T02:00:00Z'))).toBe(false)
  })

  it('is a weekday for a Beijing Monday', () => {
    // Beijing 2026-08-24 10:00 = UTC 2026-08-24 02:00.
    expect(isWeekend(new Date('2026-08-24T02:00:00Z'))).toBe(false)
  })
})

describe('isPeakRate (weekday windows, weekends all-day off-peak)', () => {
  it('is peak on a weekday inside a window', () => {
    // Monday 2026-08-17, UTC 02:30 ∈ [1, 4).
    expect(isPeakRate(new Date('2026-08-17T02:30:00Z'), DEFAULT_WINDOWS)).toBe(true)
  })

  it('is off-peak on a weekday outside a window', () => {
    expect(isPeakRate(new Date('2026-08-17T05:00:00Z'), DEFAULT_WINDOWS)).toBe(false)
  })

  it('is off-peak on a weekend even inside a window', () => {
    // Saturday 2026-08-22, UTC 02:30 ∈ [1, 4) but weekend.
    expect(isPeakRate(new Date('2026-08-22T02:30:00Z'), DEFAULT_WINDOWS)).toBe(false)
  })

  it('is peak on a Friday morning inside a window', () => {
    // Beijing Friday 2026-08-21 10:00 = UTC 2026-08-21 02:00 ∈ [1, 4);
    // a weekday hour UTC still counts as Friday, not yet Beijing Saturday.
    expect(isPeakRate(new Date('2026-08-21T02:00:00Z'), DEFAULT_WINDOWS)).toBe(true)
  })

  it('is off-peak on a weekend regardless of windows', () => {
    expect(isPeakRate(new Date('2026-08-22T02:30:00Z'), [[0, 24]])).toBe(false)
  })

  it('is off-peak on a Sunday morning even inside a window', () => {
    // Beijing Sunday 2026-08-23 09:30 = UTC 2026-08-23 01:30 ∈ [1, 4).
    expect(isPeakRate(new Date('2026-08-23T01:30:00Z'), DEFAULT_WINDOWS)).toBe(false)
  })

  it('is peak on a Monday morning inside a window', () => {
    // Beijing Monday 2026-08-24 09:30 = UTC 2026-08-24 01:30 ∈ [1, 4).
    expect(isPeakRate(new Date('2026-08-24T01:30:00Z'), DEFAULT_WINDOWS)).toBe(true)
  })

  it('is always off-peak for empty windows', () => {
    expect(isPeakRate(new Date('2026-08-17T02:00:00Z'), [])).toBe(false)
  })
})

describe('formatWindows', () => {
  it('formats windows zero-padded with en-dash and comma+space separators', () => {
    expect(formatWindows([[1, 4], [6, 10]])).toBe('01:00–04:00, 06:00–10:00')
  })

  it('formats empty windows as an empty string', () => {
    expect(formatWindows([])).toBe('')
  })
})