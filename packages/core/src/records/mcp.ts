/**
 * `slopie mcp`: the one memory tool, `search`, as a stdio MCP server for harnesses without a shell.
 * Newline-delimited JSON-RPC 2.0. No SDK and no daemon: each call opens the index read-only, answers, and closes it.
 * The R5 tool names (read, threads, grep) still answer when called, but only `search` is listed.
 */
import {createInterface} from 'node:readline';
import {Engine, NoIndexError} from './engine.js';
import {MCP_INSTRUCTIONS, MCP_TOOLS} from './spec.js';

export interface McpOptions {
  recordsDir?: string;
  version: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

type Args = Record<string, unknown>;
const HIDDEN = new Set(['read', 'threads', 'grep']);

export function callTool(name: string, args: Args, recordsDir?: string): {text: string; isError: boolean} {
  if (name !== 'search' && !HIDDEN.has(name)) return {text: `unknown tool ${name}; the one tool is search`, isError: true};
  let engine: Engine;
  try {
    engine = new Engine(recordsDir, 'mcp');
  } catch (e) {
    return {text: e instanceof NoIndexError ? `${e.message} (the memory index is built by \`slopie sync\`).` : `memory unavailable: ${(e as Error).message}`, isError: true};
  }
  try {
    const s = (k: string) => (typeof args[k] === 'string' && args[k] !== '' ? (args[k] as string) : typeof args[k] === 'number' ? String(args[k]) : undefined);
    const n = (k: string) => (args[k] === undefined || args[k] === null || args[k] === '' ? undefined : Number(args[k]));
    if (name === 'search') {
      return {text: engine.find({query: s('query'), session: s('session'), turns: s('turns'), project: s('project'), harness: s('harness'), since: s('since'), until: s('until'), k: n('k')}), isError: false};
    }
    if (name === 'read') return {text: engine.read({session: s('session') ?? '', from_turn: n('from_turn') ?? null, to_turn: n('to_turn') ?? null, max_chars: n('max_chars') ?? null, from_char: n('from_char') ?? null}), isError: false};
    if (name === 'threads') return {text: engine.threads({project: s('project'), harness: s('harness'), since: s('since'), until: s('until'), text: s('text'), include_subagents: args['include_subagents'] === true, parent: s('parent'), limit: n('limit'), offset: n('offset')}), isError: false};
    return {text: engine.grep({session: s('session') ?? '', pattern: s('pattern') ?? '', regex: args['regex'] === true, offset: n('offset')}), isError: false};
  } catch (e) {
    return {text: `error: ${(e as Error).message}`, isError: true};
  } finally {
    engine.close();
  }
}

export function serveMcp(o: McpOptions): Promise<void> {
  const input = o.input ?? process.stdin, output = o.output ?? process.stdout;
  const send = (msg: unknown) => output.write(JSON.stringify(msg) + '\n');
  const reply = (id: unknown, result?: unknown, error?: {code: number; message: string}) => send({jsonrpc: '2.0', id, ...(error ? {error} : {result})});
  return new Promise(resolve => {
    const rl = createInterface({input});
    rl.on('line', line => {
      if (!line.trim()) return;
      let m: {id?: unknown; method?: string; params?: Args};
      try { m = JSON.parse(line) as typeof m; } catch { send({jsonrpc: '2.0', id: null, error: {code: -32700, message: 'parse error'}}); return; }
      if (m.id === undefined || m.id === null) return; // notifications
      const p = m.params ?? {};
      if (m.method === 'initialize') {
        reply(m.id, {protocolVersion: typeof p['protocolVersion'] === 'string' ? p['protocolVersion'] : '2025-06-18', capabilities: {tools: {}},
          serverInfo: {name: 'slopie', version: o.version}, instructions: MCP_INSTRUCTIONS});
      } else if (m.method === 'tools/list') {
        reply(m.id, {tools: MCP_TOOLS});
      } else if (m.method === 'tools/call') {
        const r = callTool(String(p['name'] ?? ''), (p['arguments'] as Args) ?? {}, o.recordsDir);
        reply(m.id, {content: [{type: 'text', text: r.text}], isError: r.isError});
      } else if (m.method === 'ping') {
        reply(m.id, {});
      } else {
        reply(m.id, undefined, {code: -32601, message: `method not found: ${m.method}`});
      }
    });
    rl.on('close', () => resolve());
  });
}
