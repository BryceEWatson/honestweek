import { closeSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureGitignore } from './init.mjs';
import { PROMPT_LOCK } from './prompt-store.mjs';

const nativeFs = { closeSync, openSync, unlinkSync, writeFileSync };

export async function withPromptLock(cwd,fn,{ensureIgnored=true,fs=nativeFs}={}){
  if(ensureIgnored)ensureGitignore(cwd,PROMPT_LOCK);const path=join(cwd,PROMPT_LOCK);let fd;let value;let actionError;
  try{fd=fs.openSync(path,'wx');}catch(err){if(err?.code==='EEXIST')throw new Error('another honestweek prompts command is updating the private store; if its process ended unexpectedly, remove the stale lock file after confirming no command is running.');throw err;}
  try{fs.writeFileSync(fd,`${process.pid} ${Date.now()}\n`);fs.closeSync(fd);fd=undefined;value=await fn();}
  catch(err){actionError=err;}
  const cleanupErrors=[];
  if(fd!==undefined)try{fs.closeSync(fd);}catch(err){cleanupErrors.push(err);}
  try{fs.unlinkSync(path);}catch(err){cleanupErrors.push(err);}
  if(cleanupErrors.length){
    const cleanupError=new Error(`honestweek could not remove its prompt lock at ${path}; confirm no command is running, remove the stale lock, and retry.`,{cause:cleanupErrors[0]});
    if(actionError)throw new AggregateError([actionError,cleanupError],'honestweek prompt command failed and its lock could not be removed.');
    throw cleanupError;
  }
  if(actionError)throw actionError;
  return value;
}
