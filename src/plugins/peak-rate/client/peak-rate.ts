/** Beijing timezone offset from UTC in hours (UTC+8; China observes no DST). */
const BEIJING_OFFSET_HOURS = 8

/**
 * Whether a UTC moment falls in a peak-rate window.
 *
 * Windows are `[startHour, endHour)` UTC hour pairs, left-closed right-open.
 * An empty window list is always off-peak.
 * @param date - the moment to test.
 * @param windows - peak windows as `[startHour, endHour)` UTC hour pairs.
 * @returns true iff the date's UTC hour is in a peak window.
 */
export function isPeak(date: Date, windows: ReadonlyArray<readonly [number, number]>): boolean {
  const hour = date.getUTCHours()
  return windows.some(([start, end]) => hour >= start && hour < end)
}

/**
 * Whether the Beijing-time calendar day of a UTC moment is a weekend
 * (Saturday or Sunday).
 *
 * The billing rule is stated in Beijing time, so the weekend boundary follows
 * the UTC+8 calendar date: Beijing Saturday 00:00 is UTC Friday 16:00 and
 * Beijing Monday 00:00 is UTC Sunday 16:00, both of which a plain UTC
 * `getUTCDay()` weekend check would get wrong by half a day.
 * @param date - the moment to test.
 * @returns true iff the moment falls on a Beijing-time Saturday or Sunday.
 */
export function isWeekend(date: Date): boolean {
  const beijingDay = new Date(date.getTime() + BEIJING_OFFSET_HOURS * 60 * 60 * 1000).getUTCDay()
  return beijingDay === 0 || beijingDay === 6
}

/**
 * Whether a moment is charged at the peak rate under the current billing
 * rule: weekdays follow the configured peak windows; weekends (Beijing time)
 * are all-day off-peak per the rule change effective 2026-08-23.
 * @param date - the moment to test.
 * @param windows - peak windows as `[startHour, endHour)` UTC hour pairs.
 * @returns true iff the date is a weekday inside a peak window.
 */
export function isPeakRate(date: Date, windows: ReadonlyArray<readonly [number, number]>): boolean {
  return !isWeekend(date) && isPeak(date, windows)
}

/**
 * Format peak windows as a locale-independent string, e.g. `01:00–04:00, 06:00–10:00`.
 * @param windows - peak windows as `[startHour, endHour)` UTC hour pairs.
 * @returns two-digit zero-padded `HH:00–HH:00` pairs joined by `, `.
 */
export function formatWindows(windows: ReadonlyArray<readonly [number, number]>): string {
  const pad = (n: number): string => n.toString().padStart(2, '0')
  return windows.map(([start, end]) => `${pad(start)}:00–${pad(end)}:00`).join(', ')
}