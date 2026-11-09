/**
 * The agent note (the body of the one `slopie` skill): the record format (R5 NOTE_B as extended through R8, with the
 * records path filled in), the R8 answer protocol, and one line on `slopie search`.
 */
import {NOTE_B_TEMPLATE} from './spec.js';

/** One line on the `slopie search` CLI (R6 measured the four-verb form as arm P2; this one-verb form is arm P3). */
export const CLI_LINE = 'If the slopie command is on PATH, start with it rather than rg: it searches these same records faster and more cheaply. '
  + 'slopie search <words> [--project P --since D] finds passages; slopie search <words> --session ID searches inside one thread; '
  + 'slopie search --session ID --turns 120-160 reads turns (--turns -30 reads the end); slopie search --project P --since D lists threads. '
  + 'Each reply ends with the exact next command. Use rg/sed on the files for anything else.';

/** R5 §7 (iii): guidance for roster and latest-decision questions. Evaluated on the hard set; see R6. */
export const GUIDANCE = "For 'which threads' questions, include threads that dispatched, coordinated or tracked the work, and long threads that started before the window but were active in it. "
  + "For 'latest decision' questions, after the first hit check later threads in every harness and read the turns after an announced plan before answering. "
  + 'Do not answer NOT FOUND after reading only part of a session.';

/**
 * R8: the answer protocol, one line, part of the default note. It names the three ways R7/R8 traces went wrong:
 * citing a thread that only pasted, relayed or re-read the fact; stopping at the first value of something that changed
 * later; and leaving threads out of a which-threads answer.
 */
export const PROTOCOL = 'Before you answer: cite the thread where the fact was produced, not one that pasted it, re-read it from a file, or received it as a relay ("Delegated task … [from delegated thread <id>]" names the thread that did the work). '
  + 'For a current, final or latest value, or the result of a step, read on past the first hit to the end of that step and check later threads ("## mentioned later in", rg -l --sortr modified) for a change. '
  + 'For which-threads questions, list every candidate thread in scope (no head), check each, and count the thread that dispatched the work ("parent: delegated by <id>") and long threads active in the window.';

/** R5 §7 (i): the full-output sidecar. */
export const SIDECAR_LINE = '- Full tool outputs (up to 20 kB each) are also in <record>.out.txt beside each record, tagged the same way, so rg reaches text the record cut.';

export interface NoteOptions {
  cli?: boolean;
  /** The R8 answer protocol (default on). */
  protocol?: boolean;
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
  if (o.protocol ?? true) note += '\n' + PROTOCOL;
  if (o.guidance) note += '\n' + GUIDANCE;
  if (o.cli ?? true) note += '\n' + CLI_LINE;
  return note;
}
