/**
 * Beijing-time (UTC+8) calendar helpers shared by the peak-rate plugin's
 * node (host) and browser halves.
 *
 * The billing rule is stated in Beijing time, so both halves convert UTC
 * moments to the Beijing calendar date: the node half for the holiday-cn
 * year selection, the browser half for weekend and holiday lookups. The
 * conversion is a plain constant shift — China observes no DST — so the
 * helpers live here once instead of a duplicated offset per half.
 */

/** Beijing timezone offset from UTC in hours (UTC+8; China observes no DST). */
const BEIJING_OFFSET_HOURS = 8

/**
 * The Beijing-time wall-clock equivalent of a UTC moment, as a new Date.
 * @param date - the moment to shift.
 * @returns a new Date whose UTC fields read as the Beijing wall-clock time
 *   of the same instant.
 */
export function beijingDate(date: Date): Date {
  return new Date(date.getTime() + BEIJING_OFFSET_HOURS * 60 * 60 * 1000)
}

/**
 * The Beijing-time (UTC+8) calendar date of a UTC moment as `YYYY-MM-DD`.
 * @param date - the moment to test.
 * @returns the Beijing calendar date string, e.g. `2026-10-01`.
 */
export function beijingDateString(date: Date): string {
  return beijingDate(date).toISOString().slice(0, 10)
}

/**
 * The Beijing-time (UTC+8) calendar year of a UTC moment.
 * @param date - the moment to test.
 * @returns the Beijing calendar year, e.g. `2026`.
 */
export function beijingYear(date: Date): number {
  return beijingDate(date).getUTCFullYear()
}