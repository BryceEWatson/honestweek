import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { normalizeConfig } from '../lib/config.mjs';
import { createRedactor, redactWithAudit, replayRedactions } from '../lib/redact.mjs';
import { curatePrompts, evaluatePrompts } from '../lib/prompt-curation.mjs';
import { promptIdentity, sha256 } from '../lib/prompt-identity.mjs';
import { runPrompts } from '../lib/prompts.mjs';
import { runValidate } from '../lib/validate.mjs';
import { runBuild } from '../lib/build.mjs';
import { scanPromptSources } from '../lib/prompt-adapters.mjs';
import { withPromptLock } from '../lib/prompt-lock.mjs';
import { localDateRangeInstants } from '../lib/resolve-week.mjs';
import { atomicWriteText } from '../lib/atomic-json.mjs';
import { loadSiteAdapter } from '../lib/site/load-adapter.mjs';

function makeIo(){let stdout='',stderr='',exit=null;return{out:(s)=>{stdout+=s},err:(s)=>{stderr+=s},exit:(c)=>{exit=c;return c},get stdout(){return stdout},get stderr(){return stderr},get exitCode(){return exit}};}
function jsonl(path,rows){mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,rows.map((x)=>JSON.stringify(x)).join('\n')+'\n');}
function promptRecord(raw, config, { source='codex', session='session', turn=1, timestamp='2024-06-11T10:00:00.000Z', state='inbox', isPrivate=false, observedVerification=false }={}) {
  const audit=redactWithAudit(raw,config,{isPrivate});
  return {...promptIdentity(source,session,turn),source,turn,timestamp,repoKey:isPrivate?null:sha256('repo'),project:isPrivate?null:'your-project',isPrivate,state,sourceHash:sha256(raw),contentHash:sha256(audit.text),text:audit.text,redactionCount:audit.redactionCount,sourceLength:audit.sourceLength,changedPercent:audit.changedPercent,rawRisk:audit.rawRisk,rawDetectors:audit.rawDetectors,redactionOps:audit.redactionOps,truncated:audit.truncated,followOnCorrection:false,observedVerification};
}

test('prompt privacy produces replayable spans and a low-risk public rendition',()=>{
  const raw='Please review person@example.com in this sufficiently long weekly prompt workflow with careful receipt handling and local validation.';
  const got=redactWithAudit(raw,{});
  assert.equal(got.text.includes('person@example.com'),false);
  assert.equal(got.text.includes('[redacted:email]'),true);
  assert.equal(replayRedactions(raw,got.redactionOps),got.text);
  assert.deepEqual(got.rawDetectors,['email']);
  assert.equal(got.residualRisk,'low');
});

test('prompt privacy covers the closed high-risk detector families',()=>{
  const cfg={redaction:{terms:['private phrase']},privacy:{publicRenditions:{neverPublicTerms:['never phrase']}}};
  const raw='Please remove private\nphrase, never phrase, user@example.com, +1 (555) 010-2345, /home/person/project, sk-abcdefghijklmnop1234, 123e4567-e89b-12d3-a456-426614174000, USD 50, 123456789, and 192.0.2.1 from this sufficiently long prompt.';
  const got=redactWithAudit(raw,cfg);
  for(const detector of ['configured-term','never-public-term','email','phone','home-path','secret','uuid','currency','account-number','ip-address'])assert.ok(got.rawDetectors.includes(detector),detector);
  assert.equal(got.residualRisk,'low');assert.equal(replayRedactions(raw,got.redactionOps),got.text);
});

test('overlapping configured terms redact the complete sensitive span',()=>{
  const cfg=normalizeConfig({identity:{authorEmails:['you@example.com']},repos:[{path:'.',label:'your-project',role:'featured'}],redaction:{terms:['bob']}});
  const raw=`please verify ${'neutral '.repeat(30)}bob@verylongcompanydomain.example before local review`;
  const got=redactWithAudit(raw,cfg);
  assert.equal(got.rawDetectors.includes('configured-term'),true);assert.equal(got.rawDetectors.includes('email'),true);
  assert.doesNotMatch(got.text,/bob|verylongcompanydomain\.example/);assert.equal(replayRedactions(raw,got.redactionOps),got.text);
  const evaluated=evaluatePrompts({prompts:[promptRecord(raw,cfg,{observedVerification:true})]},cfg,{start:'2024-06-10',end:'2024-06-16'}).evaluated[0];
  assert.equal(evaluated.decision,'automatic-safe');assert.doesNotMatch(evaluated.p.text,/bob|verylongcompanydomain\.example/);
});

