// Instant first frame for `slopie audit`.
//
// Loading the CLI bundle takes ~300 ms. For the interactive audit we paint the
// loading screen's first frame (the header, the section label, the first
// caption and the privacy promise) before the bundle loads, so the screen
// responds at once; the real loading screen takes over the alternate screen
// in exactly the same place and calls `globalThis.__slopieSplash.handOff()`.
//
// The palette, text and geometry mirror packages/cli/src/audit-ui/{gfx/color,loading}.ts;
// tests/audit-ui/splash.test.ts keeps them identical.
//
// If anything else ends up writing (an error, --help), the alternate screen is
// left first so the message stays visible, and the terminal is always restored
// on exit.

const PLAIN_FLAGS = new Set(['--json', '--plain', '--export', '--legacy', '--sweep', '--verify', '--help', '-h', '--version', '-V']);

/** The audit palette (mirrors C in audit-ui/gfx/color.ts), with its tuned 256-colour indices. */
export const SPLASH_PALETTE = {
  bg: ['#08090a', 232], text: ['#f7f8f8', 255], text2: ['#8a8f98', 245], text3: ['#5d6168', 241], rule: ['#1f2125', 234], accent: ['#7c7cff', 105],
};
export const PRIVACY_LINE = 'all local · nothing leaves this machine';
export const FIRST_CAPTION = 'finding your agents';

/** Mirrors loadingGeometry() in audit-ui/loading.ts. */
export function splashGeometry(w, h) {
  const L = w >= 100 && h >= 30;
  const S = w < 76 || h < 23;
  const mx = L ? 6 : 3;
  const top = L ? 1 : 0;
  const footY = L ? h - 2 : h - 1;
  const rowStep = L ? 2 : 1;
  const numH = L ? 5 : 3;
  const blockH = 2 + 4 * rowStep + 1 + numH + 2 + 2 + 1;
  const labelY = Math.max(top + 3, top + 2 + Math.floor((footY - top - 2 - blockH) / 2));
  const rowsY = labelY + 2;
  const numY = rowsY + 4 * rowStep + 1;
  const barY = numY + numH + 2;
  const captionY = barY + 2;
  return { L, S, mx, top, footY, rowStep, numH, labelY, rowsY, numY, barY, captionY };
}

/** The splash as text runs: { x, y, text, tone, bold }. */
export function splashRuns(w, h, unicode = true) {
  const g = splashGeometry(w, h);
  const iw = w - g.mx * 2;
  const runs = [
    { x: g.mx, y: g.top, text: 'slopie', tone: 'text', bold: true },
    { x: g.mx + 7, y: g.top, text: 'audit', tone: 'text3' },
    { x: g.mx, y: g.top + 1, text: (unicode ? '─' : '-').repeat(iw), tone: 'rule' },
    { x: g.mx, y: g.labelY, text: 'YOUR AGENTS', tone: 'text3' },
    { x: g.mx, y: g.barY, text: (unicode ? '─' : '-').repeat(Math.min(64, iw)), tone: 'rule' },
    { x: g.mx, y: g.captionY, text: FIRST_CAPTION, tone: 'text2' },
    { x: g.mx, y: g.footY, text: unicode ? '●' : '*', tone: 'accent' },
    { x: g.mx + 2, y: g.footY, text: PRIVACY_LINE, tone: 'text3' },
  ];
  return runs;
}

export function auditSplash(argv = process.argv.slice(2)) {
  const { stdin, stdout, stderr } = process;
  if (argv[0] !== 'audit' || argv.some(arg => PLAIN_FLAGS.has(arg.split('=')[0]))) return;
  if (!stdin.isTTY || !stdout.isTTY || process.env.SLOPIE_NO_SPLASH === '1') return;
  const w = stdout.columns || 80;
  const h = stdout.rows || 24;
  if (w < 60 || h < 20) return;

  const color = !('NO_COLOR' in process.env) && !argv.includes('--no-color') && process.env.TERM !== 'dumb';
  const truecolor = /^(truecolor|24bit)$/i.test(process.env.COLORTERM ?? '') || /^(iTerm\.app|WezTerm|ghostty|vscode)$/i.test(process.env.TERM_PROGRAM ?? '');
  const deep = color && (truecolor || /256/.test(process.env.TERM ?? '') || process.env.TERM_PROGRAM === 'Apple_Terminal');
  const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(';');
  const fg = tone => (!deep ? '' : truecolor ? `\x1b[38;2;${rgb(SPLASH_PALETTE[tone][0])}m` : `\x1b[38;5;${SPLASH_PALETTE[tone][1]}m`);
  const ink = !deep ? '' : truecolor ? `\x1b[48;2;${rgb(SPLASH_PALETTE.bg[0])}m` : `\x1b[48;5;${SPLASH_PALETTE.bg[1]}m`;
  const reset = `\x1b[0m${ink}`;
  const unicode = !argv.includes('--ascii');

  let out = `\x1b[?1049h\x1b[?25l${ink}\x1b[H\x1b[2J`;
  for (const run of splashRuns(w, h, unicode)) out += `\x1b[${run.y + 1};${run.x + 1}H${run.bold ? '\x1b[1m' : ''}${fg(run.tone)}${run.text}${reset}`;
  stdout.write(out + '\x1b[0m');
  try { stdin.setRawMode(true); } catch { /* not a raw-capable tty */ }

  let active = true;
  const originalOut = stdout.write.bind(stdout);
  const originalErr = stderr.write.bind(stderr);
  const leave = () => {
    if (!active) return;
    active = false;
    stdout.write = originalOut;
    stderr.write = originalErr;
    try { stdin.setRawMode(false); } catch { /* ignore */ }
    originalOut('\x1b[0m\x1b[?25h\x1b[?1049l');
  };
  // Anything other than the story writing first means we must get out of the way.
  stdout.write = (...args) => { leave(); return stdout.write(...args); };
  stderr.write = (...args) => { leave(); return stderr.write(...args); };
  process.once('exit', leave);

  globalThis.__slopieSplash = {
    handOff() {
      if (!active) return;
      active = false;
      stdout.write = originalOut;
      stderr.write = originalErr;
      process.off('exit', leave);
    },
  };
}
