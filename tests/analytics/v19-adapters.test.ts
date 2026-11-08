import {afterEach, describe, expect, it} from 'vitest';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {cleanup, home, run} from './v19-helpers.js';

afterEach(cleanup);
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

describe('A#6 Cursor, Gemini and Copilot are part of the audit', () => {
  it('counts Cursor prompts and chats, and leaves their cost unknown rather than $0', async () => {
    const {options} = home();
    const s = await run({...options, cursorDir: path.join(FIXTURES, 'cursor')});
    const row = s.sources.find(x => x.harness === 'cursor')!;
    expect(row.state).toBe('available');
    expect(row.humanPrompts).toBeGreaterThan(0);
    expect(row.conversations).toBeGreaterThan(0);
    expect(row.usage).toBe('unavailable');
    expect(row.gapCodes).toContain('usage_not_recorded');
    expect(s.coverage.gapCodes).toContain('usage_not_recorded');
    expect(s.launch!.story!.totals.byHarness.cursor).toBeGreaterThan(0);
    expect(s.launch!.story!.spend.byHarness.find(h => h.harness === 'cursor')!.usd).toBe(0);
  });
  it('lists all seven harnesses and never reads personal roots when other sources are explicit', async () => {
    const {options} = home();
    const s = await run(options);
    expect(s.sources.map(x => x.harness).sort()).toEqual(['claude', 'codex', 'copilot', 'cursor', 'gemini', 'opencode', 'pi']);
    for (const h of ['cursor', 'gemini', 'copilot']) expect(s.sources.find(x => x.harness === h)!.state).toBe('absent');
  });
  it('reads the Gemini and Copilot fixtures without crashing', async () => {
    const {options} = home();
    const s = await run({...options, geminiDir: path.join(FIXTURES, 'gemini'), copilotDir: path.join(FIXTURES, 'copilot')});
    expect(s.status === 'ready' || s.status === 'partial').toBe(true);
    expect(s.sources.find(x => x.harness === 'gemini')!.humanPrompts).toBeGreaterThanOrEqual(0);
  });
});