test('privacy boundaries reject ambiguity without partial IPv6 redaction',()=>{
  const cfg=normalizeConfig({identity:{authorEmails:['you@example.com']},repos:[{path:'.',label:'your-project',role:'featured'}]});
  const twenty=redactWithAudit(`${'x'.repeat(24)} a@b.co`,cfg);
  const twentyOne=redactWithAudit(`${'x'.repeat(23)} a@b.co`,cfg);
  assert.equal(twenty.changedPercent,20);assert.equal(twentyOne.changedPercent,21);
  const store={prompts:[
    {...promptRecord(`${'x'.repeat(24)} a@b.co`,cfg,{session:'twenty',observedVerification:true})},
    {...promptRecord(`${'x'.repeat(23)} a@b.co`,cfg,{session:'twenty-one',turn:2,observedVerification:true})},
  ]};
  const evaluated=evaluatePrompts(store,cfg,{start:'2024-06-10',end:'2024-06-16'}).evaluated;
  assert.equal(evaluated[0].decision,'automatic-safe');assert.equal(evaluated[1].decision,'needs-approval');
  for(const value of ['2001:db8::1','2001:db8:0:0:0:0:2:1'])assert.deepEqual(redactWithAudit(`remove ${value} from this prompt`,cfg).rawDetectors,['ip-address']);
  const invalid=redactWithAudit('review 1:2:3:4:5:6:7:8:9 without changing it',cfg);
  assert.equal(invalid.rawDetectors.includes('ip-address'),false);assert.equal(invalid.text.includes('[redacted:secret]'),false);assert.match(invalid.text,/1:2:3:4:5:6:7:8:9/);
  assert.equal(redactWithAudit('review 999.999.999.999 without changing it',cfg).rawDetectors.includes('ip-address'),false);
  assert.ok(redactWithAudit('Please ask Alice to review this prompt',cfg).rawDetectors.includes('capitalized-unknown'));
});

test('canonical redaction is byte-idempotent over audited key-value renditions',()=>{
  for(const raw of ['TOKEN=abc','TOKEN = abc','TOKEN  =  "abc def"',"PASSWORD = 'abc def'"]){
    const audited=redactWithAudit(`please use ${raw} only in this local prompt`,{}).text;
    assert.equal(createRedactor({}).redact(audited),audited,raw);
  }
  assert.equal(createRedactor({}).redact('please use TOKEN = abc only'),'please use TOKEN=[redacted:secret] only');
  assert.equal(createRedactor({}).redact('TOKEN=leaksecret[redacted:email]'),'TOKEN=[redacted:secret]');
  const pua=String.fromCharCode(0xe000);const adversarial=`TOKEN=${pua}0${pua}supersecret`;
  const scrubbed=createRedactor({}).redact(adversarial);assert.equal(scrubbed,'TOKEN=[redacted:secret]');assert.doesNotMatch(scrubbed,/undefined/);
  const numeric=createRedactor({redaction:{terms:['0']}});assert.equal(numeric.redact('[redacted:email]'),'[redacted:email]');assert.equal(numeric.redact('person@example.com'),'[redacted:email]');
  assert.equal(createRedactor({redaction:{terms:[pua]}}).redact(`keep ${pua} private`),'keep [redacted:term] private');
});

test('selection pins keeps, cap, floor, privacy, and withheld accounting',()=>{
  const cfg=normalizeConfig({identity:{authorEmails:['you@example.com']},repos:[{path:'.',label:'your-project',role:'featured'}]});
  const safe=(session,turn,extra={})=>promptRecord('review this neutral prompt with enough words for deterministic weekly curation',cfg,{session,turn,observedVerification:true,...extra});
  const prompts=[safe('keep-a',1,{state:'kept'}),safe('keep-b',2,{state:'kept'}),safe('keep-c',3,{state:'kept'}),safe('auto-a',4),safe('auto-b',5),safe('auto-c',6),safe('hidden',7,{state:'hidden'}),safe('private',8,{isPrivate:true}),promptRecord('please decide this item',cfg,{session:'floor',turn:9}),promptRecord('ask Alice to review this otherwise useful prompt',cfg,{session:'medium',turn:10,observedVerification:true}),promptRecord('send person@example.com without redaction',cfg,{session:'high',turn:11,observedVerification:true})];
  // Model a corrupt residual secret to prove the high-risk stop precedes score.
  prompts.at(-1).text='send person@example.com without redaction';
  const got=evaluatePrompts({prompts},cfg,{start:'2024-06-10',end:'2024-06-16'});
  assert.equal(got.selected.length,5);assert.deepEqual(got.selected.slice(0,3).map((e)=>e.p.state),['kept','kept','kept']);
  assert.equal(got.withheld.capacity,1);assert.equal(got.withheld.hidden,1);assert.equal(got.withheld['private-source'],1);assert.equal(got.withheld['below-automatic-floor'],1);assert.equal(got.withheld['needs-approval'],1);assert.equal(got.withheld['high-risk'],1);
  assert.equal(got.live.length,got.selected.length+Object.values(got.withheld).reduce((a,b)=>a+b,0));
  const zero=normalizeConfig({identity:{authorEmails:['you@example.com']},repos:[{path:'.',label:'your-project',role:'featured'}],curation:{categoryCaps:{prompts:0}}});
  assert.equal(evaluatePrompts({prompts:[safe('zero',12)]},zero,{start:'2024-06-10',end:'2024-06-16'}).withheld.capacity,1);
  const sourceStatus={'claude-code':{state:'present'},codex:{state:'present'}};
  const lane=curatePrompts({prompts:[safe('one-keep',13,{state:'kept'}),safe('automatic-one',14),safe('automatic-two',15)],sourceStatus},cfg,{start:'2024-06-10',end:'2024-06-16'});
  assert.match(lane.items[0].summary,/Explicit keeps exceeded the automatic target/);
});

