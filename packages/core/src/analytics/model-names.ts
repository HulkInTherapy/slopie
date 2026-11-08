/**
 * One alias-normalised model catalog for display and grouping.
 *
 * Pricing keeps the raw endpoint spelling (regional Bedrock ids cost more);
 * everything that groups or labels models uses `canonicalModel`, so
 * `claude-opus-4-6`, `claude-opus-4-6-20260101`, `anthropic/claude-opus-4-6`
 * and `global.anthropic.claude-opus-4-6-v1:0` are one row with one label.
 */

/** Provider/region prefixes, revision and context suffixes, date stamps removed; lower-case. */
export function canonicalModel(model: string): string {
  let m = model.trim().toLowerCase();
  m = m.replace(/\[[^\]]*\]$/, '');
  if (m.includes('/')) m = m.slice(m.lastIndexOf('/') + 1);
  m = m.replace(/@.*$/, '');
  m = m.replace(/^(?:(?:anthropic|openai|us|eu|apac|global|jp|au|ca|us-gov)\.)+/, '');
  m = m.replace(/:\d+$/, '');
  m = m.replace(/-v\d+$/, '');
  m = m.replace(/-(?:20\d{6}|\d{4}-\d{2}-\d{2})$/, '');
  m = m.replace(/-latest$/, '');
  // Claude ids use dashes between version digits; some routers write dots.
  if (m.startsWith('claude-')) m = m.replace(/(\d)\.(\d)/g, '$1-$2');
  return m;
}

const labelMemo = new Map<string, string>();
/** Display label: 'claude-opus-4-6-20260101' -> 'Opus 4.6', 'gpt-6.1-sol' -> 'GPT-6.1 Sol'. */
export function modelLabel(model: string | null): string {
  if (!model) return '?';
  let hit = labelMemo.get(model);
  if (hit !== undefined) return hit;
  const parts = canonicalModel(model).replace(/^claude-/, '').split(/[-_]/).filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    if (/^\d+$/.test(p) && out.length && /\d$/.test(out[out.length - 1]!)) out[out.length - 1] += `.${p}`;
    else out.push(p === 'gpt' ? 'GPT' : /^\d/.test(p) ? p : p[0]!.toUpperCase() + p.slice(1));
  }
  hit = out.join(' ').replace(/^GPT (\d)/, 'GPT-$1') || model;
  labelMemo.set(model, hit);
  return hit;
}

/**
 * Largest-remainder rounding: integer percentages of `values` that sum to
 * exactly 100 (or all 0 when the total is 0). Ties go to the earlier entry.
 */
export function largestRemainder(values: readonly number[], total = 100): number[] {
  const sum = values.reduce((a, b) => a + Math.max(0, b), 0);
  if (!(sum > 0)) return values.map(() => 0);
  const exact = values.map(v => (Math.max(0, v) / sum) * total);
  const out = exact.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = exact.map((v, i) => [v - Math.floor(v), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) { if (left <= 0) break; out[i]!++; left--; }
  return out;
}
