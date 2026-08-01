// Deterministic, read-only extraction of explicitly labelled weekly material.
// Only accepted human turns and the final assistant envelope for each turn are
// examined. Raw text is discarded after the prompt privacy audit is produced.

import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { createInterface } from 'node:readline';

import { enumeratePromptFiles, resolvePromptRoots } from './prompt-adapters.mjs';
import { promptIdentity, sha256 } from './prompt-identity.mjs';
import { redactWithAudit } from './redact.mjs';
import { localDateInTimezone } from './resolve-week.mjs';

const MACHINE_TAGS = new Set([
  'command-name', 'command-message', 'command-args', 'task-notification',
  'local-command-caveat', 'local-command-stdout', 'local-command-stderr',
  'system-reminder', 'cross-session-message', 'scheduled-task',
  'user-prompt-submit-hook',
]);
const CODEX_WRAPPERS = /^(?:<codex_delegation>|<environment_context>|<app-context>|<permissions|<collaboration_mode>|<recommended_plugins>|# AGENTS\.md|<skills_instructions>|<plugins_instructions>)/i;
const MAX_JSONL_LINE_BYTES = 8 * 1024 * 1024;
const LABELS = Object.freeze({
  idea: 'ideas', 'unresolved idea': 'ideas', technique: 'techniques', decision: 'decisions', decided: 'decisions',
  reversal: 'reversals', reversed: 'reversals', 'next step': 'nextSteps',
});
const HEADINGS = Object.freeze({
  ideas: 'ideas', techniques: 'techniques', decisions: 'decisions',
  reversals: 'reversals', 'next steps': 'nextSteps',
});

function humanText(row, source) {
  if (source === 'claude-code') {
    if (row?.type !== 'user') return null;
    const text = typeof row.message?.content === 'string'
      ? row.message.content
      : typeof row.content === 'string' ? row.content : null;
    if (!text?.trim()) return null;
    const tag = /^\s*<([a-z0-9-]+)(?:\s|>)/i.exec(text)?.[1]?.toLowerCase();
    return tag && MACHINE_TAGS.has(tag) ? null : text;
  }
  const payload = row?.payload;
  if (row?.type !== 'event_msg' || payload?.type !== 'user_message' ||
      typeof payload.message !== 'string' || !payload.message.trim()) return null;
  return CODEX_WRAPPERS.test(payload.message.trim()) ? null : payload.message;
}

function assistantText(row, source) {
  if (source === 'claude-code') {
    if (row?.type !== 'assistant') return null;
    const content = row?.message?.content ?? row?.content;
    if (typeof content === 'string') return content.trim() ? content : null;
    if (!Array.isArray(content)) return null;
    const text = content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n');
    return text.trim() ? text : null;
  }
  const payload = row?.payload;
  return row?.type === 'event_msg' && payload?.type === 'agent_message' &&
    typeof payload.message === 'string' && payload.message.trim()
    ? payload.message : null;
}

function timestamp(row) {
  return row?.timestamp ?? row?.message?.timestamp ?? row?.payload?.timestamp ?? null;
}

function allowed(category, envelopeKind, observedVerification) {
  if (category === 'nextSteps' && envelopeKind !== 'assistant-final') return false;
  if (category === 'techniques' && !observedVerification) return false;
  return true;
}

function emptyExcluded() {
  return { ideas: 0, techniques: 0, decisions: 0, reversals: 0, nextSteps: 0 };
}

function addCue(out, unsupported, rawText, category, ordinal, envelopeKind, observedVerification, unresolvedIdea = false) {
  if (!allowed(category, envelopeKind, observedVerification)) return false;
  const text = rawText.trim();
  if (!text || [...text].length > 1000) {
    unsupported[category] += 1;
    return true;
  }
  out.push({ category, raw: text, ordinal, ...(unresolvedIdea ? { unresolvedIdea: true } : {}) });
  return true;
}

/** Parse only the contract's labelled-line and heading-list grammar. */
export function extractDigestCues(raw, { envelopeKind, observedVerification = false } = {}) {
  const lines = String(raw ?? '').replace(/\r\n?/g, '\n').split('\n');
  const cues = [];
  const unsupported = emptyExcluded();
  let ordinal = 0;
  let terminalOrdinal = 0;
  let scannedCount = 0;
  const terminals = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const terminal = /^\s*(?:[-*+]\s+)?(picked up|ruled out)\s*:\s*(.*)\s*$/i.exec(line);
    if (terminal) {
      terminalOrdinal += 1;
      const subject = terminal[2].trim();
      if (envelopeKind === 'human-cue' && subject && [...subject].length <= 1000) {
        terminals.push({ kind: terminal[1].toLowerCase() === 'picked up' ? 'picked-up' : 'ruled-out', raw: subject, ordinal: terminalOrdinal });
      }
      continue;
    }
    const labelled = /^\s*(?:[-*+]\s+)?(unresolved idea|idea|technique|decision|decided|reversal|reversed|next step)\s*:\s*(.*)\s*$/i.exec(line);
    if (labelled) {
      ordinal += 1;
      const label = labelled[1].toLowerCase();
      const category = LABELS[label];
      if (addCue(cues, unsupported, labelled[2], category, ordinal, envelopeKind, observedVerification,
        label === 'unresolved idea')) scannedCount += 1;
      continue;
    }
    const heading = /^\s*(?:#{1,6}\s*)?(ideas|techniques|decisions|reversals|next steps)\s*:?\s*$/i.exec(line);
    if (!heading) continue;
    const category = HEADINGS[heading[1].toLowerCase()];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (!lines[j].trim() || /^\s*#{1,6}\s+/.test(lines[j])) break;
      const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.*)\s*$/.exec(lines[j]);
      if (!bullet) break;
      ordinal += 1;
      if (addCue(cues, unsupported, bullet[1], category, ordinal, envelopeKind, observedVerification)) scannedCount += 1;
      i = j;
    }
  }
  return { cues, terminals, unsupported, scannedCount, acceptedCount: cues.length };
}

