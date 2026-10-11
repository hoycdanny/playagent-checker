import { describe, expect, test } from 'vitest';
import type { S3Client } from '@aws-sdk/client-s3';
import { askTask, cleanQuestion, AskValidationError, maskCredentials, pickLogLines, plainText, readAskHistory, summarizeSteps } from '../lambda/api/taskAsk.js';

function fakeS3(files: Record<string, string>) {
  const store = new Map(Object.entries(files));
  const send = async (cmd: { constructor: { name: string }; input: Record<string, any> }) => {
    const i = cmd.input;
    if (cmd.constructor.name === 'GetObjectCommand') {
      const v = store.get(i['Key']);
      if (v === undefined) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
      return { Body: { transformToString: async () => v } };
    }
    if (cmd.constructor.name === 'PutObjectCommand') { store.set(i['Key'], String(i['Body'])); return {}; }
    if (cmd.constructor.name === 'ListObjectsV2Command') {
      return { Contents: [...store.keys()].filter((k) => k.startsWith(i['Prefix'])).sort().map((Key) => ({ Key })) };
    }
    throw new Error(cmd.constructor.name);
  };
  return { s3: { send } as unknown as S3Client, store };
}

const P = 'tenants/t1/jobs/job-abc/';

describe('task AI Q&A', () => {
  test('maskCredentials hides values in the credentials block but keeps the rest', () => {
    const ctx = ['# 知識', '點 SPIN 開始', '# 可用測試資料 / AVAILABLE TEST CREDENTIALS', '- 帳號 = qa@x.com', '- 密碼: hunter2', '# 記憶', '大廳要先關公告'].join('\n');
    const m = maskCredentials(ctx);
    expect(m).not.toContain('hunter2');
    expect(m).not.toContain('qa@x.com');
    expect(m).toContain('- 帳號');
    expect(m).toContain('大廳要先關公告');
  });

  test('pickLogLines keeps only errors/crashes, dedupes repeats, newest chunks win the budget', () => {
    const a = '# step=3 at=x pid=1\n1700 I/Unity: ok\n1701 E/Unity: NullReferenceException at Foo\n1702 E/Unity: NullReferenceException at Foo';
    const b = '# step=9 at=y pid=1\n1800 E/AndroidRuntime: FATAL EXCEPTION: main\n1801 D/x: noise';
    const out = pickLogLines([{ name: '000001.txt', text: a }, { name: '000002.txt', text: b }], 10_000);
    expect(out).toContain('NullReferenceException');
    expect(out).toContain('(×2)');
    expect(out).toContain('FATAL EXCEPTION');
    expect(out).not.toContain('noise');
    expect(out.indexOf('step=3')).toBeLessThan(out.indexOf('step=9')); // 由舊到新
    expect(pickLogLines([{ name: '1', text: a }, { name: '2', text: b }], 80)).toContain('FATAL'); // 預算不夠 → 留最新
  });

  test('summarizeSteps: recent steps in detail + earlier anomalies', () => {
    const steps = Array.from({ length: 80 }, (_, i) => ({ index: i, screen: '轉軸', action: 'tap', thinking: `t${i}` }));
    (steps[5] as Record<string, unknown>)['override'] = 'stuck_wait';
    const s = summarizeSteps(steps, 50_000);
    expect(s).toContain('共 80 步');
    expect(s).toContain('#5');
    expect(s).toContain('runner改寫=stuck_wait');
    expect(s).toContain('#79');
    expect(s).toContain('t79');
  });

  test('plainText strips markdown the panel cannot render', () => {
    expect(plainText('# 標題\n## **重點**\n---\n```json\n{"a":1}\n```\n1. **粗體**說明')).toBe('標題\n重點\n\n{"a":1}\n\n1. 粗體說明');
  });

  test('cleanQuestion validates', () => {
    expect(cleanQuestion('  有什麼要注意?  ')).toBe('有什麼要注意?');
    expect(() => cleanQuestion('')).toThrow(AskValidationError);
    expect(() => cleanQuestion('x'.repeat(1001))).toThrow(AskValidationError);
  });

  test('askTask builds context from the job, calls the model, keeps history', async () => {
    const { s3 } = fakeS3({
      [`${P}job.json`]: JSON.stringify({ jobId: 'job-abc', backend: 'devicefarm', caseName: 'RTP', caseTask: '長按 SPIN 開 AutoSpin' }),
      [`${P}status.json`]: JSON.stringify({ state: 'error', message: '連續動作失敗' }),
      [`${P}steps/0.json`]: JSON.stringify({ index: 0, screen: '大廳', action: 'tap', thinking: '點遊戲' }),
      [`${P}devlogs/logcat/000001.txt`]: '# step=0 at=x\n1 E/AndroidRuntime: FATAL EXCEPTION: main',
      [`${P}context.json`]: JSON.stringify({ context: '# 可用測試資料\n- 密碼 = secret123\n# 其他\nKB 內容' }),
    });
    const sent: string[] = [];
    const bedrock = {
      send: async (cmd: { input: { modelId: string; body: string } }) => {
        sent.push(cmd.input.body);
        return { body: new TextEncoder().encode(JSON.stringify({ content: [{ type: 'text', text: '注意 #0 的當機' }] })) };
      },
    };
    const r1 = await askTask(s3, 'b', 't1', 'job-abc', '有什麼要注意?', 'zh', { bedrock: bedrock as never });
    expect(r1.answer.text).toBe('注意 #0 的當機');
    const body = JSON.parse(sent[0]!);
    const prompt: string = body.messages.at(-1).content;
    expect(prompt).toContain('FATAL EXCEPTION');
    expect(prompt).toContain('長按 SPIN');
    expect(prompt).toContain('連續動作失敗');
    expect(prompt).not.toContain('secret123');
    // 第二題帶入前文
    await askTask(s3, 'b', 't1', 'job-abc', '那要怎麼修?', 'zh', { bedrock: bedrock as never });
    const body2 = JSON.parse(sent[1]!);
    expect(body2.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect((await readAskHistory(s3, 'b', 't1', 'job-abc')).length).toBe(4);
  });

  test('unknown job → validation error (404)', async () => {
    const { s3 } = fakeS3({});
    await expect(askTask(s3, 'b', 't1', 'job-x', 'q', 'zh', { bedrock: { send: async () => ({}) } as never })).rejects.toThrow('找不到任務');
  });
});
