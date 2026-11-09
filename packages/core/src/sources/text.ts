/**
 * String helpers that reproduce the reference exporter's (Python) text semantics exactly, so the records
 * slopie writes are the records the R5 evaluation measured: `str.strip`, `str.splitlines`, `json.dumps`
 * with its default separators, and `re.sub(r"\s+", " ", s)`.
 */

const WS = '\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const STRIP = new RegExp(`^[${WS}]+|[${WS}]+$`, 'g');
const RUNS = new RegExp(`[${WS}]+`, 'g');
const BREAK = new RegExp('\\r\\n|[\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85\\u2028\\u2029]');

/** Python `str.strip()`. */
export function pyStrip(s: string): string {
  return s.replace(STRIP, '');
}

/** Python `re.sub(r"\s+", " ", s)`. */
export function squash(s: string): string {
  return s.replace(RUNS, ' ');
}

/** Python `str.splitlines()`: no trailing empty element, `''` gives `[]`. */
export function pySplitlines(s: string): string[] {
  if (!s) return [];
  const parts = s.split(BREAK);
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** Python `json.dumps(v, ensure_ascii=False)` (separators ", " and ": "). */
export function pyDumps(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return Number.isNaN(v) ? 'NaN' : v > 0 ? 'Infinity' : '-Infinity';
    return String(v);
  }
  if (Array.isArray(v)) return `[${v.map(pyDumps).join(', ')}]`;
  if (typeof v === 'object') {
    return `{${Object.entries(v as Record<string, unknown>).map(([k, x]) => `${JSON.stringify(k)}: ${pyDumps(x)}`).join(', ')}}`;
  }
  return JSON.stringify(String(v));
}

/** Python `str(v)` for the JSON values a transcript can hold. */
export function pyStr(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'number') return String(v);
  return pyRepr(v);
}

function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (typeof v === 'string') return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(', ')}]`;
  return `{${Object.entries(v as Record<string, unknown>).map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`).join(', ')}}`;
}

const SURROGATE = /[\uD800-\uDFFF]/;

/** Python `len(s)`: code points, not UTF-16 units. */
export function cpLen(s: string): number {
  if (!SURROGATE.test(s)) return s.length;
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** Python `s[a:b]` (code points; negative indexes count from the end). */
export function cpSlice(s: string, a: number, b?: number): string {
  if (!SURROGATE.test(s)) return s.slice(a, b);
  return Array.from(s).slice(a, b).join('');
}