function mergeExcluded(target, source, kind) {
  for (const category of Object.keys(source)) target[category][kind] += source[category];
}

function evidenceFor(rawCue, cue, context, config) {
  const { source, sessionKey, turn, envelopeKind, timestamp: at, prompt } = context;
  const audit = redactWithAudit(rawCue, config, { isPrivate: prompt.isPrivate });
  const sourceHash = sha256(rawCue);
  const evidenceCanonical = `${source}\0${sessionKey}\0${turn}\0${envelopeKind}\0${cue.ordinal}\0${sourceHash}`;
  const evidenceRef = sha256(evidenceCanonical);
  return {
    evidenceRef, evidenceCanonical, category: cue.category,
    discriminator: `${cue.unresolvedIdea ? 'unresolved-idea' : cue.category === 'nextSteps' ? 'next-step' : cue.category.slice(0, -1)}:${cue.ordinal}`,
    source, sessionKey, turn, kind: envelopeKind, ordinal: cue.ordinal, timestamp: at,
    promptRef: prompt.ref, project: prompt.project, isPrivate: prompt.isPrivate,
    sourceHash, contentHash: sha256(audit.text), text: audit.text,
    redactionCount: audit.redactionCount, sourceLength: audit.sourceLength,
    changedPercent: audit.changedPercent, rawRisk: audit.rawRisk,
    rawDetectors: audit.rawDetectors, redactionOps: audit.redactionOps,
    truncated: audit.truncated, residualRisk: audit.residualRisk,
    observedVerification: prompt.observedVerification,
  };
}

