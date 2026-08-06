import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.mjs';
import { localDateInTimezone, localDateRangeInstants, resolveWeek } from './resolve-week.mjs';
import { resolvePromptRoots, scanPromptSources } from './prompt-adapters.mjs';
import { mergePromptStore, PROMPT_GITIGNORE, PROMPT_LANE, readPromptStore, uniquePrompt, writePromptStore } from './prompt-store.mjs';
import { curatePrompts, evaluatePrompts, writePromptLane } from './prompt-curation.mjs';
import { ensureGitignore } from './init.mjs';
import { preflightPromptOutput } from './prompt-lane.mjs';
import { withPromptLock } from './prompt-lock.mjs';
import { assertNoDigestPending } from './digest-store.mjs';
import { assertNoCarryPending } from './digest-carry.mjs';
import { recoverConfiguredCarry } from './carry-recovery.mjs';

function ioDefault(){return{out:(s)=>process.stdout.write(s),err:(s)=>process.stderr.write(s),exit:(c)=>process.exit(c)};}
function flag(argv,name){const i=argv.indexOf(name);return i>=0?argv[i+1]:undefined;}
function weekFor(config,argv,now){const today=localDateInTimezone(now,config.week.timezone);const w=resolveWeek({today,weekArg:flag(argv,'--week')});const start=w.weekStart.toISOString().slice(0,10),end=w.weekEnd.toISOString().slice(0,10),range=localDateRangeInstants(start,end,config.week.timezone);return{start,end,weekStart:range.start,weekEndExclusive:range.endExclusive};}
function prefixes(prompts){return new Map(prompts.map((p)=>{let n=12;while(n<64&&prompts.some((x)=>x!==p&&x.ref.slice(0,n)===p.ref.slice(0,n)))n++;return[p.ref,p.ref.slice(0,n)];}));}
function nextPageCommand(command, args, offset) {
  const kept=[];
  for(let i=0;i<args.length;i++){if(args[i]==='--offset'){i++;continue;}kept.push(args[i]);}
  return `honestweek prompts ${command}${kept.length?` ${kept.join(' ')}`:''} --offset ${offset}`;
}
function activeLaneVersion(cwd) {
  try { return JSON.parse(readFileSync(join(cwd, PROMPT_LANE), 'utf8'))?.version ?? null; }
  catch { return null; }
}

async function sync(cwd,config,argv,now,roots){
  const w=weekFor(config,argv,now); const old=readPromptStore(cwd,{optional:true});
  const scanned=await scanPromptSources({config,weekStart:w.weekStart,weekEnd:w.weekEndExclusive,roots,now});
  const store=mergePromptStore(old,scanned,now);
  for (const entry of PROMPT_GITIGNORE) ensureGitignore(cwd, entry);
  writePromptStore(cwd,store);return store;
}

function mutate(cwd,store,ref,state,now){const p=uniquePrompt(store,ref);if(state==='deleted'){const status=store.sourceStatus[p.source];store.version=2;store.prompts=store.prompts.filter((x)=>x.ref!==p.ref);store.tombstones.push({ref:p.ref,refCanonical:p.refCanonical,source:p.source,sessionKey:p.sessionKey,turn:p.turn,deletedAt:now.toISOString(),week:{start:status.weekStart,end:status.weekEnd}});store.tombstones.sort((a,b)=>a.ref.localeCompare(b.ref));}else p.state=state;store.generatedAt=now.toISOString();writePromptStore(cwd,store);return p;}

