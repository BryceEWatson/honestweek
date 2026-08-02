// Read-only, tool-neutral prompt ingestion for Claude Code and Codex JSONL.
// Returned records contain redacted prompt text only.

import { lstatSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readBoundedJsonlLines } from './bounded-jsonl.mjs';
import { promptIdentity, sha256 } from './prompt-identity.mjs';
import { createRedactor, redactWithAudit } from './redact.mjs';
import { localDateInTimezone } from './resolve-week.mjs';
import { matchConfiguredRepo, normalizeAttributionPath, resolveProjectsRoot } from './claude-adapter.mjs';

const MACHINE_TAGS = new Set(['command-name','command-message','command-args','task-notification','local-command-caveat','local-command-stdout','local-command-stderr','system-reminder','cross-session-message','scheduled-task','user-prompt-submit-hook']);
const CODEX_WRAPPERS = /^(?:<codex_delegation>|<environment_context>|<app-context>|<permissions|<collaboration_mode>|<recommended_plugins>|# AGENTS\.md|<skills_instructions>|<plugins_instructions>)/i;
const TEST_OK = /(?:\b[1-9]\d*\s+(?:passing|passed)\b|\ball tests passed\b|\btests? passed\b|\bPASS\b|# fail 0|✓)/i;
const VERIFY_BAD = /(?:build failed|compilation failed|tests? failed|\bFAIL\b(?!\s*0)|# fail [1-9])/i;
const TEST_COMMAND = /^(?:node(?:\.exe)?\s+--test|npm(?:\.cmd)?\s+(?:run\s+)?test|pnpm(?:\.cmd)?\s+(?:run\s+)?test|yarn(?:\.cmd)?\s+(?:run\s+)?test|python(?:3|\.exe)?\s+-m\s+pytest|pytest(?:\.exe)?|cargo(?:\.exe)?\s+test|go(?:\.exe)?\s+test)(?=\s|$)/i;
const COMMIT_COMMAND = /^git(?:\.exe)?(?:\s+-C\s+(?:"[^"]+"|'[^']+'|\S+))*\s+commit(?=\s|$)/i;
const SHELL_CONTROL = /[\r\n;&|]/;
const COMMIT_OK = /^\[[^\]\r\n]+ [0-9a-f]{7,40}\]/mi;
const CORRECTION = /^\s*(?:actually\b|correction\b|instead\b|rather\b|no,)/i;

function shellCommand(call) {
  let input = call?.input ?? call?.arguments;
  if (typeof input === 'string') {
    try { const parsed=JSON.parse(input);if(parsed&&typeof parsed==='object')input=parsed;else return input; }
    catch { return input; }
  }
  return input && typeof input === 'object' && typeof input.command === 'string' ? input.command : '';
}
function directJavascriptString(value, start) {
  const quote = value[start];
  if (quote !== "'" && quote !== '"') return null;
  let text = '';
  for (let index = start + 1; index < value.length; index += 1) {
    const char = value[index];
    if (char === quote) return { value: text, end: index + 1 };
    if (char === '\n' || char === '\r') return null;
    if (char !== '\\') { text += char; continue; }
    const escaped = value[++index];
    if (escaped === undefined) return null;
    const simple = { "'":"'", '"':'"', '\\':'\\', '/':'/', n:'\n', r:'\r', t:'\t', b:'\b', f:'\f' };
    if (Object.hasOwn(simple, escaped)) { text += simple[escaped]; continue; }
    const size = escaped === 'u' ? 4 : escaped === 'x' ? 2 : 0;
    if (!size) return null;
    const digits = value.slice(index + 1, index + 1 + size);
    if (!new RegExp(`^[0-9a-f]{${size}}$`, 'i').test(digits)) return null;
    text += String.fromCodePoint(Number.parseInt(digits, 16));
    index += size;
  }
  return null;
}
function customExecCommand(input) {
  if (typeof input !== 'string') return '';
  const body = input.replace(/^\s*\/\/ @exec:[^\r\n]*(?:\r?\n|$)/, '');
  const string = String.raw`(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*')`;
  const option = String.raw`(?:workdir\s*:\s*${string}|timeout_ms\s*:\s*\d+|login\s*:\s*(?:true|false)|sandbox_permissions\s*:\s*${string}|justification\s*:\s*${string})`;
  const pattern = new RegExp(String.raw`^\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+tools\.shell_command\s*\(\s*\{\s*command\s*:\s*(${string})(?:\s*,\s*${option})*\s*\}\s*\)\s*;\s*text\s*\(\s*\1\s*\)\s*;?\s*$`);
  const match = pattern.exec(body);
  if (!match) return '';
  const parsed = directJavascriptString(match[2], 0);
  return parsed?.end === match[2].length ? parsed.value : '';
}
function verificationKind(call) {
  const command=shellCommand(call).trim();
  if(!command||SHELL_CONTROL.test(command))return null;
  if(TEST_COMMAND.test(command))return'test';
  if(COMMIT_COMMAND.test(command))return'commit';
  return null;
}
function explicitExitCode(output) {
  if(output&&typeof output==='object')for(const key of ['exit_code','exitCode','code'])if(Number.isInteger(output[key]))return output[key];
  const text=typeof output==='string'?output:JSON.stringify(output??'');
  const match=/(?:Process exited with code|Exit code:)\s*(-?\d+)\b/i.exec(text);
  return match?Number(match[1]):null;
}
function positiveVerification(kind,result){return kind==='commit'?COMMIT_OK.test(result):TEST_OK.test(result);}

export function resolvePromptRoots(env = process.env) {
  const codexBase = env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(homedir(), '.codex');
  return { 'claude-code': resolveProjectsRoot(env), codex: codexBase };
}

function regular(path) {
  try { const s = lstatSync(path); return s.isFile() && !s.isSymbolicLink(); } catch { return false; }
}
function directory(path) {
  try { const s = lstatSync(path); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; }
}
function rootState(path){try{const s=lstatSync(path);if(!s.isDirectory()||s.isSymbolicLink())return'unreadable';readdirSync(path);return'present';}catch(err){return err?.code==='ENOENT'?'absent':'unreadable';}}
function within(root, path) {
  const r = relative(resolve(root), resolve(path));
  return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r));
}
function walk(root) {
  if (!directory(root)) return [];
  const out = []; const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name); if (!within(root, p)) continue;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory() && e.name !== 'subagents') stack.push(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  }
  return out.sort();
}

