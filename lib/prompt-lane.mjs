import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePromptRoots, scanPromptSources } from './prompt-adapters.mjs';
import { curatePrompts } from './prompt-curation.mjs';
import { mergePromptStore, PROMPT_LANE, PROMPT_STORE, readPromptStore } from './prompt-store.mjs';
import { localDateRangeInstants } from './resolve-week.mjs';
import { loadSiteAdapter } from './site/load-adapter.mjs';
import { sha256 } from './prompt-identity.mjs';

function preflightError(message) {
  const error = new Error(message);
  error.promptPreflight = true;
  return error;
}

export async function preflightPromptOutput({cwd,config,hasGoals=false}){
  if(!['page','site'].includes(config.output.mode))throw preflightError('prompt highlights render only in page or site mode; update output.mode, then rerun prompts curate.');
  if(config.output.mode==='page'&&hasGoals)throw preflightError('prompt-bearing page builds cannot yet be combined with the goals registry transaction.');
  let adapterHash=null;if(config.output.mode==='site'){
    const path=config.output.adapter;if(!path||!existsSync(path))throw preflightError('site prompt output adapter is missing; prompt sidecars were not changed.');
    try{await loadSiteAdapter(path);adapterHash=sha256(`${path}\0${sha256(readFileSync(path))}`);}catch(e){throw preflightError(`site prompt output adapter is unusable (${e.message}).`);}
  }
  return{mode:config.output.mode,adapterHash,objectives:false};
}

function normalized(value) {
  const copy=structuredClone(value);copy.generatedAt='<clock>';
  for(const s of ['claude-code','codex'])if(copy.sourceStatus?.[s])copy.sourceStatus[s].syncedAt='<clock>';
  return copy;
}

export async function loadValidatedPromptLane({cwd,config,week,now=new Date(),roots=resolvePromptRoots(),hasGoals=false}){
  const path=join(cwd,PROMPT_LANE);if(!existsSync(path))return{items:[],lane:null};
  const initialLaneBytes=readFileSync(path,'utf8');let lane;try{lane=JSON.parse(initialLaneBytes);}catch(e){throw new Error(`${PROMPT_LANE} is not valid JSON (${e.message}); rerun honestweek prompts curate.`);}
  if(!lane||lane.version!==1||!Array.isArray(lane.items)||!lane.week)throw new Error(`${PROMPT_LANE} has an unsupported schema; rerun honestweek prompts curate.`);
  const outputBinding=lane.items.length?await preflightPromptOutput({cwd,config,hasGoals}):lane.outputBinding;
  if(lane.week.start!==week.start||lane.week.end!==week.end)throw new Error(`${PROMPT_LANE} is for another week; rerun honestweek prompts curate.`);
  const storePath=join(cwd,PROMPT_STORE);const initialStoreBytes=readFileSync(storePath,'utf8');const store=readPromptStore(cwd);
  const range=localDateRangeInstants(week.start,week.end,config.week.timezone);
  const scanned=await scanPromptSources({config,weekStart:range.start,weekEnd:range.endExclusive,roots,now});
  if(Object.values(scanned.sourceStatus).every((s)=>s.state==='absent'))throw new Error('no Claude Code or Codex prompt source is available; rerun honestweek prompts curate when a source is present.');
  const freshStore=mergePromptStore(store,scanned,now);const rebuilt=curatePrompts(freshStore,config,week,now,{outputBinding});
  if(readFileSync(path,'utf8')!==initialLaneBytes||readFileSync(storePath,'utf8')!==initialStoreBytes)throw new Error('prompt controls changed during validation; rerun honestweek prompts curate.');
  if(JSON.stringify(normalized(lane))!==JSON.stringify(normalized(rebuilt)))throw new Error(`${PROMPT_LANE} is stale or non-canonical; rerun honestweek prompts curate.`);
  return{items:lane.items,lane};
}
