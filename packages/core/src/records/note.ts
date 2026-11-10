/**
 * The agent note (the body of the one `slopie` skill): the record format (R5 NOTE_B as extended through R8, with the
 * records path filled in), the R8 answer protocol, and one line on `slopie search`.
 */
import {NOTE_B_TEMPLATE} from './spec.js';

/**
 * The `slopie search` recipes, first in the note (1.9.1): the three most useful calls before the format. R6 measured
 * the four-verb form as arm P2; the one-verb form is arm P3.
 */
export const CLI_LINE = "Your past coding-agent sessions with the user (Claude Code, Codex, pi) are searchable. If the slopie command is on PATH, start with it rather than rg:\n"
  + '- find: slopie search <words> [--project P --since D]  (add --session ID to search inside one thread)\n'
  + "- read a session's end: slopie search --session ID --turns -30  (--turns 120-160 reads a range)\n"
  + '- latest: slopie search <words> --latest  (threads with these words, newest activity first)\n'
  + 'Each reply starts with the index age and ends with the exact next command. Use rg/sed on the files below for anything else.';

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
  const cli = o.cli ?? true;
  if (o.sidecar) {
    const lines = note.split('\n');
    lines.splice(lines.length - 1, 0, SIDECAR_LINE);
    note = lines.join('\n');
  }
  if (o.protocol ?? true) note += '\n' + PROTOCOL;
  if (o.guidance) note += '\n' + GUIDANCE;
  return cli ? CLI_LINE + '\n\n' + note : note;
}