function terminalEvidenceFor(rawSubject, terminal, context, config) {
  const { source, sessionKey, turn, timestamp: at, prompt } = context;
  const audit = redactWithAudit(rawSubject, config, { isPrivate: prompt.isPrivate });
  const sourceHash = sha256(rawSubject);
  const terminalCanonical = `${source}\0${sessionKey}\0${turn}\0human-terminal\0${terminal.ordinal}\0${terminal.kind}\0${sourceHash}`;
  return {
    terminalRef: sha256(terminalCanonical), terminalCanonical, kind: terminal.kind,
    source, sessionKey, turn, ordinal: terminal.ordinal, timestamp: at, promptRef: prompt.ref,
    sourceHash, contentHash: sha256(audit.text), text: audit.text,
    changedPercent: audit.changedPercent, rawRisk: audit.rawRisk,
    rawDetectors: audit.rawDetectors, truncated: audit.truncated,
    residualRisk: audit.residualRisk, isPrivate: prompt.isPrivate,
  };
}

function safeSourceError(message) {
  const error = new Error(message);
  error.digestSourceSafe = true;
  return error;
}

function inScannedWeek(at, status, timezone) {
  if (!at || !status?.weekStart || !status?.weekEnd) return false;
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return false;
  const key = localDateInTimezone(date, timezone).toISOString().slice(0, 10);
  return key >= status.weekStart && key <= status.weekEnd;
}

async function readTurns(file, source, onTurn) {
  let rawSessionId = null;
  let turn = 0;
  let malformed = 0;
  let current = null;
  const fallbackId = basename(file).replace(/\.jsonl$/i, '');
  const finish = () => {
    if (!current) return;
    const sessionId = rawSessionId ?? (source === 'claude-code' ? fallbackId : null);
    if (!sessionId) throw safeSourceError('missing Codex session id');
    onTurn(sessionId, current);
    current = null;
  };
  try {
    const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > MAX_JSONL_LINE_BYTES) throw safeSourceError(`${source} digest source contains an oversized record.`);
      let row;
      try { row = JSON.parse(line); } catch { malformed += 1; continue; }
      const payload = row?.payload;
      if (source === 'codex' && row?.type === 'session_meta') {
        const id = payload?.id;
        if (rawSessionId && id && id !== rawSessionId) throw safeSourceError('conflicting Codex session id');
        rawSessionId ??= id;
      } else if (source === 'claude-code') {
        const id = row?.sessionId ?? row?.session_id;
        if (rawSessionId && id && id !== rawSessionId) throw safeSourceError('conflicting Claude session id');
        rawSessionId ??= id;
      }
      const human = humanText(row, source);
      if (human !== null) {
        finish();
        turn += 1;
        current = { turn, human, humanTimestamp: timestamp(row), assistant: null, assistantTimestamp: null };
        continue;
      }
      if (!current) continue;
      const assistant = assistantText(row, source);
      if (assistant !== null) {
        current.assistant = assistant;
        current.assistantTimestamp = timestamp(row);
      }
    }
    finish();
  } catch (error) {
    if (error?.digestSourceSafe) throw error;
    throw safeSourceError(`${source} digest source became unreadable during scan.`);
  }
  if (malformed) throw safeSourceError('malformed JSONL makes digest turn identity unreadable');
}

