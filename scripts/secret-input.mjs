#!/usr/bin/env node
import { StringDecoder } from 'node:string_decoder';

const MAX_SECRET_BYTES = 1024;

function stripOneLineEnding(buffer) {
  if (buffer.length >= 2 && buffer.at(-2) === 13 && buffer.at(-1) === 10) return buffer.subarray(0, -2);
  if (buffer.at(-1) === 10 || buffer.at(-1) === 13) return buffer.subarray(0, -1);
  return buffer;
}

/** Read one secret from stdin without ever placing it in argv or logs. */
export async function readSecretFromStdin() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.length;
    if (total > MAX_SECRET_BYTES + 2) {
      value.fill(0);
      for (const previous of chunks) previous.fill(0);
      throw new Error('密碼輸入過長');
    }
    chunks.push(value);
  }
  const combined = Buffer.concat(chunks, total);
  const secret = Buffer.from(stripOneLineEnding(combined));
  combined.fill(0);
  for (const chunk of chunks) chunk.fill(0);
  if (!secret.length) throw new Error('密碼不可空白');
  if (secret.includes(0) || secret.includes(10) || secret.includes(13)) {
    secret.fill(0);
    throw new Error('密碼必須是單行文字');
  }
  return secret;
}

/** Cross-platform hidden TTY input. It intentionally prints no masking characters or length. */
export async function promptHidden(prompt) {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('目前不是互動式終端；請改用 --non-interactive --admin-password-stdin');
  }

  process.stdout.write(prompt);
  const decoder = new StringDecoder('utf8');
  const wasRaw = Boolean(input.isRaw);
  const wasPaused = input.isPaused();
  let value = '';

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      input.off('data', onData);
      input.off('error', onError);
      input.setRawMode(wasRaw);
      if (wasPaused) input.pause();
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(Buffer.from(value, 'utf8'));
      value = '';
    };
    const onError = (error) => finish(error);
    const onData = (chunk) => {
      const text = decoder.write(chunk);
      for (const character of text) {
        if (character === '\r' || character === '\n') { finish(); return; }
        if (character === '\u0003') { finish(new Error('使用者取消')); return; }
        if (character === '\u007f' || character === '\b') {
          value = Array.from(value).slice(0, -1).join('');
          continue;
        }
        if (character >= ' ' && character !== '\u007f') {
          value += character;
          if (Buffer.byteLength(value, 'utf8') > MAX_SECRET_BYTES) {
            finish(new Error('密碼輸入過長'));
            return;
          }
        }
      }
    };

    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
    input.on('error', onError);
  });
}

export function validateCognitoPassword(secret) {
  const password = secret.toString('utf8');
  if (password.length < 8 || password.length > 256) throw new Error('管理員密碼必須為 8–256 字元');
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
    throw new Error('管理員密碼必須包含英文大寫、小寫與數字');
  }
}
