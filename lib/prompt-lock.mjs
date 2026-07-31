import { closeSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureGitignore } from './init.mjs';
import { PROMPT_LOCK } from './prompt-store.mjs';

export async function withPromptLock(cwd,fn,{ensureIgnored=true}={}){
  if(ensureIgnored)ensureGitignore(cwd,PROMPT_LOCK);const path=join(cwd,PROMPT_LOCK);let fd;
  try{fd=openSync(path,'wx');}catch(err){if(err?.code==='EEXIST')throw new Error('another honestweek prompts command is updating the private store; if its process ended unexpectedly, remove the stale lock file after confirming no command is running.');throw err;}
  try{writeFileSync(fd,`${process.pid} ${Date.now()}\n`);closeSync(fd);fd=undefined;return await fn();}
  finally{if(fd!==undefined)try{closeSync(fd);}catch{}try{unlinkSync(path);}catch{}}
}
