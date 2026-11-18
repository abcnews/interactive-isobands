import { describe, expect, it } from 'vitest';
import { formatPanelDate, ordinal } from './forecastdates.ts';

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
