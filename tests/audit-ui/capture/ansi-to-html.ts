/**
 * Minimal terminal emulator for captures: replays a raw ANSI stream (cursor moves, clears, SGR
 * truecolor / 256 / 16) into a cell grid and writes .txt and .html (for a headless-browser PNG).
 * `tsx ansi-to-html.ts in.ansi cols rows`
 */
import fs from 'node:fs';

interface Cell { ch: string; fg: string | null; bg: string | null; bold: boolean; italic: boolean; dim: boolean }
const [file, colsArg = '120', rowsArg = '40'] = process.argv.slice(2);
const W = Number(colsArg), H = Number(rowsArg);
const blank = (): Cell => ({ ch: ' ', fg: null, bg: null, bold: false, italic: false, dim: false });
let grid: Cell[][] = Array.from({ length: H }, () => Array.from({ length: W }, blank));
let x = 0, y = 0;
let style: Omit<Cell, 'ch'> = { fg: null, bg: null, bold: false, italic: false, dim: false };
const BASIC = ['000000', 'cd3131', '0dbc79', 'e5e510', '2472c8', 'bc3fbc', '11a8cd', 'e5e5e5', '666666', 'f14c4c', '23d18b', 'f5f543', '3b8eea', 'd670d6', '29b8db', 'ffffff'];
const hex = (r: number, g: number, b: number) => [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
function c256(n: number): string {
  if (n < 16) return BASIC[n]!;
  if (n >= 232) { const v = 8 + (n - 232) * 10; return hex(v, v, v); }
  const k = n - 16, cube = [0, 95, 135, 175, 215, 255];
  return hex(cube[Math.floor(k / 36)]!, cube[Math.floor(k / 6) % 6]!, cube[k % 6]!);
}
function sgr(params: number[]): void {
  if (!params.length) params = [0];
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!;
    if (p === 0) style = { fg: null, bg: null, bold: false, italic: false, dim: false };
    else if (p === 1) style.bold = true;
    else if (p === 2) style.dim = true;
    else if (p === 3) style.italic = true;
    else if (p === 38 || p === 48) {
      let color: string | null = null;
      if (params[i + 1] === 2) { color = hex(params[i + 2]!, params[i + 3]!, params[i + 4]!); i += 4; }
      else if (params[i + 1] === 5) { color = c256(params[i + 2]!); i += 2; }
      if (p === 38) style.fg = color; else style.bg = color;
    } else if (p >= 30 && p <= 37) style.fg = BASIC[p - 30]!;
    else if (p >= 90 && p <= 97) style.fg = BASIC[p - 90 + 8]!;
    else if (p >= 40 && p <= 47) style.bg = BASIC[p - 40]!;
    else if (p >= 100 && p <= 107) style.bg = BASIC[p - 100 + 8]!;
    else if (p === 39) style.fg = null;
    else if (p === 49) style.bg = null;
  }
}
const data = fs.readFileSync(file!, 'utf8');
const seg = new Intl.Segmenter('en', { granularity: 'grapheme' });
const re = /\x1b\[([?]?)([0-9;]*)([A-Za-z~])|\x1b[()][0-9A-B]|\x1b.|([^\x1b]+)/gs;
for (const m of data.matchAll(re)) {
  if (m[4] !== undefined) {
    for (const { segment: ch } of seg.segment(m[4])) {
      if (ch === '\r') { x = 0; continue; }
      if (ch === '\n') { y = Math.min(H - 1, y + 1); continue; }
      if (y < H && x < W) grid[y]![x] = { ch, ...style };
      x++;
    }
    continue;
  }
  if (m[1] === '?' || m[3] === undefined) continue;
  const params = (m[2] ?? '').split(';').filter(s => s !== '').map(Number);
  switch (m[3]) {
    case 'H': case 'f': y = (params[0] || 1) - 1; x = (params[1] || 1) - 1; break;
    case 'J': grid = Array.from({ length: H }, () => Array.from({ length: W }, blank)); break;
    case 'K': for (let i = x; i < W; i++) grid[y]![i] = blank(); break;
    case 'm': sgr(params); break;
    case 'C': x += params[0] || 1; break;
    case 'G': x = (params[0] || 1) - 1; break;
  }
}
const text = grid.map(row => row.map(c => c.ch).join('').trimEnd()).join('\n');
fs.writeFileSync(file!.replace(/\.ansi$/, '.txt'), text + '\n');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const INK = '0d0b0a';
const rows = grid.map(row => row.map(c => {
  const fg = c.fg ?? 'e8e2da', bg = c.bg ?? INK;
  const weight = c.bold ? 'font-weight:700;' : '';
  const it = c.italic ? 'font-style:italic;' : '';
  const op = c.dim ? 'opacity:.6;' : '';
  // Block glyphs are drawn as boxes so half-block pixels render crisply.
  if (c.ch === '▀') return `<i style="background:linear-gradient(#${fg} 50%,#${bg} 50%)"></i>`;
  if (c.ch === '▄') return `<i style="background:linear-gradient(#${bg} 50%,#${fg} 50%)"></i>`;
  if (c.ch === '█') return `<i style="background:#${fg}"></i>`;
  return `<b style="color:#${fg};background:#${bg};${weight}${it}${op}">${esc(c.ch === ' ' ? ' ' : c.ch)}</b>`;
}).join('')).map(r => `<div>${r}</div>`).join('\n');
const CW = 10, CH = 21;
fs.writeFileSync(file!.replace(/\.ansi$/, '.html'), `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#${INK}} .t{padding:16px;font:16px/${CH}px "DejaVu Sans Mono",Menlo,monospace;width:${W * CW}px}
.t div{height:${CH}px;white-space:pre;display:flex} .t b,.t i{display:inline-block;width:${CW}px;height:${CH}px;font-weight:400;text-align:center;overflow:visible}
</style><div class="t">${rows}</div>`);