export async function runPrompts({cwd=process.cwd(),argv=[],now=new Date(),io=ioDefault(),roots}={}){
  let config;try{config=loadConfig(join(cwd,'honestweek.config.json'));}catch(e){io.err(`prompts: ${e.message}\n`);return io.exit(1)??1;}
  const [command,...rest]=argv;
  let privateInboxUpdated = false;
  if(!command||['-h','--help'].includes(command)){io.out('Usage: honestweek prompts <sync|list|source|review|keep|hide|delete|curate> [options]\n');return 0;}
  try{
    return await withPromptLock(cwd,async()=>{
      assertNoDigestPending(cwd);
      await recoverConfiguredCarry({
      cwd,config,hasGoals:existsSync(join(cwd,'honestweek.objectives.json')),
      });
      assertNoCarryPending(cwd);
    if(command==='sync'){
      const store=await sync(cwd,config,rest,now,roots??resolvePromptRoots());
      io.out(`prompts sync: private inbox updated with ${store.prompts.length} prompt(s). Claude Code ${store.sourceStatus['claude-code'].state}; Codex ${store.sourceStatus.codex.state}.\n`);return 0;
    }
    if(command==='curate'){
      const outputBinding=await preflightPromptOutput({cwd,config,hasGoals:existsSync(join(cwd,'honestweek.objectives.json'))});
      let replacedDigest=false;try{replacedDigest=JSON.parse(readFileSync(join(cwd,PROMPT_LANE),'utf8'))?.version===2;}catch{}
      const w=weekFor(config,rest,now);const fresh=await sync(cwd,config,rest,now,roots??resolvePromptRoots());privateInboxUpdated=true;if(Object.values(fresh.sourceStatus).every((s)=>s.state==='absent'))throw new Error('no Claude Code or Codex prompt source is available; prompt lane not updated.');const lane=curatePrompts(fresh,config,{start:w.start,end:w.end},now,{outputBinding});writePromptLane(cwd,lane);
      const counts=Object.entries(lane.withheld).map(([k,v])=>`${k}=${v}`).join(', ');const keeps=lane.items.filter((x)=>x.curationState==='kept').length;io.out(`prompts curate: selected ${lane.items.length}; ${counts}. Automatic cap ${lane.policy.automaticCap}.${keeps>0&&lane.items.length>lane.policy.automaticCap?' Explicit keeps exceeded the automatic target.':''} Claude Code ${lane.sourceStatus['claude-code'].state}; Codex ${lane.sourceStatus.codex.state}.${replacedDigest?' Replaced the balanced version 2 lane with a prompt-only version 1 lane.':''}\n`);return 0;
    }
    if(command==='keep'||command==='hide'||command==='delete'){
      const store=readPromptStore(cwd);
      if(command==='delete'){if(!rest.includes('--yes'))throw new Error('delete requires --yes.');const laneVersion=activeLaneVersion(cwd);const p=mutate(cwd,store,rest[0],'deleted',now);const refresh=laneVersion===2?'honestweek digest prepare':'honestweek prompts curate';io.out(`prompts delete: removed private prompt ${p.ref.slice(0,12)} and left a no-text tombstone. This cannot recall ${PROMPT_LANE} or ${config.output.file??'the built page'}. Run ${refresh}, honestweek validate, then honestweek build; remove the local output now if needed.\n`);return 0;}
      const p=mutate(cwd,store,rest[0],command==='keep'?'kept':'hidden',now);io.out(`prompts ${command}: ${p.ref.slice(0,12)} is ${command==='keep'?'kept':'hidden'}. Keep never overrides receipt or privacy gates.\n`);return 0;
    }
    const store=readPromptStore(cwd);
    if(command==='list'||command==='review'){
      const w=weekFor(config,rest,now);const state=flag(rest,'--state')??(command==='review'?'all':'active');const limit=Number(flag(rest,'--limit')??50),offset=Number(flag(rest,'--offset')??0);
      if(!Number.isInteger(limit)||limit<1||limit>200||!Number.isInteger(offset)||offset<0)throw new Error('limit must be 1..200 and offset must be nonnegative.');
      const localPromptDate=(p)=>localDateInTimezone(new Date(p.timestamp),config.week.timezone).toISOString().slice(0,10);
      let decisions=null;let rows=store.prompts.filter((p)=>localPromptDate(p)>=w.start&&localPromptDate(p)<=w.end);
      if(command==='review'){
        const evaluated=evaluatePrompts(store,config,{start:w.start,end:w.end}).evaluated;const wanted=flag(rest,'--decision')??'all';
        const allowed=new Set(['below-automatic-floor','needs-approval','high-risk','all']);if(!allowed.has(wanted))throw new Error('review --decision must be below-automatic-floor, needs-approval, high-risk, or all.');
        const rank=new Map(['hidden','private-source','high-risk','needs-approval','below-automatic-floor','capacity','public-renditions-disabled'].map((x,i)=>[x,i]));
        const reviewRows=evaluated.filter((e)=>e.decision!=='automatic-safe'&&(wanted==='all'||e.decision===wanted)).sort((a,b)=>(rank.get(a.decision)??99)-(rank.get(b.decision)??99)||b.score-a.score||a.p.timestamp.localeCompare(b.p.timestamp)||a.p.ref.localeCompare(b.p.ref));
        decisions=new Map(reviewRows.map((e)=>[e.p.ref,e]));rows=reviewRows.map((e)=>e.p);
      }
      if(state==='active')rows=rows.filter((p)=>p.state!=='hidden');else if(state!=='all')rows=rows.filter((p)=>p.state===state);
      const pre=prefixes(store.prompts);for(const p of rows.slice(offset,offset+limit)){const e=decisions?.get(p.ref);io.out(`${pre.get(p.ref)}  ${p.state}  ${p.source}  ${p.timestamp}  ${p.project??'private'}${e?`  decision=${e.decision} score=${e.score} reason=${e.p.state==='kept'?'explicit keep':e.codes.join(',')||e.decision}`:''}  ${[...p.text].slice(0,120).join('')} [source session ${p.sessionKey.slice(0,12)} turn ${p.turn}]\n`);}
      if(command==='review')io.out('Review controls: use prompts hide <ref> or prompts delete <ref> --yes. Keep cannot override receipt or privacy gates.\n');
      const shown=Math.min(limit,Math.max(0,rows.length-offset));const remaining=Math.max(0,rows.length-offset-shown);const start=shown?offset+1:0;const end=shown?offset+shown:0;
      io.out(`prompts ${command}: showing ${start}-${end} of ${rows.length}; remaining ${remaining}.${remaining?` Next: ${nextPageCommand(command,rest,offset+shown)}.`:''}\n`);return 0;
    }
    if(command==='source'){
      const p=uniquePrompt(store,rest[0]);const status=store.sourceStatus[p.source];const range=localDateRangeInstants(status.weekStart,status.weekEnd,config.week.timezone);
      const fresh=(await scanPromptSources({config,weekStart:range.start,weekEnd:range.endExclusive,roots:roots??resolvePromptRoots(),now})).prompts.filter((x)=>x.ref===p.ref&&x.sourceHash===p.sourceHash&&x.contentHash===p.contentHash);
      if(fresh.length!==1)throw new Error('source receipt is stale, missing, or ambiguous; no text shown.');io.out(`${fresh[0].text}\n[source ${fresh[0].source} session ${fresh[0].sessionKey.slice(0,12)} turn ${fresh[0].turn}]\n`);return 0;
    }
    throw new Error(`unknown prompts command ${JSON.stringify(command)}.`);
    });
  }catch(e){
    if(privateInboxUpdated)io.err('prompts: private inbox updated; prompt lane not updated; rerun honestweek prompts curate.\n');
    io.err(`prompts: ${e.message}\n`);const code=command==='list'||command==='source'||e?.promptPreflight?1:2;return io.exit(code)??code;
  }
}

export default function run(argv){return runPrompts({argv});}
