import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

/**
 * No test may touch the developer's real ~/.potsherd, ~/.slopie or ~/.claude.
 *
 * A test that forgets to pass an explicit directory would otherwise read — or
 * worse, write — the machine's actual archive, and would pass or fail based on
 * whoever ran it. Pointing both env vars at a throwaway directory makes the
 * accident impossible rather than merely discouraged.
 */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'potsherd-vitest-'));

process.env['POTSHERD_DIR'] = path.join(sandbox, 'potsherd');
process.env['CLAUDE_CONFIG_DIR'] = path.join(sandbox, 'claude-empty');
process.env['NO_COLOR'] = '1';
// slopie 1.9: its own state and records live in the sandbox too, and no command starts a background sync.
process.env['SLOPIE_DIR'] = path.join(sandbox, 'slopie');
delete process.env['SLOPIE_RECORDS_DIR'];
process.env['SLOPIE_NO_SYNC'] = '1';
for(const harness of ['CODEX','CURSOR','PI','GEMINI','OPENCODE','COPILOT'])process.env[`POTSHERD_${harness}_DIR`]=path.join(sandbox,`.${harness.toLowerCase()}`);

/** No test reaches the network: the audit's --online path stays off. */
process.env['POTSHERD_OFFLINE'] = '1';

afterAll(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});