test('recurrence and cue matching use closed placeholders and Unicode token boundaries',()=>{
  const cfg=normalizeConfig({identity:{authorEmails:['you@example.com']},repos:[{path:'.',label:'your-project',role:'featured'}]});
  const a=promptRecord('alpha beta gamma delta [redacted:one]',cfg,{session:'a'}),b=promptRecord('alpha beta gamma delta [redacted:two]',cfg,{session:'b',turn:2});
  const recurrence=evaluatePrompts({prompts:[a,b]},cfg,{start:'2024-06-10',end:'2024-06-16'}).evaluated;
  assert.equal(recurrence.every((e)=>!e.codes.includes('recurs')&&e.decision==='below-automatic-floor'),true);
  const negatives=[promptRecord('please settle online and follow upside',cfg,{session:'prefix'}),promptRecord('please prédecide this request',cfg,{session:'unicode',turn:2})];
  const cues=evaluatePrompts({prompts:negatives},cfg,{start:'2024-06-10',end:'2024-06-16'}).evaluated;
  assert.equal(cues.every((e)=>!e.codes.includes('decision-request')&&!e.codes.includes('next-step-request')),true);
  const positive=promptRecord('please settle on this choice and follow up',cfg,{session:'positive',turn:3});
  assert.deepEqual(evaluatePrompts({prompts:[positive]},cfg,{start:'2024-06-10',end:'2024-06-16'}).evaluated[0].codes,['decision-request','next-step-request']);
});

