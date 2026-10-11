import { describe, expect, test, vi } from 'vitest';
import type { S3Client } from '@aws-sdk/client-s3';
import { existsSync } from 'node:fs';
import { writeFile as writeFileP } from 'node:fs/promises';

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: async (_c: unknown, cmd: { input: { Key: string } }) => `https://signed/${cmd.input.Key}`,
}));
const { listMediaSegments, readAudioLevels, withRecordingUrls } = await import('../lambda/api/liveMedia.js');
// @ts-expect-error 無 .d.ts 的 .mjs 匯入
const lv = await import('../../agent/liveVideo.mjs');
// @ts-expect-error 無 .d.ts 的 .mjs 匯入
const ma = await import('../../agent/mediaAudio.mjs');
// @ts-expect-error 無 .d.ts 的 .mjs 匯入
const mf = await import('../../agent/moveFeedback.mjs');

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
  test('recording state is kept; replay URLs only for recording file names', async () => {
    const doc = JSON.stringify({
      state: 'recording',
      dt: 0.1,
      chunks: [
        { name: 'rec-0.mp4', t: 1, dur: 1, rms: [-20] },
        { name: 'a1700000000000.mp4', t: 2, dur: 1, rms: [-20] },
        { name: '../../secret.json', t: 3, dur: 1, rms: [-20] },
      ],
    });
    const s3 = fakeS3([], { [`${P}audio/levels.json`]: doc });
    const r = await withRecordingUrls(s3, 'b', 't1', 'job-1', await readAudioLevels(s3, 'b', 't1', 'job-1'));
    expect(r.state).toBe('recording');
    expect(r.chunks.map((c) => c.url)).toEqual([`https://signed/${P}audio/rec-0.mp4`, `https://signed/${P}audio/a1700000000000.mp4`, undefined]);
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

describe('continuous recorder (one recording per run)', () => {
  type Call = { name: string; args?: Record<string, unknown> };
  function setup(opts: { uploadFails?: boolean; autoEndOnce?: boolean; startIndex?: number; initialChunks?: unknown[]; streamed?: string[]; analyzed?: boolean[] } = {}) {
    const calls: Call[] = [];
    const puts = new Map<string, unknown>();
    let running = false;
    let autoEnded = false;
    let tick: (() => void) | null = null;
    const client = {
      mobile: async (name: string, args?: Record<string, unknown>) => {
        calls.push({ name, ...(args ? { args } : {}) });
        if (name === 'startMediaProjectionRecording') { running = true; return true; }
        if (name === 'isMediaProjectionRecordingRunning') {
          if (opts.autoEndOnce && !autoEnded) { autoEnded = true; running = false; }
          return running;
        }
        if (name === 'stopMediaProjectionRecording') {
          running = false;
          if (args?.['remotePath']) {
            if (opts.uploadFails) throw new Error('upload failed');
            puts.set('uploaded', args);
            return '';
          }
          return Buffer.from('fake-mp4').toString('base64');
        }
        return null;
      },
    };
    const rec = ma.createMediaRecorder({
      client,
      prefix: 'tenants/t1/jobs/job-1',
      put: async (k: string, body: unknown) => { puts.set(k, body); },
      presignPost: async (key: string) => ({ url: `https://s3.example/${key}`, fields: { key, policy: 'p' } }),
      ...(opts.streamed
        ? { downloadTo: async (_k: string, file: string) => { opts.streamed!.push(file); await writeFileP(file, 'fake-mp4'); return 3_000_000_000; } }
        : { download: async () => Buffer.from('fake-mp4') }),
      analyze: async (file: string) => { opts.analyzed?.push(existsSync(file)); return [-30, -20, -120, -10]; },
      setIntervalFn: (fn: () => void) => { tick = fn; return 1; },
      clearIntervalFn: () => {},
      ...(opts.startIndex !== undefined ? { startIndex: opts.startIndex, initialChunks: opts.initialChunks } : {}),
    });
    return { rec, calls, puts, tick: () => tick?.() };
  }
  const levels = (puts: Map<string, unknown>) => JSON.parse(String(puts.get('tenants/t1/jobs/job-1/audio/levels.json')));

  test('starts once, stops once and uploads straight to S3 via presigned POST', async () => {
    const { rec, calls, puts } = setup();
    expect(await rec.start()).toBe(true);
    expect(levels(puts).state).toBe('recording');
    await rec.stop();
    const names = calls.map((c) => c.name);
    expect(names.filter((n) => n === 'startMediaProjectionRecording')).toHaveLength(1);
    const stop = calls.find((c) => c.name === 'stopMediaProjectionRecording')!;
    expect(stop.args).toMatchObject({ remotePath: 'https://s3.example/tenants/t1/jobs/job-1/audio/rec-0.mp4', method: 'POST', fileFieldName: 'file' });
    expect(stop.args!['formFields']).toEqual({ key: 'tenants/t1/jobs/job-1/audio/rec-0.mp4', policy: 'p' });
    const doc = levels(puts);
    expect(doc.state).toBe('on');
    expect(doc.chunks).toHaveLength(1);
    expect(doc.chunks[0]).toMatchObject({ name: 'rec-0.mp4', dur: 0.4, rms: [-30, -20, -120, -10] });
  });

  test('long recordings are streamed to a temp file (never loaded into memory), then the file is removed', async () => {
    const streamed: string[] = [];
    const analyzed: boolean[] = [];
    const { rec, puts } = setup({ streamed, analyzed });
    await rec.start();
    await rec.stop();
    expect(streamed).toHaveLength(1);
    expect(analyzed).toEqual([true]); // 分析時檔案在
    expect(existsSync(streamed[0]!)).toBe(false); // 分析完刪掉
    expect(levels(puts).chunks[0]).toMatchObject({ name: 'rec-0.mp4', bytes: 3_000_000_000 });
  });

  test('direct upload failure → falls back to base64 and uploads itself', async () => {
    const { rec, puts } = setup({ uploadFails: true });
    await rec.start();
    await rec.stop();
    expect(String(puts.get('tenants/t1/jobs/job-1/audio/rec-0.mp4'))).toBe('fake-mp4');
    expect(levels(puts).chunks).toHaveLength(1);
  });

  test('watchdog: recording hit its max length → keeps it and starts the next one', async () => {
    const { rec, calls, puts, tick } = setup({ autoEndOnce: true });
    await rec.start();
    tick();
    for (let k = 0; k < 20; k++) await new Promise((r) => setTimeout(r, 0)); // 讓看門狗跑完
    await rec.stop();
    expect(calls.filter((c) => c.name === 'startMediaProjectionRecording')).toHaveLength(2);
    expect(levels(puts).chunks.map((c: { name: string }) => c.name)).toEqual(['rec-0.mp4', 'rec-1.mp4']);
  });

  test('new connection (long run): continues the part number and keeps earlier parts', async () => {
    const first = setup();
    await first.rec.start();
    await first.rec.stop();
    const second = setup({ startIndex: first.rec.nextIndex, initialChunks: first.rec.chunks });
    await second.rec.start();
    await second.rec.stop();
    expect(levels(second.puts).chunks.map((c: { name: string }) => c.name)).toEqual(['rec-0.mp4', 'rec-1.mp4']);
  });

  test('device cannot record → start() returns false and marks unavailable', async () => {
    const puts = new Map<string, unknown>();
    const rec = ma.createMediaRecorder({
      client: { mobile: async () => { throw new Error('not supported'); } },
      prefix: 'p',
      put: async (k: string, b: unknown) => { puts.set(k, b); },
      presignPost: async () => ({ url: '', fields: {} }),
      download: async () => Buffer.alloc(0),
      maxSec: 900,
      setIntervalFn: () => 1,
      clearIntervalFn: () => {},
    });
    expect(await rec.start()).toBe(false);
    expect(JSON.parse(String(puts.get('p/audio/levels.json'))).state).toBe('unavailable');
  });
});

describe('joystick move feedback', () => {
  test('normDir / turnDir', () => {
    expect(mf.normDir('Up-Left')).toBe('upleft');
    expect(mf.normDir('sideways')).toBeNull();
    expect(mf.turnDir('right', 1)).toBe('down');
    expect(mf.turnDir('right', 2)).toBe('up');
    expect(mf.turnDir('right', 3)).toBe('left');
  });
  test('isBlocked uses the scene-band threshold', () => {
    const ham = (a: string, b: string) => Number(b) - Number(a);
    expect(mf.isBlocked('0', '0', ham)).toBe(true);
    expect(mf.isBlocked('0', '16', ham)).toBe(true);
    expect(mf.isBlocked('0', '278', ham)).toBe(false);
    expect(mf.isBlocked(null, '0', ham)).toBe(false);
  });
});
