import fs from 'node:fs';
import { addIgnored, paths, readIgnoreConfig, removeIgnored, writeIgnoreList } from '@potsherd/core';
import { print, printJson, themeFrom, UserError, type GlobalOptions } from '../output.js';

export interface IgnoreCommandOptions extends GlobalOptions {
  /** The project the user named. Omitted for the bare `slopie ignore`. */
  project?: string;
  /** `unignore` is the same verb with this set. */
  remove?: boolean;
}

/**
 * `slopie ignore <project>` / `slopie unignore <project>`, and with no argument the list itself.
 *
 * Nothing is ignored by default. An ignored project is left out of the audit's numbers and out of the records:
 * the next `slopie sync` removes its records and never writes them again. Stored in ~/.slopie/config.json;
 * the first write seeds it from the 1.8 list in ~/.potsherd/config.json (read-only).
 */
export async function runIgnore(o: IgnoreCommandOptions): Promise<number> {
  const verb = o.remove ? 'unignore' : 'ignore';
  const root = paths.slopieDir();
  const legacy = paths.potsherdDir(o.potsherdDir);
  const fresh = fs.existsSync(paths.configPath(root));
  const before = readIgnoreConfig(fresh ? root : legacy);
  if (before.error) throw new UserError(`${paths.tildify(before.file)}: ${before.error}`, 'open it and fix it, or delete it; slopie will write a new one');
  const named = o.project?.trim();
  if (!named) {
    if (o.json) printJson({ignore: before.list, config: before.file});
    else print(before.list.length ? before.list.join('\n') : 'nothing is ignored.');
    return 0;
  }
  if (!fresh && before.list.length) writeIgnoreList(root, before.list);
  const change = o.remove ? removeIgnored(root, named) : addIgnored(root, named);
  if (o.json) {
    printJson({verb, entry: change.entry, changed: change.changed, ignore: change.list, config: paths.configPath(root)});
    return 0;
  }
  const t = themeFrom(o);
  print(`${t.dim(`slopie ${verb}`)} ${change.entry}${change.changed ? '' : t.dim(o.remove ? '  (was not on the list)' : '  (already on the list)')}`);
  print(t.dim(o.remove ? 'the next  slopie sync  writes its sessions again.' : 'the next  slopie sync  removes its records; the audit leaves it out.'));
  return 0;
}
