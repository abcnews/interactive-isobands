export const DATA_BASE_URL = 'https://abcnewsdata.sgp1.digitaloceanspaces.com/service-ecmwf-gridded-forecasts';

/** Folders are dated from here... */
export const FIRST_DATE = '2026-10-16';
/** ...up to this many days after today (a 6 day forecast). */
export const DAYS_AHEAD = 6;
export const TIME_ZONE = 'Australia/Sydney';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Today's date in Sydney as YYYY-MM-DD, regardless of the browser's own time zone. */
export const todayInSydney = () => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date());

const MS_PER_DAY = 1000 * 60 * 60 * 24;

// ---------------------------------------------------------------------------
// Date labels
// ---------------------------------------------------------------------------

/**
 * The pieces every date label is built from, e.g. Sunday / October / 18 / 2026. Read at noon UTC
 * so the label stays on the right calendar day in any browser time zone.
 */
const dateParts = (ymd: string) => {
  const date = new Date(`${ymd}T12:00:00Z`);
  const format = (options: Intl.DateTimeFormatOptions) => date.toLocaleDateString('en-AU', { ...options, timeZone: 'UTC' });
  return {
    weekday: format({ weekday: 'long' }),
    month: format({ month: 'long' }),
    day: date.getUTCDate(),
    year: date.getUTCFullYear()
  };
};

/**
 * A YYYY-MM-DD date as "Sunday\nOctober 18". The newline puts the weekday on its own line when
 * rendered with `white-space: pre-line`; replace it with a space for one-line text such as alt text.
 */
export const formatPanelDate = (ymd: string) => {
  const { weekday, month, day } = dateParts(ymd);
  return `${weekday}\n${month} ${day}`;
};

// ---------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------

const TITLE_PREFIX = 'High-temperature forecast';
/** Runs at least this long that start today or tomorrow are called "the next week" rather than given dates. */
const NEXT_WEEK_MIN_DAYS = 6;

/** "Sunday October 18", plus ", 2023" when it isn't the current year. */
const describeDay = (ymd: string, currentYear: number) => {
  const { weekday, day, month, year } = dateParts(ymd);
  return `${weekday} ${month} ${day}${year !== currentYear ? `, ${year}` : ''}`;
};

/**
 * "Sunday October 18–20", "Friday October 30–November 2", "Saturday December 30, 2023–January 2, 2024".
 * The month is only repeated on the end when it differs from the start; the year shows only when it
 * isn't the current one, and on both ends when they differ.
 */
const describeRange = (first: string, last: string, currentYear: number) => {
  const [start, end] = [dateParts(first), dateParts(last)];
  const yearsDiffer = start.year !== end.year;
  const showYear = yearsDiffer || end.year !== currentYear;
  const startText = `${start.weekday} ${start.month} ${start.day}${yearsDiffer ? `, ${start.year}` : ''}`;
  const endMonth = yearsDiffer || start.month !== end.month ? `${end.month} ` : '';
  return `${startText}–${endMonth}${end.day}${showYear ? `, ${end.year}` : ''}`;
};

/**
 * A title describing the dates shown, so an evergreen embed never says the wrong thing:
 * - a week or so from today or tomorrow: "…for the next week"
 * - one day: "…for today, Sunday October 18" (or "tomorrow, …", or just the date)
 * - otherwise the range: "…for Sunday October 18–20", with the year only when it isn't this year.
 */
export const forecastTitle = ({ dates, today = todayInSydney() }: { dates: string[]; today?: string }) => {
  const [first, last] = [dates[0], dates.at(-1)];
  if (!first || !last) return TITLE_PREFIX;

  const tomorrow = addDays(today, 1);
  const currentYear = Number(today.slice(0, 4));

  if (dates.length >= NEXT_WEEK_MIN_DAYS && (first === today || first === tomorrow)) {
    return `${TITLE_PREFIX} for the next week`;
  }

  if (dates.length === 1) {
    const relativeDay = { [today]: 'today, ', [tomorrow]: 'tomorrow, ' }[first] ?? '';
    return `${TITLE_PREFIX} for ${relativeDay}${describeDay(first, currentYear)}`;
  }

  return `${TITLE_PREFIX} for ${describeRange(first, last, currentYear)}`;
};

/** A YYYY-MM-DD date moved by a whole number of days (negative goes back). */
export const addDays = (ymd: string, days: number) =>
  // Midnight UTC has no DST, so every day is exactly MS_PER_DAY long.
  new Date(new Date(`${ymd}T00:00:00Z`).getTime() + days * MS_PER_DAY).toISOString().slice(0, 10);

/** Every available date from FIRST_DATE to today + DAYS_AHEAD, inclusive. */
export const availableDates = (today: string) => {
  // Midnight UTC has no DST, so every day is exactly MS_PER_DAY long.
  const firstMs = new Date(`${FIRST_DATE}T00:00:00Z`).getTime();
  const lastMs = new Date(`${today}T00:00:00Z`).getTime() + DAYS_AHEAD * MS_PER_DAY;
  const dayCount = Math.max(0, Math.round((lastMs - firstMs) / MS_PER_DAY) + 1);

  return Array.from({ length: dayCount }).map((_, i) => addDays(FIRST_DATE, i));
};

/**
 * Turns a requested `start` and `days` into a run of consecutive dates that all have data.
 * Why clamp rather than reject: a stale or hand-edited embed URL should still show a map,
 * not a blank frame. An unparseable start means "today"; a start outside the available
 * range is moved to the nearest edge; the run is shortened so it never passes the last date.
 *
 * `startOffset` exists for evergreen embeds: `startOffset=1` always starts on the day after the
 * reader views it, where a fixed `start` would go stale. It moves "today" by n days, so it only
 * applies when there is no valid `start`; a fixed date wins because it is the more specific ask.
 */
export const resolveDateRange = ({
  start,
  startOffset,
  days,
  defaultDays,
  today = todayInSydney()
}: {
  start?: string | null;
  /** Whole days to add to today (negative goes back) when `start` is not set. Defaults to 0. */
  startOffset?: string | null;
  days?: string | null;
  defaultDays: number;
  today?: string;
}) => {
  const dates = availableDates(today);
  const [first, last] = [dates[0], dates[dates.length - 1]];

  const isValidStart = !!start && ISO_DATE.test(start) && !Number.isNaN(Date.parse(`${start}T00:00:00Z`));
  const offsetDays = Math.trunc(Number(startOffset ?? 0));
  const relativeStart = addDays(today, Number.isFinite(offsetDays) ? offsetDays : 0);
  const requestedStart = isValidStart ? start : relativeStart;
  const clampedStart = requestedStart < first ? first : requestedStart > last ? last : requestedStart;

  const requestedDays = Math.floor(Number(days ?? defaultDays));
  const wantedDays = Number.isFinite(requestedDays) && requestedDays >= 1 ? requestedDays : defaultDays;
  const room = dates.length - dates.indexOf(clampedStart);

  return dates.slice(dates.indexOf(clampedStart), dates.indexOf(clampedStart) + Math.min(wantedDays, room));
};
