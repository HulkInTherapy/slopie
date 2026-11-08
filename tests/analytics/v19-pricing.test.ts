import {afterEach, describe, expect, it} from 'vitest';
import path from 'node:path';
import {cleanup, claudeAssistant, claudeUser, home, run} from './v19-helpers.js';

afterEach(cleanup);

describe('A#4 unknown models are unpriced, not $0 priced', () => {
  it('reports unpriced tokens and never claims every response was priced', async () => {
    const {dirs, options, write} = home();
    write(path.join(dirs.claude, 'projects', 'p', 's1.jsonl'), [
      claudeUser('u1', 'synthetic question one', 0), claudeAssistant('m1', 1, 's1', 'mystery-llm-1', {input_tokens: 1_000_000, output_tokens: 100_000}),
      claudeUser('u2', 'synthetic question two', 5), claudeAssistant('m2', 6, 's1', 'claude-sonnet-4-6', {input_tokens: 1000, output_tokens: 100}),
    ]);
    const s = await run(options);
    const facts = s.launch!.facts!;
    expect(facts.recordedResponses).toBe(2);
    expect(facts.pricedResponses).toBe(1);
    expect(facts.unpricedTokens).toBe(1_100_000);
    expect(facts.gaps).toContain('unpriced_model_usage');
    expect(s.coverage.gapCodes).toContain('unpriced_model_usage');
    expect(s.funnel!.responsesPriced).toBe(1);
  });
});
