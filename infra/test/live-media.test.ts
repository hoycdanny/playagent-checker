import { describe, expect, test, vi } from 'vitest';
import type { S3Client } from '@aws-sdk/client-s3';

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: async (_c: unknown, cmd: { input: { Key: string } }) => `https://signed/${cmd.input.Key}`,
}));
const { listMediaSegments, readAudioLevels } = await import('../lambda/api/liveMedia.js');
// @ts-expect-error 無 .d.ts 的 .mjs 匯入
const lv = await import('../../agent/liveVideo.mjs');
// @ts-expect-error 無 .d.ts 的 .mjs 匯入
const ma = await import('../../agent/mediaAudio.mjs');

function fakeS3(keys: string[], bodies: Record<string, string> = {}) {
  const send = async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const i = cmd.input;
    if (cmd.constructor.name === 'ListObjectsV2Command') {
      const p = i['Prefix'] as string;
      const after = i['StartAfter'] as string | undefined;
      return { Contents: keys.filter((k) => k.startsWith(p) && (!after || k > after)).sort().map((Key) => ({ Key, Size: 10 })) };
    }
    if (cmd.constructor.name === 'GetObjectCommand') {
      const b = bodies[i['Key'] as string];
      if (b === undefined) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
      return { Body: { transformToString: async () => b } };
    }
    throw new Error(`unsupported ${cmd.constructor.name}`);
  };
  return { send } as unknown as S3Client;
}

const P = 'tenants/t1/jobs/job-1/';
const segs = ['s1700000000000.mp4', 's1700000002400.mp4', 's1700000004800.mp4', 's1700000007200.mp4'].map((n) => `${P}live/${n}`);

describe('listMediaSegments', () => {
  test('no cursor → latest N; cursor → following segments in order', async () => {
    const s3 = fakeS3([...segs, `${P}live/garbage.txt`, `${P}audio/a1700000000000.mp4`]);
    const first = await listMediaSegments(s3, 'b', 't1', 'job-1', 'live', { latest: 2 });
    expect(first.items.map((x) => x.name)).toEqual(['s1700000004800.mp4', 's1700000007200.mp4']);
    expect(first.items[0]!.t).toBe(1700000004800);
    expect(first.items[0]!.url).toContain('signed/');
    expect(first.cursor).toBe('s1700000007200.mp4');

    const next = await listMediaSegments(s3, 'b', 't1', 'job-1', 'live', { after: 's1700000000000.mp4' });
    expect(next.items.map((x) => x.name)).toEqual(['s1700000002400.mp4', 's1700000004800.mp4', 's1700000007200.mp4']);
    const none = await listMediaSegments(s3, 'b', 't1', 'job-1', 'live', { after: 's1700000007200.mp4' });
    expect(none.items).toEqual([]);
    expect(none.cursor).toBe('s1700000007200.mp4');
  });

  test('invalid cursor is ignored; audio kind lists a*.mp4', async () => {
    const s3 = fakeS3([`${P}audio/a1700000000000.mp4`, `${P}audio/levels.json`]);
    const r = await listMediaSegments(s3, 'b', 't1', 'job-1', 'audio', { after: '../x', latest: 1 });
    expect(r.items.map((x) => x.name)).toEqual(['a1700000000000.mp4']);
  });
});

describe('readAudioLevels', () => {
  test('missing → none; present → normalized', async () => {
    expect((await readAudioLevels(fakeS3([]), 'b', 't1', 'job-1')).state).toBe('none');
    const doc = JSON.stringify({ state: 'on', dt: 0.1, chunks: [{ name: 'a', t: 1, dur: 1, rms: [-20] }, { bad: true }] });
    const r = await readAudioLevels(fakeS3([], { [`${P}audio/levels.json`]: doc }), 'b', 't1', 'job-1');
    expect(r.state).toBe('on');
    expect(r.chunks).toHaveLength(1);
  });
});

describe('runner helpers', () => {
  test('completedSegments skips the newest (still recording) and junk', () => {
    expect(lv.completedSegments('s1700000002400.mp4\ns1700000000000.mp4\nx.tmp\ns1700000004800.mp4\n')).toEqual(['s1700000000000.mp4', 's1700000002400.mp4']);
    expect(lv.completedSegments('')).toEqual([]);
  });
  test('recordSize keeps device aspect with even height', () => {
    expect(lv.recordSize(1080, 2404)).toBe('540x1202');
    expect(lv.recordSize(1080, 1920)).toBe('540x960');
  });
  test('parseRmsLines handles -inf and numbers', () => {
    const txt = 'frame:0\nlavfi.astats.Overall.RMS_level=-inf\nframe:1\nlavfi.astats.Overall.RMS_level=-19.84\n';
    expect(ma.parseRmsLines(txt)).toEqual([-120, -19.8]);
  });
});