test('source wrappers are excluded while unknown user-authored XML remains eligible',async()=>{
  const root=mkdtempSync(join(tmpdir(),'honestweek-wrappers-'));
  try{
    const project=join(root,'project'),claude=join(root,'claude'),codex=join(root,'codex');mkdirSync(project,{recursive:true});
    jsonl(join(claude,'p','s.jsonl'),[{type:'user',sessionId:'c',timestamp:'2024-06-11T00:00:00.000Z',cwd:project,message:{content:'<command-message>ignore</command-message>'}},{type:'user',sessionId:'c',timestamp:'2024-06-11T00:01:00.000Z',cwd:project,message:{content:'<custom-note>keep this user-authored request</custom-note>'}}]);
    jsonl(join(codex,'sessions','s.jsonl'),[{type:'session_meta',payload:{id:'x',cwd:project}},{type:'event_msg',timestamp:'2024-06-11T00:00:00.000Z',payload:{type:'user_message',message:'<codex_delegation>ignore</codex_delegation>'}},{type:'event_msg',timestamp:'2024-06-11T00:01:00.000Z',payload:{type:'user_message',message:'ordinary user request stays'}}]);
    const config=normalizeConfig({identity:{authorEmails:['you@example.com']},week:{timezone:'UTC'},repos:[{path:project,label:'your-project',role:'featured'}]},{configDir:root});
    const got=await scanPromptSources({config,weekStart:new Date('2024-06-10T00:00:00Z'),weekEnd:new Date('2024-06-17T00:00:00Z'),roots:{'claude-code':claude,codex},now:new Date('2024-06-17T00:00:00Z')});
    assert.deepEqual(got.prompts.map((p)=>p.text),['<custom-note>keep this user-authored request</custom-note>','ordinary user request stays']);
    assert.deepEqual(got.prompts.map((p)=>p.turn),[1,1]);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('observed verification requires a recognized command and explicit success',async()=>{
  const root=mkdtempSync(join(tmpdir(),'honestweek-verification-command-'));
  try{
    const project=join(root,'project'),claude=join(root,'claude'),codex=join(root,'codex');mkdirSync(project,{recursive:true});
    jsonl(join(claude,'p','s.jsonl'),[
      {type:'user',sessionId:'claude-session',timestamp:'2024-06-11T10:00:00.000Z',cwd:project,message:{content:'first prompt with enough neutral words for review'}},
      {type:'assistant',sessionId:'claude-session',message:{content:[{type:'tool_use',name:'Bash',id:'noise',input:{command:'Write-Output PASS'}}]}},
      {type:'user',sessionId:'claude-session',message:{content:[{type:'tool_result',tool_use_id:'noise',content:'PASS',is_error:false}]}},
      {type:'user',sessionId:'claude-session',timestamp:'2024-06-11T11:00:00.000Z',cwd:project,message:{content:'second prompt with enough neutral words for review'}},
      {type:'assistant',sessionId:'claude-session',message:{content:[{type:'tool_use',name:'Bash',id:'test',input:{command:'node --test'}}]}},
      {type:'user',sessionId:'claude-session',message:{content:[{type:'tool_result',tool_use_id:'test',content:'# pass 4\n# fail 0',is_error:false}]}},
    ]);
    jsonl(join(codex,'sessions','x.jsonl'),[
      {type:'session_meta',payload:{id:'codex-session',cwd:project}},
      {type:'event_msg',timestamp:'2024-06-12T10:00:00.000Z',payload:{type:'user_message',message:'third prompt with enough neutral words for review'}},
      {type:'response_item',payload:{type:'function_call',name:'shell_command',call_id:'noise',arguments:JSON.stringify({command:'git rev-parse HEAD'})}},
      {type:'response_item',payload:{type:'function_call_output',call_id:'noise',output:`Exit code: 0\n${'a'.repeat(40)}`}},
      {type:'event_msg',timestamp:'2024-06-12T11:00:00.000Z',payload:{type:'user_message',message:'fourth prompt with enough neutral words for review'}},
      {type:'response_item',payload:{type:'function_call',name:'shell_command',call_id:'test',arguments:JSON.stringify({command:'node --test'})}},
      {type:'response_item',payload:{type:'function_call_output',call_id:'test',output:'Exit code: 0\n# pass 5\n# fail 0'}},
      {type:'event_msg',timestamp:'2024-06-12T12:00:00.000Z',payload:{type:'user_message',message:'fifth prompt with enough neutral words for review'}},
      {type:'response_item',payload:{type:'function_call',name:'shell_command',call_id:'sha',arguments:JSON.stringify({command:'node --test'})}},
      {type:'response_item',payload:{type:'function_call_output',call_id:'sha',output:`Exit code: 0\n${'a'.repeat(40)}`}},
      {type:'event_msg',timestamp:'2024-06-12T13:00:00.000Z',payload:{type:'user_message',message:'sixth prompt with enough neutral words for review'}},
      {type:'response_item',payload:{type:'function_call',name:'shell_command',call_id:'quoted',arguments:JSON.stringify({command:"echo '; npm test PASS'"})}},
      {type:'response_item',payload:{type:'function_call_output',call_id:'quoted',output:'Exit code: 0\nPASS'}},
      {type:'event_msg',timestamp:'2024-06-12T14:00:00.000Z',payload:{type:'user_message',message:'seventh prompt with enough neutral words for review'}},
      {type:'response_item',payload:{type:'function_call',name:'shell_command',call_id:'masked',arguments:JSON.stringify({command:'npm test > test.log 2>&1 || echo PASS'})}},
      {type:'response_item',payload:{type:'function_call_output',call_id:'masked',output:'Exit code: 0\nPASS'}},
      {type:'event_msg',timestamp:'2024-06-12T15:00:00.000Z',payload:{type:'user_message',message:'eighth prompt with enough neutral words for review'}},
      {type:'response_item',payload:{type:'function_call',name:'shell_command',call_id:'test-option',arguments:JSON.stringify({command:"node --test-reporter=tap -e \"console.log('PASS')\""})}},
      {type:'response_item',payload:{type:'function_call_output',call_id:'test-option',output:'Exit code: 0\nPASS'}},
    ]);
    const config=normalizeConfig({identity:{authorEmails:['you@example.com']},week:{timezone:'UTC'},repos:[{path:project,label:'your-project',role:'featured'}]},{configDir:root});
    const got=await scanPromptSources({config,weekStart:new Date('2024-06-10T00:00:00Z'),weekEnd:new Date('2024-06-17T00:00:00Z'),roots:{'claude-code':claude,codex},now:new Date('2024-06-17T00:00:00Z')});
    assert.deepEqual(got.prompts.map((prompt)=>prompt.observedVerification),[false,true,false,true,false,false,false,false]);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('atomic writes preserve prior bytes at open, write, flush, and rename faults',()=>{
  for(const method of ['openSync','writeFileSync','fsyncSync','renameSync']){
    const root=mkdtempSync(join(tmpdir(),'honestweek-atomic-'));const file=join(root,'artifact.txt');writeFileSync(file,'prior');
    try{const fs={...nodeFs,[method]:(...args)=>{if(method==='openSync'&&args[1]!=='wx')return nodeFs.openSync(...args);throw new Error(`fault:${method}`);}};assert.throws(()=>atomicWriteText(file,'next',fs),new RegExp(`fault:${method}`));assert.equal(readFileSync(file,'utf8'),'prior');assert.equal(nodeFs.readdirSync(root).length,1);}
    finally{rmSync(root,{recursive:true,force:true});}
  }
});

test('static adapter preflight rejects an invalid grammar before sidecar work',async()=>{
  const root=mkdtempSync(join(tmpdir(),'honestweek-adapter-'));const file=join(root,'adapter.json');
  try{writeFileSync(file,JSON.stringify({artifact:'out.json'}));await assert.rejects(()=>loadSiteAdapter(file),/invalid.*tree/);}
  finally{rmSync(root,{recursive:true,force:true});}
});

test('curate setup preflights exit 1 and write no prompt sidecars',async()=>{
  const cases=[
    {name:'unsupported mode',output:{mode:'digest',file:'digest.md'}},
    {name:'page with objectives',output:{mode:'page',file:'report.html'},objectives:true},
    {name:'invalid site adapter',output:{mode:'site',adapter:'adapter.json'},adapter:{artifact:'out.json'}},
  ];
  for(const c of cases){
    const root=mkdtempSync(join(tmpdir(),'honestweek-preflight-'));
    try{
      if(c.objectives)writeFileSync(join(root,'honestweek.objectives.json'),'{}\n');
      if(c.adapter)writeFileSync(join(root,'adapter.json'),`${JSON.stringify(c.adapter)}\n`);
      writeFileSync(join(root,'honestweek.config.json'),JSON.stringify({identity:{authorEmails:['you@example.com']},week:{timezone:'UTC'},repos:[{path:root,label:'your-project',role:'featured'}],output:c.output}));
      const io=makeIo();assert.equal(await runPrompts({cwd:root,argv:['curate'],now:new Date('2024-06-17T00:00:00Z'),io,roots:{'claude-code':join(root,'missing-c'),codex:join(root,'missing-x')}}),1,c.name);
      assert.equal(existsSync(join(root,'honestweek.prompts.json')),false,c.name);assert.equal(existsSync(join(root,'honestweek.prompt-items.json')),false,c.name);
    }finally{rmSync(root,{recursive:true,force:true});}
  }
});

test('dual-source prompt lane reaches validate and the existing standalone page',async()=>{
  const root=mkdtempSync(join(tmpdir(),'honestweek-prompts-'));
  const oldClaude=process.env.CLAUDE_CONFIG_DIR,oldCodex=process.env.CODEX_HOME;
  try{
    const project=join(root,'project');mkdirSync(project,{recursive:true});
    const claude=join(root,'claude');const codex=join(root,'codex');
    process.env.CLAUDE_CONFIG_DIR=claude;process.env.CODEX_HOME=codex;
    const prompt='please decide how should we test the weekly prompt flow safely with source receipts';
    jsonl(join(claude,'projects','p','session.jsonl'),[
      {type:'user',sessionId:'claude-session',timestamp:'2024-06-11T10:00:00.000Z',cwd:project,message:{content:prompt}},
      {type:'assistant',sessionId:'claude-session',timestamp:'2024-06-11T10:01:00.000Z',cwd:project,message:{content:[{type:'tool_use',name:'Bash',id:'t1'}]}},
      {type:'user',sessionId:'claude-session',timestamp:'2024-06-11T10:02:00.000Z',cwd:project,message:{content:'actually keep the check local'}},
    ]);
    jsonl(join(codex,'sessions','2024','session.jsonl'),[
      {type:'session_meta',payload:{id:'codex-session',cwd:project}},
      {type:'turn_context',payload:{cwd:project}},
      {type:'event_msg',timestamp:'2024-06-12T10:00:00.000Z',payload:{type:'user_message',message:prompt}},
      {type:'response_item',payload:{type:'function_call',name:'shell_command',call_id:'c1',arguments:JSON.stringify({command:'node --test'})}},
      {type:'response_item',payload:{type:'function_call_output',call_id:'c1',output:'Exit code: 0\n# pass 4\n# fail 0'}},
    ]);
    const config={identity:{authorEmails:['you@example.com']},week:{startsOn:'monday',timezone:'UTC'},repos:[{path:project,label:'your-project',role:'featured'}],redaction:{codenames:[],names:[],terms:[]},output:{mode:'page',file:join(root,'report.html')}};
    writeFileSync(join(root,'honestweek.config.json'),JSON.stringify(config));
    writeFileSync(join(root,'honestweek.items.json'),JSON.stringify({week:{start:'2024-06-10',end:'2024-06-16'},items:[]}));
    const now=new Date('2024-06-17T12:00:00.000Z');let io=makeIo();
    assert.equal(await runPrompts({cwd:root,argv:['curate'],now,io}),0,io.stderr);
    const lane=JSON.parse(readFileSync(join(root,'honestweek.prompt-items.json'),'utf8'));
    assert.equal(lane.items.length,2);assert.equal(lane.items.every((x)=>x.project==='Prompt highlights'&&x.receipt.turn===1),true);
    assert.equal(lane.items.some((x)=>x.selection.reasonCodes.includes('observed-verification')),true);
    assert.match(lane.items[0].summary,/not universal importance/);
    io=makeIo();assert.equal(await runValidate({cwd:root,now,io}),0,io.stderr);
    io=makeIo();assert.equal(await runBuild({cwd:root,now,io}),0,io.stderr);
    const html=readFileSync(join(root,'report.html'),'utf8');
    assert.match(html,/Prompt highlights/);assert.match(html,/source receipt/);assert.match(html,/Codex|Claude Code/);
    assert.match(html,/Every line carries a source receipt/);

    // The same lane feeds the existing site-transform boundary without a
    // parallel renderer or target write outside the configured artifact.
    const adapter=join(root,'honestweek.site.mjs');writeFileSync(adapter,"export const artifact='site-data.json'; export function transform(model){return {items:model.items.map((x)=>({id:x.id,status:x.status===''?null:x.status,project:x.project,title:x.title,summary:x.summary,snippets:x.snippets}))};}\n");
    writeFileSync(join(root,'honestweek.config.json'),JSON.stringify({...config,output:{mode:'site',adapter}}));
    io=makeIo();assert.equal(await runValidate({cwd:root,now,io}),2);assert.match(io.stderr,/stale or non-canonical/);
    io=makeIo();assert.equal(await runPrompts({cwd:root,argv:['curate'],now,io}),0,io.stderr);
    writeFileSync(adapter,readFileSync(adapter,'utf8')+'// reviewed adapter revision\n');
    io=makeIo();assert.equal(await runValidate({cwd:root,now,io}),2);assert.match(io.stderr,/stale or non-canonical/);
    io=makeIo();assert.equal(await runPrompts({cwd:root,argv:['curate'],now,io}),0,io.stderr);
    io=makeIo();assert.equal(await runBuild({cwd:root,now,io}),0,io.stderr);
    const site=JSON.parse(readFileSync(join(root,'site-data.json'),'utf8'));assert.equal(site.items.length,2);assert.equal(site.items.every((x)=>x.status===null&&x.snippets.length===2),true);

    // A reviewable-lane edit cannot bypass canonical reconstruction, and the
    // previously generated site artifact remains byte-identical on abort.
    const siteBytes=readFileSync(join(root,'site-data.json'),'utf8');
    const lanePath=join(root,'honestweek.prompt-items.json');const tampered=JSON.parse(readFileSync(lanePath,'utf8'));tampered.withheld.capacity++;
    writeFileSync(lanePath,`${JSON.stringify(tampered,null,2)}\n`);
    io=makeIo();assert.equal(await runValidate({cwd:root,now,io}),2);assert.match(io.stderr,/stale or non-canonical/);
    io=makeIo();assert.equal(await runBuild({cwd:root,now,io}),2);assert.equal(readFileSync(join(root,'site-data.json'),'utf8'),siteBytes);
    io=makeIo();assert.equal(await runPrompts({cwd:root,argv:['curate'],now,io}),0,io.stderr);

    // Controls survive re-sync. Delete leaves a tombstone and makes the old
    // public lane fail closed until curation removes its derivative.
    const stored=JSON.parse(readFileSync(join(root,'honestweek.prompts.json'),'utf8')).prompts;
    const first=stored.find((p)=>p.source==='claude-code'&&p.turn===1);
    const second=stored.find((p)=>p.source==='codex'&&p.turn===1);
    io=makeIo();assert.equal(await runPrompts({cwd:root,argv:['keep',first.ref.slice(0,12)],now,io}),0,io.stderr);
    io=makeIo();assert.equal(await runPrompts({cwd:root,argv:['hide',second.ref.slice(0,12)],now,io}),0,io.stderr);
    io=makeIo();assert.equal(await runPrompts({cwd:root,argv:['curate'],now,io}),0,io.stderr);
    assert.equal(JSON.parse(readFileSync(join(root,'honestweek.prompt-items.json'),'utf8')).items.length,1);
    io=makeIo();assert.equal(await runPrompts({cwd:root,argv:['review','--limit','1'],now,io}),0,io.stderr);assert.match(io.stdout,/showing 1-1 of 2; remaining 1/);assert.match(io.stdout,/Next: honestweek prompts review --limit 1 --offset 1/);
    io=makeIo();assert.equal(await runPrompts({cwd:root,argv:['review','--limit','1','--offset','1'],now,io}),0,io.stderr);assert.match(io.stdout,/showing 2-2 of 2; remaining 0/);assert.doesNotMatch(io.stdout,/Next:/);
    io=makeIo();assert.equal(await runPrompts({cwd:root,argv:['review','--decision','below-automatic-floor'],now,io}),0,io.stderr);assert.match(io.stdout,/decision=below-automatic-floor/);assert.match(io.stdout,/prompts hide/);
    const oldPage=readFileSync(join(root,'report.html'),'utf8');
    io=makeIo();assert.equal(await runPrompts({cwd:root,argv:['delete',first.ref.slice(0,12),'--yes'],now,io}),0,io.stderr);
    io=makeIo();assert.equal(await runValidate({cwd:root,now,io}),2);assert.match(io.stderr,/rerun honestweek prompts curate/);
    assert.equal(readFileSync(join(root,'report.html'),'utf8'),oldPage);
    io=makeIo();assert.equal(await runPrompts({cwd:root,argv:['curate'],now,io}),0,io.stderr);
    const finalLane=JSON.parse(readFileSync(join(root,'honestweek.prompt-items.json'),'utf8'));
    assert.equal(finalLane.items.length,0);assert.equal(finalLane.withheld.hidden,1);assert.equal(finalLane.withheld['below-automatic-floor'],1);
    const finalStore=JSON.parse(readFileSync(join(root,'honestweek.prompts.json'),'utf8'));
    assert.equal(finalStore.tombstones.length,1);assert.equal('text' in finalStore.tombstones[0],false);
  }finally{
    if(oldClaude===undefined)delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR=oldClaude;
    if(oldCodex===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=oldCodex;
    rmSync(root,{recursive:true,force:true});
  }
});

test('prompt scan uses local Monday and next-Monday instants with global turn ordinals',async()=>{
  const root=mkdtempSync(join(tmpdir(),'honestweek-timezone-'));
  try{
    const codex=join(root,'codex'),project=join(root,'project');mkdirSync(project,{recursive:true});
    jsonl(join(codex,'sessions','x.jsonl'),[{type:'session_meta',payload:{id:'s',cwd:project}},...['2024-06-10T06:59:59.999Z','2024-06-10T07:00:00.000Z','2024-06-17T06:59:59.999Z','2024-06-17T07:00:00.000Z'].map((timestamp,i)=>({type:'event_msg',timestamp,payload:{type:'user_message',message:`prompt number ${i} with enough neutral words for review`}}))]);
    const config=normalizeConfig({identity:{authorEmails:['you@example.com']},week:{timezone:'America/Los_Angeles'},repos:[{path:project,label:'private phrase',role:'featured'}],redaction:{terms:['private phrase']}},{configDir:root});
    const range=localDateRangeInstants('2024-06-10','2024-06-16',config.week.timezone);const got=await scanPromptSources({config,...{weekStart:range.start,weekEnd:range.endExclusive},roots:{'claude-code':join(root,'missing'),codex},now:new Date('2024-06-17T12:00:00Z')});
    assert.deepEqual(got.prompts.map((p)=>p.turn),[2,3]);assert.deepEqual(got.prompts.map((p)=>p.timestamp),['2024-06-10T07:00:00.000Z','2024-06-17T06:59:59.999Z']);assert.equal(got.prompts.every((p)=>p.project==='[redacted:term]'),true);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('malformed rows make a source unreadable instead of shifting receipt ordinals',async()=>{
  const root=mkdtempSync(join(tmpdir(),'honestweek-malformed-'));
  try{
    const codex=join(root,'codex');jsonl(join(codex,'sessions','x.jsonl'),[{type:'session_meta',payload:{id:'s',cwd:root}}]);
    const file=join(codex,'sessions','x.jsonl');writeFileSync(file,readFileSync(file,'utf8')+'{bad json\n'+JSON.stringify({type:'event_msg',timestamp:'2024-06-11T00:00:00.000Z',payload:{type:'user_message',message:'valid later prompt'}})+'\n');
    const config=normalizeConfig({identity:{authorEmails:['you@example.com']},week:{timezone:'UTC'},repos:[{path:root,label:'your-project',role:'featured'}]},{configDir:root});
    const got=await scanPromptSources({config,weekStart:new Date('2024-06-10T00:00:00Z'),weekEnd:new Date('2024-06-17T00:00:00Z'),roots:{'claude-code':join(root,'missing'),codex},now:new Date('2024-06-17T00:00:00Z')});
    assert.equal(got.sourceStatus.codex.state,'unreadable');assert.equal(got.sourceStatus.codex.malformedLines,1);assert.equal(got.prompts.length,0);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('prompt store lock rejects a concurrent writer',async()=>{
  const root=mkdtempSync(join(tmpdir(),'honestweek-lock-'));
  try{await withPromptLock(root,async()=>{await assert.rejects(()=>withPromptLock(root,async()=>{}),/another honestweek prompts command/);});}
  finally{rmSync(root,{recursive:true,force:true});}
});

test('stale prompt locks fail closed instead of racing automatic reclamation',async()=>{
  const root=mkdtempSync(join(tmpdir(),'honestweek-stale-lock-'));const lock=join(root,'honestweek.prompts.json.lock');
  try{writeFileSync(lock,'999999 0\n');await assert.rejects(()=>withPromptLock(root,async()=>{}),/remove the stale lock file after confirming no command is running/);assert.equal(existsSync(lock),true);}
  finally{rmSync(root,{recursive:true,force:true});}
});

test('prompt lock cleanup failure is reported instead of returning success',async()=>{
  const root=mkdtempSync(join(tmpdir(),'honestweek-lock-cleanup-'));const lock=join(root,'honestweek.prompts.json.lock');
  const fs={...nodeFs,unlinkSync(){const err=new Error('injected sharing violation');err.code='EBUSY';throw err;}};
  try{await assert.rejects(()=>withPromptLock(root,async()=>42,{ensureIgnored:false,fs}),/could not remove its prompt lock/);assert.equal(existsSync(lock),true);}
  finally{if(existsSync(lock))nodeFs.unlinkSync(lock);rmSync(root,{recursive:true,force:true});}
});

test('curation and privacy defaults are explicit and bounded',()=>{
  const cfg=normalizeConfig({identity:{authorEmails:['you@example.com']},repos:[{path:'.',label:'your-project',role:'featured'}]});
  assert.equal(cfg.curation.automaticMinScore,2);assert.equal(cfg.curation.categoryCaps.prompts,2);
  assert.equal(cfg.privacy.publicRenditions.enabled,true);assert.equal(cfg.privacy.publicRenditions.maxAutomaticChangedPercent,20);
  assert.throws(()=>normalizeConfig({identity:{authorEmails:['you@example.com']},repos:[{path:'.',label:'your-project',role:'featured'}],privacy:{publicRenditions:{generalizationMappings:{x:'y'}}}}),/not supported/);
  assert.throws(()=>normalizeConfig({identity:{authorEmails:['you@example.com']},repos:[{path:'.',label:'your-project',role:'featured'}],curation:{categoryCaps:{prompts:21}}}),/0 to 20/);
  assert.throws(()=>normalizeConfig({identity:{authorEmails:['you@example.com']},repos:[{path:'.',label:'your-project',role:'featured'}],curation:{automaticCarryWeeks:3}}),/0 to 2/);
  assert.throws(()=>normalizeConfig({identity:{authorEmails:['you@example.com']},repos:[{path:'.',label:'your-project',role:'featured'}],curation:{retentionWeeks:13}}),/1 to 12/);
  assert.throws(()=>normalizeConfig({identity:{authorEmails:['you@example.com']},repos:[{path:'.',label:'your-project',role:'featured'}],privacy:{publicRenditions:{maxAutomaticChangedPercent:21}}}),/0 to 20/);
});