export function enumeratePromptFiles(source, root) {
  if (source === 'claude-code') {
    const out = [];
    for (const project of readdirSync(root, { withFileTypes: true })) {
      if (!project.isDirectory() || project.isSymbolicLink()) continue;
      const dir = join(root, project.name);
      if (!directory(dir)) continue;
      // Prompt identity is strict: any unreadable project directory makes the
      // source unreadable instead of silently presenting an incomplete week.
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = join(dir, entry.name);
        if (entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.jsonl') && regular(file)) out.push(file);
      }
    }
    return out.sort();
  }
  return ['sessions', 'archived_sessions'].flatMap((name) => walk(join(root, name))).sort();
}

function claudeText(row) {
  if (row?.type !== 'user') return null;
  const text = typeof row.message?.content === 'string' ? row.message.content : typeof row.content === 'string' ? row.content : null;
  if (!text?.trim()) return null;
  const tag = /^\s*<([a-z0-9-]+)(?:\s|>)/i.exec(text)?.[1]?.toLowerCase();
  return tag && MACHINE_TAGS.has(tag) ? null : text;
}
function codexText(row) {
  const p = row?.payload;
  if (row?.type !== 'event_msg' || p?.type !== 'user_message' || typeof p.message !== 'string' || !p.message.trim()) return null;
  return CODEX_WRAPPERS.test(p.message.trim()) ? null : p.message;
}
function timestamp(row) { return row?.timestamp ?? row?.message?.timestamp ?? row?.payload?.timestamp ?? null; }

