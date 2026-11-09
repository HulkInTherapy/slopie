import { describe, expect, it } from 'vitest';
import { renderAuditShareSvg, renderLaunchPlain } from '../../packages/cli/src/audit-ui/index.js';
import { readySnapshot } from './fixture.js';
import { storySnapshot } from './story-fixture.js';

describe('plain and share outputs', () => {
  it('prints the whole board and the details without ANSI or viewport clipping', () => {
    const text = renderLaunchPlain(readySnapshot(), { width: 100 });
    expect(text).not.toContain('\x1b');
    for (const expected of ['MODELS', 'PROJECTS', 'WHEN YOU CODE', 'ON REPEAT', 'REACTIONS', 'SWEAR JAR', 'WHAT THE NUMBERS MEAN', 'Rotor-Notes', '975 prompts']) {
      expect(text).toContain(expected);
    }
    expect(text).not.toContain('q quit');
  });

  it('stays pure ASCII with --ascii', () => {
    const text = renderLaunchPlain(readySnapshot(), { width: 80, ascii: true });
    expect([...text].every(char => char.charCodeAt(0) < 128)).toBe(true);
  });

  it('share SVG leaves out project names and your own words', () => {
    const svg = renderAuditShareSvg(readySnapshot());
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('MODELS');
    expect(svg).not.toContain('Rotor-Notes');
    expect(svg).not.toContain('continue please');
    expect(svg).not.toContain('What the hell');
    // The grey ramp, the background and the one accent; nothing else.
    expect(svg).not.toMatch(/#(?!F7F8F8|8A8F98|5D6168|7C7CFF|08090A)[0-9A-Fa-f]{6}/);
  });

  it('prints every story card as a text section before the board', () => {
    const text = renderLaunchPlain(storySnapshot(), { width: 100 });
    expect(text).not.toContain('\x1b');
    for (const expected of ['YOUR YEAR WITH AGENTS', 'BEFORE WE START', 'THE BILL', 'YOUR CLOCK', 'QUICK QUIZ', 'answer: Claude Opus 5', 'HOW YOU TALK', 'the 2am deployer'.toLowerCase(), 'THE BOARD', 'WHAT THE NUMBERS MEAN']) {
      expect(text.toLowerCase()).toContain(expected.toLowerCase());
    }
    expect(text).toContain('f-bombs');
    expect(text).not.toMatch(/\bfuck/i);
  });

  it('story share SVG is anonymised and stays in the palette family', () => {
    const svg = renderAuditShareSvg(storySnapshot());
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('2AM Deployer');
    expect(svg).toContain('At API prices');
    expect(svg).toContain('npx slopie audit');
    // The poster's palette: the grey ramp, the background and the one accent.
    const fills = new Set([...svg.matchAll(/fill="(#[0-9A-F]{6})"/g)].map(m => m[1]));
    for (const fill of fills) expect(['#08090A', '#F7F8F8', '#8A8F98', '#5D6168', '#7C7CFF', '#1F2125', '#3E424A', '#25282D']).toContain(fill);
    // Only the catchphrase / pet name the poster already shows; no project names or other prompt text.
    for (const secret of ['lantern-api', 'tidepool', 'paper-boats', 'sync layer', 'keep going', 'leave the tests']) expect(svg).not.toContain(secret);
  });
});
