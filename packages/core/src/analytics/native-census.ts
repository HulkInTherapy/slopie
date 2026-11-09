import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {expandTilde} from '../paths.js';
import type {AuditHarness,AuditOverviewOptions} from './contracts.js';
export interface NativeSourceFile {file:string;harness:AuditHarness;bytes:number;kind:'jsonl'|'database'|'opencode-json';}
const list=(s:string)=>s.split(',').map(p=>p.trim()).filter(Boolean).map(p=>path.resolve(expandTilde(p))).filter((p,i,a)=>a.indexOf(p)===i);
/** Explicit inputs never fall through into personal roots. Default Claude follows both conventional roots. */
export function nativeAuditRoots(harness:AuditHarness,options:AuditOverviewOptions,env:NodeJS.ProcessEnv=process.env,home=os.homedir()):string[]{
 if(harness==='claude'){const configured=options.claudeDir??env.CLAUDE_CONFIG_DIR;const roots=configured?list(configured):[path.join(env.XDG_CONFIG_HOME&&path.isAbsolute(env.XDG_CONFIG_HOME)?env.XDG_CONFIG_HOME:path.join(home,'.config'),'claude'),path.join(home,'.claude')];return [...new Set(roots.map(p=>path.basename(p)==='projects'?p:path.join(p,'projects')))];}
 if(harness==='codex'){const roots=list(options.codexDir??env.POTSHERD_CODEX_DIR??env.CODEX_HOME??path.join(home,'.codex'));return [...new Set(roots.flatMap(p=>['sessions','archived_sessions'].includes(path.basename(p))?[p]:[path.join(p,'sessions'),path.join(p,'archived_sessions')]))];}
 if(harness==='pi'){if(!options.piDir&&!env.POTSHERD_PI_DIR&&env.PI_CODING_AGENT_DIR)return list(env.PI_CODING_AGENT_DIR).map(p=>path.join(p,'sessions'));if(!options.piDir&&!env.POTSHERD_PI_DIR&&env.PI_AGENT_DIR)return list(env.PI_AGENT_DIR);return list(options.piDir??env.POTSHERD_PI_DIR??path.join(home,'.pi')).map(p=>path.join(p,'agent','sessions'));}
 return list(options.opencodeDir??env.POTSHERD_OPENCODE_DIR??env.OPENCODE_DATA_DIR??path.join(env.XDG_DATA_HOME&&path.isAbsolute(env.XDG_DATA_HOME)?env.XDG_DATA_HOME:path.join(home,'.local','share'),'opencode'));
}

/**
 * Claude desktop's agent mode runs Claude Code sessions in per-session homes:
 * <Claude app data>/local-agent-mode-sessions/<...>/.claude/projects. Those transcripts are ordinary
 * Claude transcripts (dated, with usage), read read-only as extra Claude roots. Not followed when the
 * Claude root is set explicitly (explicit inputs never fall through into personal roots), unless
 * POTSHERD_CLAUDE_DESKTOP_DIR names the sessions directory.
 */
export function claudeDesktopRoots(options:AuditOverviewOptions,env:NodeJS.ProcessEnv=process.env,home=os.homedir()):string[]{
 const explicit=env.POTSHERD_CLAUDE_DESKTOP_DIR;
 if(!explicit&&(options.claudeDir??env.CLAUDE_CONFIG_DIR))return [];
 const base=explicit?path.resolve(expandTilde(explicit)):path.join(home,'Library','Application Support','Claude','local-agent-mode-sessions');
 const out:string[]=[];
 const walk=(dir:string,depth:number)=>{
  let entries:fs.Dirent[];
  try{entries=fs.readdirSync(dir,{withFileTypes:true});}catch{return;}
  for(const e of entries){
   if(!e.isDirectory())continue;
   const p=path.join(dir,e.name);
   if(e.name==='.claude'){const projects=path.join(p,'projects');if(fs.existsSync(projects))out.push(projects);continue;}
   if(depth<6&&!e.name.startsWith('.'))walk(p,depth+1);
  }
 };
 walk(base,0);
 return out.sort();
}
