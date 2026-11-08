import {afterEach, describe, expect, it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PriceBook} from '../../packages/core/src/analytics/pricing.js';
import {bundledModelCatalog} from '../../packages/core/src/analytics/model-catalog.js';
import {canonicalModel, largestRemainder, modelLabel} from '../../packages/core/src/analytics/model-names.js';
import {dayFormatter} from '../../packages/core/src/analytics/aggregate.js';
import {extractFile, parseHistory, time} from '../../packages/core/src/analytics/extract.js';

// Synthetic fixtures only.
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(r => fs.rmSync(r, {recursive: true, force: true})); });
const tmp = () => { const r = fs.mkdtempSync(path.join(os.tmpdir(), 'v19-basics-')); roots.push(r); return r; };
const jsonl = (rows: unknown[]) => rows.map(r => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';

describe('A#5 Bedrock revision suffix', () => {
  it('prices global ...-v1:0 like global ...-v1, not the EU regional endpoint', () => {
    const book = new PriceBook(bundledModelCatalog);
    const plain = book.lookup('global.anthropic.claude-opus-4-6-v1')!;
    const revision = book.lookup('global.anthropic.claude-opus-4-6-v1:0')!;
    expect(revision.rates).toEqual(plain.rates);
    expect(revision.pricedAs).toBe(plain.pricedAs);
    expect(revision.estimated).toBe(false);
  });
  it('canonical aliases prefer the non-regional entry', () => {
    const book = new PriceBook({basis: bundledModelCatalog.basis, models: [
      {provider: 'amazon-bedrock', id: 'eu.anthropic.claude-synth-9-v1', canonical: null, rates: {input: 5.5, output: 27.5}},
      {provider: 'amazon-bedrock', id: 'global.anthropic.claude-synth-9-v1', canonical: null, rates: {input: 5, output: 25}},
    ]});
    expect(book.lookup('claude-synth-9')!.rates.input).toBe(5);
    expect(book.lookup('eu.anthropic.claude-synth-9-v1:0')!.rates.input).toBe(5.5);
  });
});

describe('A#10 one alias-normalised label catalog', () => {
  it('collapses date stamps, provider prefixes and Bedrock ids to one canonical id and label', () => {
    const ids = ['claude-opus-4-6', 'claude-opus-4-6-20260101', 'anthropic/claude-opus-4-6', 'global.anthropic.claude-opus-4-6-v1:0', 'claude-opus-4.6', 'claude-opus-4-6[1m]'];
    expect(new Set(ids.map(canonicalModel))).toEqual(new Set(['claude-opus-4-6']));
    expect(new Set(ids.map(modelLabel))).toEqual(new Set(['Opus 4.6']));
    expect(modelLabel('gpt-6.1-sol')).toBe('GPT-6.1 Sol');
  });
});

describe('A#18 largest remainder', () => {
  it('sums to exactly 100', () => {
    expect(largestRemainder([1, 1, 1])).toEqual([34, 33, 33]);
    expect(largestRemainder([0.335, 0.335, 0.33]).reduce((a, b) => a + b)).toBe(100);
    expect(largestRemainder([98, 1.9, 0.1]).reduce((a, b) => a + b)).toBe(100);
    expect(largestRemainder([0, 0])).toEqual([0, 0]);
  });
});

describe('A#11 local day buckets in half-hour zones', () => {
  it('splits 23:40 and 00:10 IST into two days regardless of order', () => {
    for (const order of [[0, 1], [1, 0]]) {
      const day = dayFormatter('Asia/Kolkata');
      const ts = [Date.parse('2026-10-01T18:10:00Z'), Date.parse('2026-10-01T18:40:00Z')];
      const out = order.map(i => day(ts[i]!));
      expect(order[0] === 0 ? out : [...out].reverse()).toEqual(['2026-10-01', '2026-10-02']);
    }
  });
});

describe('A#7 malformed but valid JSON', () => {
  it('treats out-of-range timestamps as unknown', () => {
    expect(time(1e20)).toBeNull();
    expect(time('2026-10-01T00:00:00Z')).toBe(Date.parse('2026-10-01T00:00:00Z'));
  });
  it('skips null history rows instead of throwing', () => {
    const data = parseHistory('null\n42\n' + JSON.stringify({display: 'hello there synthetic', timestamp: 1790000000000, sessionId: 's'}) + '\n');
    expect(data.entries).toHaveLength(1);
  });
  it('keeps pi usage around a null row', () => {
    const dir = tmp();
    const file = path.join(dir, 's.jsonl');
    fs.writeFileSync(file, jsonl([
      {type: 'session', id: 'pi-1', cwd: '/work/synthetic', timestamp: '2026-10-01T10:00:00Z'},
      {type: 'message', id: 'a1', timestamp: '2026-10-01T10:01:00Z', message: {role: 'assistant', model: 'synthetic-model', usage: {input: 10, output: 5}}},
      'null',
      {type: 'message', id: 'a2', timestamp: '2026-10-01T10:02:00Z', message: {role: 'assistant', model: 'synthetic-model', usage: {input: 10, output: 5}}},
    ]));
    const facts = extractFile(file, 'pi');
    expect(facts.usage).toHaveLength(2);
    expect(facts.malformed).toBe(1);
  });
  it('a Claude row with timestamp 1e20 does not crash extraction or aggregation', () => {
    const dir = tmp();
    const file = path.join(dir, 's.jsonl');
    fs.writeFileSync(file, jsonl([{type: 'user', uuid: 'u1', sessionId: 's', timestamp: 1e20, cwd: '/w', message: {role: 'user', content: 'synthetic words here'}}, 'null']));
    const facts = extractFile(file, 'claude');
    expect(facts.prompts[0]!.at).toBeNull();
  });
});
