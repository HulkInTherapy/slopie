/**
 * @potsherd/core: the audit (analytics, adapters, pricing, story), the shared source layer, and the records
 * (sync, search index, search/read/threads/grep, MCP spec, agent note, session-start hook).
 */
export * as paths from './paths.js';
export * as format from './format.js';
export { NoSqliteError, sqliteAvailable, sqliteDriverName } from './sqlite-driver.js';

export { Theme, stripAnsi, toAscii, type ThemeOptions } from './theme.js';
export { Card, table, fitLine, noteWidth, INDENT, type Row, type TableCell, type TableCellInput } from './render.js';

// ---------------------------------------------------------------- the audit
export * from './analytics/contracts.js';
export * from './analytics/launch-contracts.js';
export { createAuditSession, publicAuditSnapshot, composeJevJudgments } from './analytics/index.js';

export type {
  Harness,
  SessionStatus,
  SessionRecord,
  Exchange,
  ExchangeToolCall,
  SessionSource,
  ParseOptions,
  ParseResult,
  Adapter,
  AdapterStub,
  FormatProvenance,
} from './adapters/types.js';
export { HARNESSES, isAdapter } from './adapters/types.js';
export * as cursor from './adapters/cursor.js';
export * as gemini from './adapters/gemini.js';
export * as opencode from './adapters/opencode.js';
export * as copilot from './adapters/copilot.js';
export { cursorAdapter } from './adapters/cursor.js';
export { geminiAdapter } from './adapters/gemini.js';
export { opencodeAdapter } from './adapters/opencode.js';
export { copilotAdapter } from './adapters/copilot.js';
export * as markers from './markers.js';

// L2 — redaction. Runs before anything is written to the index (`03` §5).
export * as redaction from './redact.js';
export {
  redact,
  redactText,
  redactExchange,
  maskFor,
  secretDigest,
  containsMask,
  emptyCounts,
  tally,
  addCounts,
  countsJson,
  redactionRow,
  redactionLine,
  elideBinary,
  elideExchange,
  emptyElisions,
  addElisions,
  type Elisions,
  MASK_RE,
  SECRET_TYPES,
  type SecretType,
  type RedactionHit,
  type RedactionResult,
  type RedactionCounts,
} from './redact.js';

// ------------------------------------------------- privacy: ignore and forget
export {
  readIgnoreConfig,
  readIgnoreList,
  writeIgnoreList,
  addIgnored,
  removeIgnored,
  normalizeIgnoreEntry,
  matchesIgnoreEntry,
  isIgnoredProject,
  IGNORE_KEY,
  type IgnoreConfig,
  type IgnoreChange,
} from './ignore.js';
export { loadPolicy, assertPolicy, PolicyError, legacyForgotten, readForgetList, writeForgetList, forgetPath, type Policy, type ForgetEntry } from './sources/policy.js';

// ------------------------------------------------- the shared source layer
export { discover, listFiles, readCodexImports, archiveEvidenceDir, type Discovered } from './sources/discover.js';
export { sourceId } from './sources/identity.js';
export { forEachLine, forEachRecord } from './sources/lines.js';
export { readSession, parseClaude, parseCodex, parsePi, sniff, isoTs, toolInputSummary, type Session, type Turn, type Role, type Harness as SessionHarness } from './sources/sessions.js';

// ------------------------------------------------- the records
export * as records from './records/format.js';
export { syncRecords, acquireSyncLock, stateDir, SyncBusyError, FORMAT_VERSION, type SyncOptions, type SyncResult } from './records/sync.js';
export { runRecordsWorker, parseJob, type ParseJob, type ParseResult as RecordParseResult } from './records/worker.js';
export { RecordIndex, parseRecordText, ctxPrefix, INDEX_FILE } from './records/index-db.js';
export { Engine, NoIndexError, ftsQuery, type CallStyle } from './records/engine.js';
export { MCP_TOOLS, MCP_INSTRUCTIONS, NOTE_B_TEMPLATE } from './records/spec.js';
export { agentNote, CLI_LINE, GUIDANCE, SIDECAR_LINE, type NoteOptions } from './records/note.js';
export { serveMcp, callTool } from './records/mcp.js';
export { continuationPointer, hasRecord, parseHookInput, isContinuation, type HookInput } from './records/hook.js';

export { VERSION } from './version.js';
