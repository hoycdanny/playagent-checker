import { describe, expect, test } from 'vitest';
import { askTask } from '../lambda/api/taskAsk.js';
import { LANG_NAME } from '../lambda/api/genLocale.js';

/** S3 stub: job.json exists, everything else is empty; PutObject is swallowed. */
const s3 = {
  send: async (cmd: { constructor: { name: string }; input: { Key?: string } }) => {
    const name = cmd.constructor.name;
    if (name === 'GetObjectCommand') {
      if (cmd.input.Key?.endsWith('/job.json')) return { Body: { transformToString: async () => JSON.stringify({ backend: 'x' }) } };
      throw new Error('NoSuchKey');
    }
    if (name === 'ListObjectsV2Command') return { Contents: [] };
    return {};
  },
} as never;

/** Fake Bedrock (InvokeModel, Anthropic shape). Captures the request body. */
function fakeBedrock(stopReason = 'end_turn') {
  const calls: Array<{ system: string }> = [];
  return {
    calls,
    client: {
      send: async (cmd: { input: { body: string } }) => {
        calls.push({ system: (JSON.parse(cmd.input.body) as { system: string }).system });
        return { body: new TextEncoder().encode(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: stopReason })) };
      },
    } as never,
  };
}

const run = async (lang: Parameters<typeof askTask>[5], stopReason?: string) => {
  const b = fakeBedrock(stopReason);
  const res = await askTask(s3, 'b', 't', 'job1', 'q', lang, { bedrock: b.client, modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0' });
  return { system: b.calls[0]!.system, text: res.answer.text };
};

describe('askTask answer language', () => {
  test('ja names Japanese, ko names Korean, zh-Hans names Simplified Chinese, en names English', async () => {
    for (const l of ['ja', 'ko', 'zh-Hans', 'en'] as const) {
      const { system } = await run(l);
      expect(system.trimEnd().endsWith(`${LANG_NAME[l]}回答。`)).toBe(true);
    }
  });

  test('zh-Hant and a missing lang keep the Traditional Chinese prompt, byte-identical', async () => {
    const a = await run('zh-Hant');
    const b = await run(undefined);
    expect(a.system).toBe(b.system);
    expect(a.system.endsWith('用繁體中文回答。')).toBe(true);
  });

  test('ko cut note is Korean', async () => {
    const { text } = await run('ko', 'max_tokens');
    expect(text).toContain('답변이 길어');
  });

  test('en cut note keeps the current English text', async () => {
    const { text } = await run('en', 'max_tokens');
    expect(text).toContain('answer cut off');
  });
});
