import type {GlobalOptions} from '../output.js';
import {spawnBackgroundSync} from './memory.js';

export interface AuditOptions extends GlobalOptions {
  overview?: boolean;
  plain?: boolean;
  motion?: boolean;
  private?: boolean;
  harness?: string;
  project?: string;
  since?: string;
  until?: string;
  timezone?: string;
  export?: string;
  tone?: string;
  online?: boolean;
}

/**
 * `slopie audit`: the terminal audit over local history (read-only; derived results use a separate cache).
 * It also brings the session records current in a detached `slopie sync`, which never affects the audit.
 */
export async function runAudit(o: AuditOptions): Promise<number> {
  spawnBackgroundSync(o);
  const {runAuditOverview} = await import('./audit-overview.js');
  return runAuditOverview(o);
}
