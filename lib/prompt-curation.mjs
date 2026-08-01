import { sha256, promptItemIdentity } from './prompt-identity.mjs';
import { atomicWriteJson } from './atomic-json.mjs';
import { PROMPT_LANE } from './prompt-store.mjs';
import { join } from 'node:path';
import { assessPublicRendition } from './redact.mjs';
import { localDateInTimezone } from './resolve-week.mjs';
import { hasRecurringText } from './curation-similarity.mjs';

const SIGNALS = ['recurs','observed-verification','follow-on-correction','decision-request','reversal-request','next-step-request'];
const WEIGHT_KEYS = { recurs:'recurs', 'observed-verification':'observed-verification', 'follow-on-correction':'follow-on-correction', 'decision-request':'decision-request', 'reversal-request':'reversal-request', 'next-step-request':'next-step-request' };
const REASONS = { recurs:'recurred across sessions', 'observed-verification':'followed by observed verification', 'follow-on-correction':'was refined in a later turn', 'decision-request':'asked for an explicit decision', 'reversal-request':'asked to change direction', 'next-step-request':'named follow-up work' };
const WITHHELD = ['below-automatic-floor','hidden','private-source','needs-approval','high-risk','capacity','public-renditions-disabled'];
function recurs(a,b) { return a.sessionKey !== b.sessionKey && hasRecurringText(a.text,b.text); }
function cue(text, words, phrases=[]) { const s=text.normalize('NFKC').toLowerCase(); return [...words,...phrases].some((value)=>{const escaped=value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/\s+/g,'\\s+');return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`,'u').test(s);}); }
function signalsFor(p, all) {
  const out=[];
  if(all.some((x)=>x.ref!==p.ref&&recurs(p,x)))out.push('recurs');
  if(p.observedVerification)out.push('observed-verification');
  if(p.followOnCorrection)out.push('follow-on-correction');
  if(cue(p.text,['decide','decision','choose'],['settle on']))out.push('decision-request');
  if(cue(p.text,['instead','revert','reverse'],['change course','no longer']))out.push('reversal-request');
  if(cue(p.text,['next','todo','later'],['follow up']))out.push('next-step-request');
  return out;
}
function excerpt(text){const c=[...text];if(c.length<=160)return text;const first=c.slice(0,159).join('');const cut=first.search(/\s+\S*$/u);return `${(cut>0?first.slice(0,cut):first).trimEnd()}…`;}
function sourceLabel(s){return s==='claude-code'?'Claude Code':'Codex';}
function promptDate(p,config){return localDateInTimezone(new Date(p.timestamp),config.week.timezone).toISOString().slice(0,10);}

export function evaluatePrompts(store,config,week){
  const live=store.prompts.filter((p)=>promptDate(p,config)>=week.start&&promptDate(p,config)<=week.end);
  const weights=config.curation.weights, floor=config.curation.automaticMinScore, cap=config.curation.categoryCaps.prompts;
  const evaluated=live.map((p)=>{const codes=signalsFor(p,live);return{p,codes,score:codes.reduce((n,c)=>n+(weights[WEIGHT_KEYS[c]]??0),0)};});
  const eligible=[];
  for(const e of evaluated){
    const p=e.p; let why=null;
    if(p.state==='hidden')why='hidden'; else if(p.isPrivate)why='private-source';
    else if(assessPublicRendition(p.text,config)==='high')why='high-risk';
    else if(p.truncated||p.changedPercent>config.privacy.publicRenditions.maxAutomaticChangedPercent||p.rawDetectors.includes('capitalized-unknown'))why='needs-approval';
    else if(p.state!=='kept'&&(e.score<floor||!e.codes.some((c)=>c==='recurs'||c==='observed-verification')))why='below-automatic-floor';
    if(why)e.decision=why;else eligible.push(e);
  }
  const kept=eligible.filter((e)=>e.p.state==='kept');
  const automatic=eligible.filter((e)=>e.p.state!=='kept').sort((a,b)=>b.score-a.score||a.p.timestamp.localeCompare(b.p.timestamp)||a.p.ref.localeCompare(b.p.ref));
  let selected=[...kept,...automatic.slice(0,cap)];for(const e of automatic.slice(cap))e.decision='capacity';
  if(!config.privacy.publicRenditions.enabled){for(const e of selected)e.decision='public-renditions-disabled';selected=[];}else for(const e of selected)e.decision='automatic-safe';
  const withheld=Object.fromEntries(WITHHELD.map((x)=>[x,0]));for(const e of evaluated)if(e.decision!=='automatic-safe')withheld[e.decision]++;
  return{live,evaluated,selected,withheld,kept,cap};
}

export function curatePrompts(store, config, week, now = new Date(), {outputBinding={mode:config.output.mode,adapterHash:null,objectives:false}} = {}) {
  const {live,selected,withheld,kept,cap}=evaluatePrompts(store,config,week);
  const weights=config.curation.weights, floor=config.curation.automaticMinScore;
  const excessKeeps=kept.length>0&&selected.length>cap;
  const coverage=`Coverage: Claude Code ${store.sourceStatus['claude-code'].state}; Codex ${store.sourceStatus.codex.state}.${excessKeeps?' Explicit keeps exceeded the automatic target.':''} Policy: automatic floor ${floor}, cap ${cap}; ${withheld.capacity} eligible prompt(s) omitted for capacity. Selection uses lexical overlap or observed shell evidence, not universal importance. Privacy passed configured deterministic checks, not a universal safety guarantee.`;
  const items=selected.map(({p,codes,score})=>{
    const keptState=p.state==='kept'; const reason=keptState?'you kept this prompt':REASONS[codes.includes('recurs')?'recurs':'observed-verification'];
    const itemRef=promptItemIdentity(p.ref); const short=p.sessionKey.slice(0,12);
    return { id:`prompt-${itemRef}`,itemRef,evidenceRefs:[p.ref],kind:'prompt',category:'prompts',week,curationState:keptState?'kept':'automatic',publicDisposition:'automatic-safe',status:'',project:'Prompt highlights',repo:null,date:promptDate(p,config),title:excerpt(p.text),summary:`Why it surfaced: ${reason}. ${coverage}`,receipt:{sessionId:p.sessionKey,ref:p.ref,turn:p.turn},snippets:[{kind:'prompt',source:'public-safe rendition',text:p.text,provenance:'validated-rendition'},{kind:'source',source:sourceLabel(p.source),text:`session ${short} turn ${p.turn}`,provenance:'transcript-receipt'}],selection:{score,reasonCodes:keptState?['explicit-keep']:codes,reason},privacy:{sourceRef:p.ref,sourceContentHash:p.contentHash,renditionHash:sha256(p.text),transform:p.redactionCount?'redaction':'none',changedPercent:p.changedPercent,rawRisk:p.rawRisk,residualRisk:'low',decision:'automatic-safe',policyVersion:1} };
  });
  const promptWeights=Object.fromEntries(SIGNALS.map((x)=>[x,weights[x]]));
  const lane={version:1,week,generatedAt:now.toISOString(),outputBinding,policy:{version:1,automaticMinScore:floor,automaticCap:cap,weights:promptWeights,maxAutomaticChangedPercent:config.privacy.publicRenditions.maxAutomaticChangedPercent,publicRenditionsEnabled:config.privacy.publicRenditions.enabled},sourceStatus:store.sourceStatus,items,withheld};
  const count=Object.values(withheld).reduce((a,b)=>a+b,0);if(live.length!==items.length+count)throw new Error('prompt curation accounting invariant failed.');
  return lane;
}

export function writePromptLane(cwd,lane){atomicWriteJson(join(cwd,PROMPT_LANE),lane);}