/** Read explicit cues and return only redacted, receipt-bearing evidence. */
export async function scanDigestEvidence({
  config, promptStore, roots = resolvePromptRoots(), sourceStatus = promptStore.sourceStatus,
} = {}) {
  const evidence = [];
  const terminalEvidence = [];
  const scanExcluded = Object.fromEntries(
    ['prompts', 'ideas', 'techniques', 'decisions', 'reversals', 'nextSteps']
      .map((category) => [category, { 'human-cue': 0, 'assistant-final': 0 }]),
  );
  const promptByRef = new Map(promptStore.prompts.map((prompt) => [prompt.ref, prompt]));
  const tombstones = new Set((promptStore.tombstones ?? []).map((value) => value.ref));
  const resolvedPrompts = new Set();
  const seen = new Map();
  let scannedCueCount = 0;
  let acceptedCueCount = 0;
  for (const source of ['claude-code', 'codex']) {
    if (sourceStatus?.[source]?.state !== 'present') continue;
    let files;
    try { files = enumeratePromptFiles(source, roots[source]); }
    catch { throw safeSourceError(`${source} digest source became unreadable during scan.`); }
    for (const file of files) {
      await readTurns(file, source, (rawSessionId, sourceTurn) => {
        const { sessionKey } = promptIdentity(source, rawSessionId, 1);
        const promptRef = promptIdentity(source, rawSessionId, sourceTurn.turn).ref;
        const prompt = promptByRef.get(promptRef);
        if (!prompt) {
          if (!tombstones.has(promptRef) && inScannedWeek(
            sourceTurn.humanTimestamp, sourceStatus[source], config.week.timezone,
          )) throw safeSourceError(`${source} digest source changed during scan.`);
          return;
        }
        if (resolvedPrompts.has(promptRef)) throw safeSourceError(`${source} digest source has a duplicate prompt receipt.`);
        resolvedPrompts.add(promptRef);
        if (sha256(sourceTurn.human) !== prompt.sourceHash) throw safeSourceError(`${source} digest source changed during scan.`);
        const contexts = [
          { raw: sourceTurn.human, kind: 'human-cue', at: prompt.timestamp },
          { raw: sourceTurn.assistant, kind: 'assistant-final', at: sourceTurn.assistantTimestamp },
        ];
        for (const context of contexts) {
          if (typeof context.raw !== 'string') continue;
          const parsed = extractDigestCues(context.raw, {
            envelopeKind: context.kind,
            observedVerification: prompt.observedVerification,
          });
          scannedCueCount += parsed.scannedCount;
          acceptedCueCount += parsed.acceptedCount;
          mergeExcluded(scanExcluded, parsed.unsupported, context.kind);
          let at = prompt.timestamp;
          if (context.at) {
            const d = new Date(context.at);
            if (!Number.isNaN(d.getTime())) at = d.toISOString();
          }
          for (const cue of parsed.cues) {
            const value = evidenceFor(cue.raw, cue, {
              source, sessionKey, turn: sourceTurn.turn, envelopeKind: context.kind,
              timestamp: at, prompt,
            }, config);
            const prior = seen.get(value.evidenceRef);
            if (prior && prior !== value.evidenceCanonical) throw safeSourceError('digest evidence ref collision.');
            if (prior) throw safeSourceError('duplicate digest evidence canonical value.');
            seen.set(value.evidenceRef, value.evidenceCanonical);
            evidence.push(value);
          }
          if (context.kind === 'human-cue') {
            for (const terminal of parsed.terminals) {
              const value = terminalEvidenceFor(terminal.raw, terminal, {
                source, sessionKey, turn: sourceTurn.turn, timestamp: at, prompt,
              }, config);
              const prior = seen.get(value.terminalRef);
              if (prior && prior !== value.terminalCanonical) throw safeSourceError('digest terminal ref collision.');
              if (prior) throw safeSourceError('duplicate digest terminal canonical value.');
              seen.set(value.terminalRef, value.terminalCanonical);
              terminalEvidence.push(value);
            }
          }
        }
      });
    }
  }
  for (const prompt of promptStore.prompts) {
    if (!resolvedPrompts.has(prompt.ref)) throw safeSourceError(`${prompt.source} digest source changed during scan.`);
  }
  evidence.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.source.localeCompare(b.source) ||
    a.sessionKey.localeCompare(b.sessionKey) || a.turn - b.turn || a.ordinal - b.ordinal ||
    a.evidenceRef.localeCompare(b.evidenceRef));
  terminalEvidence.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.source.localeCompare(b.source) ||
    a.sessionKey.localeCompare(b.sessionKey) || a.turn - b.turn || a.ordinal - b.ordinal ||
    a.terminalRef.localeCompare(b.terminalRef));
  return {
    evidence, terminalEvidence, scanExcluded,
    accounting: {
      scannedPromptCount: resolvedPrompts.size,
      acceptedPromptCount: resolvedPrompts.size,
      scannedCueCount,
      acceptedCueCount,
    },
  };
}
