import { tildify } from './paths.js';

/**
 * The one shape every adapter's `doctor` line takes:
 *
 *     cursor      ready     ~/.cursor/projects            2 sessions · 4 transcripts
 *
 * Columns are fixed so the lines form a block; `note` is whatever that adapter knows and no other does.
 */
export function formatDoctorLine(o: {
  harness: string;
  /** `ready`, `absent`, … */
  status: string;
  dir: string;
  note: string;
}): string {
  return `${o.harness.padEnd(12)}${o.status.padEnd(10)}${tildify(o.dir).padEnd(28)}  ${o.note}`;
}
