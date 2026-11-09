/**
 * The agent note that teaches the record format (R5 NOTE_B, verbatim, with the records path filled in),
 * plus one line about the `slopie` CLI tools over the same records.
 */
import {NOTE_B_TEMPLATE} from './spec.js';

/** One line on the CLI tools (not part of the evaluated note; appended after it). */
export const CLI_LINE = 'Faster lookups over the same records, if the slopie command is available: slopie search <words> [--project P --since D], '
  + 'slopie read <id> [--from N --to M], slopie threads [--project P --since D --text W], slopie grep <id> <text>; each reply ends with the exact next command.';

/** R5 §7 (iii): guidance for roster and latest-decision questions. Evaluated on the hard set; see R6. */
export const GUIDANCE = "For 'which threads' questions, include threads that dispatched, coordinated or tracked the work, and long threads that started before the window but were active in it. "
  + "For 'latest decision' questions, after the first hit check later threads in every harness and read the turns after an announced plan before answering. "
  + 'Do not answer NOT FOUND after reading only part of a session.';

/** R5 §7 (i): the full-output sidecar. */
export const SIDECAR_LINE = '- Full tool outputs (up to 20 kB each) are also in <record>.out.txt beside each record, tagged the same way, so rg reaches text the record cut.';

export interface NoteOptions {
  cli?: boolean;
  guidance?: boolean;
  sidecar?: boolean;
}

export function agentNote(recordsDir: string, o: NoteOptions = {}): string {
  let note = NOTE_B_TEMPLATE.split('{RECORDS}').join(recordsDir);
  if (o.sidecar) {
    const lines = note.split('\n');
    lines.splice(lines.length - 1, 0, SIDECAR_LINE);
    note = lines.join('\n');
  }
  if (o.guidance) note += '\n' + GUIDANCE;
  if (o.cli ?? true) note += '\n' + CLI_LINE;
  return note;
}
