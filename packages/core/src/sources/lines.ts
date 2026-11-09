/**
 * Streaming line reader over native history files (.jsonl and .jsonl.zst), on the audit's zstd engine
 * (`analytics/extract.ts`). Bounded memory: one 4 MiB buffer, grown only for longer lines.
 */
import fs from 'node:fs';
import {isZstd, zstdStream} from '../analytics/extract.js';

const CHUNK = 4 * 1024 * 1024;
/** Lines longer than this are skipped without being materialised (line numbers still count them). */
const MAX_LINE = 512 * 1024 * 1024;

/** Calls `onLine(bytes, lineNo)` for every line (1-based numbers, blank lines included in the count). */
export function forEachLine(file: string, onLine: (line: Buffer, lineNo: number) => void): void {
  const fd = fs.openSync(file, 'r');
  try {
    const zst = isZstd(fd) ? zstdStream(fd, file, null) : null;
    let buffer = Buffer.allocUnsafe(CHUNK);
    let filled = 0, position = 0, lineNo = 0, skipping = false;
    for (;;) {
      if (filled === buffer.length) {
        if (buffer.length >= MAX_LINE) { skipping = true; filled = 0; }
        else { const bigger = Buffer.allocUnsafe(buffer.length * 2); buffer.copy(bigger, 0, 0, filled); buffer = bigger; }
      }
      const n = zst ? zst.read(buffer, filled, buffer.length - filled) : fs.readSync(fd, buffer, filled, buffer.length - filled, position);
      position += n;
      const end = filled + n;
      let start = 0;
      for (;;) {
        const nl = buffer.indexOf(10, start);
        if (nl < 0 || nl >= end) break;
        lineNo++;
        if (skipping) skipping = false;
        else onLine(buffer.subarray(start, nl), lineNo);
        start = nl + 1;
      }
      if (n === 0) {
        if (start < end) { lineNo++; if (!skipping) onLine(buffer.subarray(start, end), lineNo); }
        break;
      }
      buffer.copyWithin(0, start, end);
      filled = end - start;
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** Parsed JSON records with their line numbers; unparseable and blank lines are skipped. */
export function forEachRecord(file: string, onRecord: (record: unknown, lineNo: number) => void): void {
  forEachLine(file, (line, lineNo) => {
    let i = 0;
    while (i < line.length && (line[i] === 32 || line[i] === 9 || line[i] === 13)) i++;
    if (i >= line.length) return;
    let value: unknown;
    try { value = JSON.parse(line.toString('utf8')); } catch { return; }
    onRecord(value, lineNo);
  });
}

/** The first `max` decompressed bytes of a file (for sniffing archive copies). */
export function headOf(file: string, max = 64 * 1024): Buffer {
  const fd = fs.openSync(file, 'r');
  try {
    if (isZstd(fd)) return zstdStream(fd, file, null).peek(max);
    const b = Buffer.alloc(max);
    const n = fs.readSync(fd, b, 0, max, 0);
    return b.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}
