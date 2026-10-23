import { describe, expect, test } from 'vitest';
import type { S3Client } from '@aws-sdk/client-s3';
import { readDeviceLogs } from '../lambda/api/deviceLogs.js';
// @ts-expect-error 無 .d.ts 的 .mjs 匯入
const dl = await import('../../agent/deviceLogs.mjs');

const P = 'tenants/t1/jobs/job-1/devlogs/';
function fakeS3(bodies: Record<string, string>) {
  const send = async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const i = cmd.input;
    if (cmd.constructor.name === 'ListObjectsV2Command') {
      const p = i['Prefix'] as string;
      const after = i['StartAfter'] as string | undefined;
      const keys = Object.keys(bodies).filter((k) => k.startsWith(p) && (!after || k > after)).sort();
      const max = (i['MaxKeys'] as number | undefined) ?? 1000;
      return { Contents: keys.slice(0, max).map((Key) => ({ Key })), IsTruncated: keys.length > max };
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

describe('readDeviceLogs', () => {
  test('pages logcat chunks in order with a cursor; ignores junk names', async () => {
    const s3 = fakeS3({
      [`${P}logcat/000000.txt`]: 'a',
      [`${P}logcat/000001.txt`]: 'b',
      [`${P}logcat/000002.txt`]: 'c',
      [`${P}logcat/../x.txt`]: 'evil',
    });
    const first = await readDeviceLogs(s3, 'b', 't1', 'job-1', 'logcat', { limit: 2 });
    expect(first.items.map((x) => x.text)).toEqual(['a', 'b']);
    expect(first.cursor).toBe('000001.txt');
    expect(first.more).toBe(true);
    const next = await readDeviceLogs(s3, 'b', 't1', 'job-1', 'logcat', { after: first.cursor! });
    expect(next.items.map((x) => x.text)).toEqual(['c']);
    expect(next.more).toBe(false);
  });

  test('host chunks (Windows host.ps1) read as text, same paging as logcat', async () => {
    // Windows 任務的主機 log:host.ps1 把下載 / 安裝 / 啟動的紀錄以 logcat 行格式分段上傳。
    // 它是 Windows 唯一能看到「AI runner 還沒起來之前」發生什麼事的來源,所以必須跟
    // logcat 走同一條讀取路徑(文字、序號分頁),而不是被當成 JSON 解析後整段丟掉。
    const s3 = fakeS3({
      [`${P}host/000001.txt`]: '# step=0 dev=1792725358.153 sent=1792725358153\n1792725358.153  1  0  I  host: start',
      [`${P}host/000002.txt`]: '1792725361.000  1  0  E  install: 安裝程式卡住',
    });
    const r = await readDeviceLogs(s3, 'b', 't1', 'job-1', 'host');
    expect(r.items.map((x) => x.name)).toEqual(['000001.txt', '000002.txt']);
    expect(r.items[1]!.text).toContain('install: 安裝程式卡住');
    // 不是 JSON 類:data 必須是 undefined,否則前端會拿不到 text 而顯示空面板。
    expect(r.items[0]!.data).toBeUndefined();
    expect(r.items[0]!.text).toContain('host: start');
  });

  test('audio snapshots are parsed JSON', async () => {
    const s3 = fakeS3({ [`${P}audio/000000.json`]: JSON.stringify({ step: 3, players: [{ piid: 1, state: 'started' }] }) });
    const r = await readDeviceLogs(s3, 'b', 't1', 'job-1', 'audio');
    expect(r.items[0]!.data).toMatchObject({ step: 3, players: [{ state: 'started' }] });
  });

  test('response budget splits huge logcat pages', async () => {
    // 每段最多 40 萬字(估 0.8 MB),預算 3 MB → 一頁最多 3 段,其餘下一頁。
    const big = 'x'.repeat(1_000_000);
    const s3 = fakeS3(Object.fromEntries([0, 1, 2, 3, 4].map((n) => [`${P}logcat/00000${n}.txt`, big])));
    const r = await readDeviceLogs(s3, 'b', 't1', 'job-1', 'logcat');
    expect(r.items).toHaveLength(3);
    expect(r.items[0]!.text!.length).toBe(400_000);
    expect(r.more).toBe(true);
    expect(r.cursor).toBe('000002.txt');
  });
});

describe('runner device log parsers', () => {
  test('parsePlayers reads dumpsys audio playback activity', () => {
    const txt = [
      '  playback activity as reported through PlayerBase:',
      '  ID:15 -- type:android.media.AudioTrack -- u/pid:10234/12345 -- state:started -- attr:AudioAttributes: usage=USAGE_GAME content=CONTENT_TYPE_UNKNOWN flags=0x800',
      '  AudioPlaybackConfiguration piid:15 deviceIds:[2] u/pid:10234/12345 type:android.media.AudioTrack attr:AudioAttributes: usage=USAGE_GAME content=CONTENT_TYPE_UNKNOWN flags=0x800 state:started',
      '  AudioPlaybackConfiguration piid:23 deviceIds:[] u/pid:1000/900 type:android.media.SoundPool attr:AudioAttributes: usage=USAGE_ASSISTANCE_SONIFICATION content=CONTENT_TYPE_SONIFICATION state:idle',
    ].join('\n');
    // ID:15 與 piid:15 是同一個播放器(兩種格式都有時只算一次)。
    expect(dl.parsePlayers(txt)).toEqual([
      { piid: 15, pid: 12345, usage: 'GAME', content: 'UNKNOWN', type: 'AudioTrack', state: 'started' },
      { piid: 23, pid: 900, usage: 'ASSISTANCE_SONIFICATION', content: 'SONIFICATION', type: 'SoundPool', state: 'idle' },
    ]);
  });

  test('parseFlinger reads output threads', () => {
    const txt = 'Output thread 0x7a1b2c3d0 type 0 (MIXER):\n  Standby: no\n  2 Tracks of which 1 are active\nOutput thread 0x7a1b2c3e0 type 1 (DIRECT):\n  Standby: yes\n  0 Tracks of which 0 are active\n';
    expect(dl.parseFlinger(txt)).toEqual([
      { thread: '0x7a1b2c3d0', standby: false, tracks: 2, active: 1 },
      { thread: '0x7a1b2c3e0', standby: true, tracks: 0, active: 0 },
    ]);
  });

  test('collect: incremental logcat via device time, merged + sorted, rejects unsafe package names', async () => {
    const cmds: string[] = [];
    const puts = new Map<string, string>();
    const out = [
      '@@NOW', '1791193344.123',
      '@@PID', '12345',
      '@@APP', '1791193340.500  12345 12350 I Unity   : hello', '1791193341.000  12345 12350 W Unity   : warn',
      '@@SYS', '1791193340.900   900   901 E AudioFlinger: underrun', '1791193341.000  12345 12350 W Unity   : warn',
      '@@AUDIO', '', '@@FLINGER', 'Output thread 0x1 type 0 (MIXER):', '  Standby: no',
    ].join('\n');
    const client = { shell: async (c: string) => { cmds.push(c); return out; } };
    const logs = dl.createDeviceLogs({ client, put: async (k: string, b: string) => { puts.set(k, b); }, prefix: 'p', pkg: 'com.demo.game' });
    await logs.collect(0);
    await logs.collect(1);
    expect(cmds[0]).toContain('pidof -s com.demo.game');
    expect(cmds[0]).toContain('-t 300');
    expect(cmds[1]).toContain('-T 1791193344.123');
    const text = puts.get('p/devlogs/logcat/000000.txt')!;
    expect(text.split('\n').slice(1, 4)).toEqual([
      '1791193340.500  12345 12350 I Unity   : hello',
      '1791193340.900   900   901 E AudioFlinger: underrun',
      '1791193341.000  12345 12350 W Unity   : warn',
    ]);
    expect(JSON.parse(puts.get('p/devlogs/audio/000000.json')!).outputs).toEqual([{ thread: '0x1', standby: false }]);

    const evil: string[] = [];
    const bad = dl.createDeviceLogs({ client: { shell: async (c: string) => { evil.push(c); return out; } }, put: async () => {}, prefix: 'p', pkg: 'x; rm -rf /' });
    await bad.collect(0);
    expect(evil[0]).not.toContain('rm -rf');
  });
});
