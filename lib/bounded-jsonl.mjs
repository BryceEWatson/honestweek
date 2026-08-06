import { createReadStream } from 'node:fs';

export const MAX_JSONL_RECORD_BYTES = 8 * 1024 * 1024;

export async function* readBoundedJsonlLines(path, { maxBytes = MAX_JSONL_RECORD_BYTES } = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error('JSONL record limit is invalid.');
  let parts = [];
  let pendingBytes = 0;

  const append = (part) => {
    const finalByte = part.length ? part.at(-1) : parts.at(-1)?.at(-1);
    const crlfAllowance = finalByte === 0x0d ? 1 : 0;
    if (pendingBytes + part.length > maxBytes + crlfAllowance) {
      throw new Error('JSONL source contains an oversized record.');
    }
    if (part.length) parts.push(part);
    pendingBytes += part.length;
  };

  for await (const chunk of createReadStream(path)) {
    let start = 0;
    for (let index = chunk.indexOf(0x0a, start); index !== -1; index = chunk.indexOf(0x0a, start)) {
      append(chunk.subarray(start, index));
      let line = parts.length === 1 ? parts[0] : Buffer.concat(parts, pendingBytes);
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      yield line.toString('utf8');
      parts = [];
      pendingBytes = 0;
      start = index + 1;
    }
    append(chunk.subarray(start));
  }

  if (pendingBytes) {
    let line = parts.length === 1 ? parts[0] : Buffer.concat(parts, pendingBytes);
    if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
    yield line.toString('utf8');
  }
}
