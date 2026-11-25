import { describe, expect, it } from 'vitest';
import { addDays, DAYS_AHEAD, forecastTitle, formatPanelDate, resolveDateRange } from './forecastdates.ts';

/** Consecutive YYYY-MM-DD dates from `start`. */
const run = (start: string, length: number) => Array.from({ length }, (_, i) => addDays(start, i));

describe('forecastTitle', () => {
  // A Sunday.
  const today = '2026-10-18';

  it('says "the next week" for a week starting today or tomorrow', () => {
    expect(forecastTitle({ dates: run(today, 6), today })).toBe('High-temperature forecast for the next week');
    expect(forecastTitle({ dates: run('2026-10-19', 6), today })).toBe('High-temperature forecast for the next week');
  });

  it('gives dates for a week that starts later', () => {
    expect(forecastTitle({ dates: run('2026-10-20', 6), today })).toBe('High-temperature forecast for Tuesday October 20–25');
  });

  it('names today and tomorrow for a single day', () => {
    expect(forecastTitle({ dates: [today], today })).toBe('High-temperature forecast for today, Sunday October 18');
    expect(forecastTitle({ dates: ['2026-10-19'], today })).toBe('High-temperature forecast for tomorrow, Monday October 19');
    expect(forecastTitle({ dates: ['2026-10-21'], today })).toBe('High-temperature forecast for Wednesday October 21');
  });

  it('shows one month for a range within a month', () => {
    expect(forecastTitle({ dates: run(today, 3), today })).toBe('High-temperature forecast for Sunday October 18–20');
  });

  it('shows both months for a range across months', () => {
    expect(forecastTitle({ dates: run('2026-10-30', 4), today })).toBe(
      'High-temperature forecast for Friday October 30–November 2'
    );
  });

  it('adds the year when it is not the current one', () => {
    expect(forecastTitle({ dates: run('2023-10-15', 3), today })).toBe('High-temperature forecast for Sunday October 15–17, 2023');
    expect(forecastTitle({ dates: ['2023-10-15'], today })).toBe('High-temperature forecast for Sunday October 15, 2023');
  });

  it('shows both years for a range across years', () => {
    expect(forecastTitle({ dates: run('2023-12-30', 4), today })).toBe(
      'High-temperature forecast for Saturday December 30, 2023–January 2, 2024'
    );
  });

  it('falls back to the plain title with no dates', () => {
    expect(forecastTitle({ dates: [], today })).toBe('High-temperature forecast');
  });
});

describe('addDays', () => {
  it('moves across month and year ends, forwards and back', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-11-01', -1)).toBe('2026-10-31');
  });
});

describe('resolveDateRange startOffset', () => {
  const today = '2026-11-18';

  it('starts n days after today', () => {
    const dates = resolveDateRange({ startOffset: '1', days: '6', defaultDays: 6, today });
    expect(dates).toEqual(['2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24']);
  });

  it('is ignored when a valid start is set', () => {
    const dates = resolveDateRange({ start: '2026-11-17', startOffset: '1', days: '1', defaultDays: 6, today });
    expect(dates).toEqual(['2026-11-17']);
  });

  it('falls back to today when not a number', () => {
    const dates = resolveDateRange({ startOffset: 'soon', days: '1', defaultDays: 6, today });
    expect(dates).toEqual([today]);
  });

  it('clamps to the last date with data and shortens the run', () => {
    const dates = resolveDateRange({ startOffset: '30', days: '6', defaultDays: 6, today });
    expect(dates).toEqual([addDays(today, DAYS_AHEAD)]);
  });
});

describe('formatPanelDate', () => {
  it('formats as "Weekday\\nMonth D"', () => {
    expect(formatPanelDate('2025-01-29')).toBe('Wednesday\nJanuary 29');
    expect(formatPanelDate('2026-10-18')).toBe('Sunday\nOctober 18');
  });
});
