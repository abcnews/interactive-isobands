import { describe, expect, it } from 'vitest';
import { addDays, DAYS_AHEAD, formatPanelDate, ordinal, resolveDateRange } from './forecastdates.ts';

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

describe('ordinal', () => {
  it('uses the right English suffix, including the teens', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 29, 31].map(ordinal)).toEqual([
      '1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '29th', '31st'
    ]);
  });
});

describe('formatPanelDate', () => {
  it('formats as "Weekday,\\nMonth the Nth"', () => {
    expect(formatPanelDate('2025-01-29')).toBe('Wednesday,\nJanuary the 29th');
    expect(formatPanelDate('2026-11-22')).toBe('Sunday,\nNovember the 22nd');
  });
});