function repoAttribution(cwd, config) {
  if (typeof cwd !== 'string' || !cwd) return { repoKey: null, project: null, isPrivate: true };
  const repo=matchConfiguredRepo(cwd,config);
  if (!repo || repo.role === 'display') return { repoKey: null, project: null, isPrivate: true };
  return { repoKey: sha256(normalizeAttributionPath(repo.resolvedPath ?? repo.path,cwd)), project: createRedactor(config).redact(repo.label), isPrivate: false };
}

async function adaptFile(file, source, { config, weekStart, weekEnd }) {
  let rawSessionId=null,fileCwd=null,currentCwd=null,turn=0,malformed=0,currentPrompt=null;
  const provisional=[];let shellCalls=new Map();let seenCalls=new Set();let seenOutputs=new Set();
  const finalize=(p)=>{if(p)p.observedVerification=p._verificationPassed&&!p._verificationFailed;};
  const rememberCall=(id,kind,outputType)=>{if(!id)return;if(seenCalls.has(id)||seenOutputs.has(id)){shellCalls.delete(id);currentPrompt._verificationFailed=true;return;}seenCalls.add(id);if(kind)shellCalls.set(id,{kind,outputType});};
  const applyOutput=(id,output,outputType)=>{if(!id)return;if(seenOutputs.has(id)){currentPrompt._verificationFailed=true;return;}seenOutputs.add(id);const call=shellCalls.get(id);shellCalls.delete(id);if(!call)return;if(call.outputType!==outputType){currentPrompt._verificationFailed=true;return;}const result=typeof output==='string'?output:JSON.stringify(output??'');const exitCode=explicitExitCode(output);if(exitCode!==0||VERIFY_BAD.test(result))currentPrompt._verificationFailed=true;else if(positiveVerification(call.kind,result))currentPrompt._verificationPassed=true;};
  for await(const line of readBoundedJsonlLines(file)){
    if(!line.trim())continue;let r;try{r=JSON.parse(line);}catch{malformed++;continue;}
    const p=r?.payload;
    if(source==='codex'&&r?.type==='session_meta'){
      const id=p?.id;if(rawSessionId&&id&&id!==rawSessionId)throw new Error('conflicting Codex session id');rawSessionId??=id;fileCwd??=p?.cwd;currentCwd??=p?.cwd;
    }else if(source==='claude-code'){
      const id=r.sessionId??r.session_id;if(rawSessionId&&id&&id!==rawSessionId)throw new Error('conflicting Claude session id');rawSessionId??=id;fileCwd??=r.cwd;currentCwd??=r.cwd;
    }
    if(source==='codex'&&r?.type==='turn_context'&&typeof p?.cwd==='string')currentCwd=p.cwd;
    const raw=source==='claude-code'?claudeText(r):codexText(r);
    if(raw!==null){
      if(currentPrompt){currentPrompt._followOnCorrectionTurn=CORRECTION.test(raw)?turn+1:null;finalize(currentPrompt);}
      turn++;shellCalls=new Map();seenCalls=new Set();seenOutputs=new Set();currentPrompt=null;
      const ts=timestamp(r),time=new Date(ts);
      if(ts&&!Number.isNaN(time.getTime())&&time>=weekStart&&time<weekEnd){
        const attr=repoAttribution(r.cwd??currentCwd??fileCwd,config);const audit=redactWithAudit(raw,config,{isPrivate:attr.isPrivate});
        currentPrompt={source,turn,timestamp:time.toISOString(),repoKey:attr.repoKey,project:attr.project,isPrivate:attr.isPrivate,state:'inbox',sourceHash:sha256(raw),contentHash:sha256(audit.text),text:audit.text,redactionCount:audit.redactionCount,sourceLength:audit.sourceLength,changedPercent:audit.changedPercent,rawRisk:audit.rawRisk,rawDetectors:audit.rawDetectors,redactionOps:audit.redactionOps,truncated:audit.truncated,followOnCorrection:false,observedVerification:false,_followOnCorrectionTurn:null,_verificationPassed:false,_verificationFailed:false};
        provisional.push(currentPrompt);
      }
      continue;
    }
    if(!currentPrompt)continue;
    if(source==='claude-code'){
      for(const b of Array.isArray(r?.message?.content)?r.message.content:[]){
        if(b?.type==='tool_use'&&['Bash','shell_command','exec_command'].includes(b.name)&&b.id){const kind=verificationKind(b);if(kind)shellCalls.set(b.id,kind);}
        if(b?.type==='tool_result'&&shellCalls.has(b.tool_use_id)){const result=typeof b.content==='string'?b.content:JSON.stringify(b.content??'');const kind=shellCalls.get(b.tool_use_id);if(b.is_error!==false||VERIFY_BAD.test(result))currentPrompt._verificationFailed=true;else if(positiveVerification(kind,result))currentPrompt._verificationPassed=true;}
      }
    }else{
      if(r?.type==='response_item'&&p?.type==='function_call'){
        const kind=['shell_command','exec_command'].includes(p.name)?verificationKind(p):null;rememberCall(p.call_id||p.id,kind,'function_call_output');
      }
      if(r?.type==='response_item'&&p?.type==='custom_tool_call'){
        const command=p.name==='exec'&&p.status==='completed'?customExecCommand(p.input):'';rememberCall(p.call_id||p.id,command?verificationKind({input:{command}}):null,'custom_tool_call_output');
      }
      if(r?.type==='response_item'&&['function_call_output','custom_tool_call_output'].includes(p?.type))applyOutput(p.call_id||p.id,p.output,p.type);
      if((r?.type==='event_msg'&&p?.type==='turn_aborted')||r?.type==='turn_aborted')currentPrompt._verificationFailed=true;
    }
  }
  finalize(currentPrompt);if(malformed){const err=new Error('malformed JSONL makes prompt turn identity unreadable');err.malformedLines=malformed;throw err;}
  if(source==='codex'&&!rawSessionId)throw new Error('missing Codex session id');rawSessionId||=file.split(/[\\/]/).pop().replace(/\.jsonl$/,'');
  const prompts=provisional.map((p)=>{const{_verificationPassed,_verificationFailed,...safe}=p;return{...promptIdentity(source,rawSessionId,p.turn),...safe};});
  return{prompts,malformed};
}

