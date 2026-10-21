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

/** Every available date from FIRST_DATE to today + DAYS_AHEAD, inclusive. */
export const availableDates = (today: string) => {
  // Midnight UTC has no DST, so every day is exactly MS_PER_DAY long.
  const firstMs = new Date(`${FIRST_DATE}T00:00:00Z`).getTime();
  const lastMs = new Date(`${today}T00:00:00Z`).getTime() + DAYS_AHEAD * MS_PER_DAY;
  const dayCount = Math.max(0, Math.round((lastMs - firstMs) / MS_PER_DAY) + 1);

  return Array.from({ length: dayCount }).map((_, i) =>
    new Date(firstMs + i * MS_PER_DAY).toISOString().slice(0, 10)
  );
};

/**
 * Turns a requested `start` and `days` into a run of consecutive dates that all have data.
 * Why clamp rather than reject: a stale or hand-edited embed URL should still show a map,
 * not a blank frame. An unparseable start means "today"; a start outside the available
 * range is moved to the nearest edge; the run is shortened so it never passes the last date.
 */
export const resolveDateRange = ({
  start,
  days,
  defaultDays,
  today = todayInSydney()
}: {
  start?: string | null;
  days?: string | null;
  defaultDays: number;
  today?: string;
}) => {
  const dates = availableDates(today);
  const [first, last] = [dates[0], dates[dates.length - 1]];

  const isValidStart = !!start && ISO_DATE.test(start) && !Number.isNaN(Date.parse(`${start}T00:00:00Z`));
  const requestedStart = isValidStart ? start : today;
  const clampedStart = requestedStart < first ? first : requestedStart > last ? last : requestedStart;

  const requestedDays = Math.floor(Number(days ?? defaultDays));
  const wantedDays = Number.isFinite(requestedDays) && requestedDays >= 1 ? requestedDays : defaultDays;
  const room = dates.length - dates.indexOf(clampedStart);

  return dates.slice(dates.indexOf(clampedStart), dates.indexOf(clampedStart) + Math.min(wantedDays, room));
};
