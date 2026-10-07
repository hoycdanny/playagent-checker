// 開一個沒有人連線的 GameLift Streams session(NO_CLIENT_CONNECTION),跑 launcher.ps1,等結束並回報結果。
// 用法:node run.mjs <appId> <streamGroupId> <mode ops|idle> <width> <height> [sessionMinutes]
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { GameLiftStreamsClient, StartStreamSessionCommand, GetStreamSessionCommand } from '@aws-sdk/client-gameliftstreams';
import { BUCKET, REGION } from './config.mjs';

const [appId, sgId, mode = 'ops', w = '1920', h = '1080', minutes = '20'] = process.argv.slice(2);
const s3 = new S3Client({ region: REGION });
const gl = new GameLiftStreamsClient({ region: REGION });
const run = `${mode}-${w}x${h}-${Date.now()}`;
const prefix = `out/${run}/`;
const post = await createPresignedPost(s3, {
  Bucket: BUCKET, Key: `${prefix}\${filename}`,
  Conditions: [['starts-with', '$key', prefix], ['content-length-range', 0, 50 * 1024 * 1024]],
  Expires: 6 * 3600,
});
// key 由 launcher 自己填(fields 裡的 key 拿掉)。
const fields = { ...post.fields };
delete fields.key;
const upload = JSON.stringify({ url: post.url, fields, prefix });
console.log('run', run, 'PA_UPLOAD length', upload.length);

const s = await gl.send(new StartStreamSessionCommand({
  Identifier: sgId,
  ApplicationIdentifier: appId,
  Protocol: 'WebRTC',
  SignalRequest: 'NO_CLIENT_CONNECTION',
  SessionLengthSeconds: Number(minutes) * 60,
  ConnectionTimeoutSeconds: 3600,
  DisplayConfiguration: { Resolution: { Width: Number(w), Height: Number(h) } },
  AdditionalEnvironmentVariables: { PA_UPLOAD: upload, PA_MODE: mode, PA_IDLE_MIN: String(Number(minutes) + 10) },
}));
console.log('session', s.Arn, s.Status);
const t0 = Date.now();
let last = '';
for (;;) {
  const g = await gl.send(new GetStreamSessionCommand({ Identifier: sgId, StreamSessionIdentifier: s.Arn }));
  const line = `${g.Status} ${g.StatusReason ?? ''}`;
  if (line !== last) { console.log(`${Math.round((Date.now() - t0) / 1000)}s`, line); last = line; }
  if (g.Status === 'TERMINATED' || g.Status === 'ERROR') { console.log('logs', g.LogFileLocationUri ?? '-'); break; }
  await new Promise((r) => setTimeout(r, 20_000));
}
const objs = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }));
console.log('results', (objs.Contents ?? []).map((o) => `${o.Key} ${o.Size}`).join('\n'));
