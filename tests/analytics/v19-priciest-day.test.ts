import {describe, expect, it} from 'vitest';
import {reconcilePriciestDay} from '../../packages/core/src/analytics/story-archetype.js';

const award = (id: string, title = id, receipt = 'x') => ({id, title, receipt, publicReceipt: receipt, score: 1, tier: 'gold' as const});

describe('priciest-day award follows the spend card', () => {
  it('rewrites day, dollars and title from spend.priciestDay', () => {
    const out = reconcilePriciestDay([award('priciest_day', 'Black Friday', 'Aug 21: $1,099'), award('streak')], {day: '2026-08-22', usd: 860.31});
    expect(out[0]!.receipt).toMatch(/\$860$/);
    expect(out[0]!.receipt).not.toContain('1,099');
    expect(out[0]!.title).toBe('Bad Day at the Bank'); // 2026-08-22 is a Saturday
    expect(out[1]!.id).toBe('streak');
  });
  it('keeps Black Friday when the spend day is a Friday', () => {
    expect(reconcilePriciestDay([award('priciest_day')], {day: '2026-08-21', usd: 731.59})[0]!.title).toBe('Black Friday');
  });
  it('drops the award when spend has no priciest day', () => {
    expect(reconcilePriciestDay([award('priciest_day'), award('streak')], null).map(a => a.id)).toEqual(['streak']);
  });
});