export async function scanPromptSources({ config, weekStart, weekEnd, roots = resolvePromptRoots(), now = new Date() }) {
  const prompts = []; const sourceStatus = {};
  const weekStartKey=localDateInTimezone(weekStart,config.week.timezone).toISOString().slice(0,10);
  const weekEndKey=localDateInTimezone(new Date(weekEnd.getTime()-1),config.week.timezone).toISOString().slice(0,10);
  for (const source of ['claude-code', 'codex']) {
    const root = roots[source];
    const state=rootState(root);
    if (state !== 'present') {
      sourceStatus[source] = { state, weekStart: weekStartKey, weekEnd: weekEndKey, syncedAt: now.toISOString(), records: 0, malformedLines: 0 };
      continue;
    }
    let malformedLines = 0;const sourcePrompts=[];
    try{
      const files = enumeratePromptFiles(source, root);
      for (const file of files) { const got = await adaptFile(file, source, { config, weekStart, weekEnd }); sourcePrompts.push(...got.prompts); malformedLines += got.malformed; }
    }catch(err){
      malformedLines+=err?.malformedLines??0;sourceStatus[source] = { state:'unreadable', weekStart:weekStartKey, weekEnd:weekEndKey, syncedAt:now.toISOString(), records:0, malformedLines };
      continue;
    }
    prompts.push(...sourcePrompts);
    sourceStatus[source] = { state: 'present', weekStart: weekStartKey, weekEnd: weekEndKey, syncedAt: now.toISOString(), records: sourcePrompts.length, malformedLines };
  }
  prompts.sort((a,b) => `${a.timestamp}|${a.source}|${a.sessionKey}|${a.turn}|${a.ref}`.localeCompare(`${b.timestamp}|${b.source}|${b.sessionKey}|${b.turn}|${b.ref}`));
  return { prompts, sourceStatus };
}
