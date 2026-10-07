// GameLift Streams PoC 準備:專用 S3 桶 → 上傳 app 資料夾 → 建 Application → 建 Stream Group。
// 用法:node setup.mjs <appDir>    (appDir 內要有 launcher.bat、launcher.ps1、PocHelper.cs、innoextract.exe、SouthParkSetup.exe)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  S3Client, CreateBucketCommand, PutBucketPolicyCommand, PutObjectCommand, HeadBucketCommand,
} from '@aws-sdk/client-s3';
import {
  GameLiftStreamsClient, CreateApplicationCommand, GetApplicationCommand, CreateStreamGroupCommand, GetStreamGroupCommand,
  ListApplicationsCommand, ListStreamGroupsCommand,
} from '@aws-sdk/client-gameliftstreams';

import { REGION, ACCOUNT, BUCKET } from './config.mjs';
const APP_PREFIX = 'app/southpark-v1/';
const appDir = process.argv[2];
const s3 = new S3Client({ region: REGION });
const gl = new GameLiftStreamsClient({ region: REGION });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureBucket() {
  try { await s3.send(new HeadBucketCommand({ Bucket: BUCKET })); console.log('bucket exists'); }
  catch {
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET, CreateBucketConfiguration: { LocationConstraint: REGION } }));
    console.log('bucket created');
  }
  // 只讓 GameLift Streams(本帳號)讀 app/、寫 logs/。
  await s3.send(new PutBucketPolicyCommand({
    Bucket: BUCKET,
    Policy: JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        { Sid: 'GlsReadApp', Effect: 'Allow', Principal: { Service: 'gameliftstreams.amazonaws.com' }, Action: ['s3:GetObject', 's3:ListBucket'],
          Resource: [`arn:aws:s3:::${BUCKET}`, `arn:aws:s3:::${BUCKET}/app/*`], Condition: { StringEquals: { 'aws:SourceAccount': ACCOUNT } } },
        { Sid: 'GlsWriteLogs', Effect: 'Allow', Principal: { Service: 'gameliftstreams.amazonaws.com' }, Action: ['s3:PutObject'],
          Resource: `arn:aws:s3:::${BUCKET}/logs/*`, Condition: { StringEquals: { 'aws:SourceAccount': ACCOUNT } } },
        { Sid: 'DenyInsecure', Effect: 'Deny', Principal: '*', Action: 's3:*', Resource: [`arn:aws:s3:::${BUCKET}`, `arn:aws:s3:::${BUCKET}/*`],
          Condition: { Bool: { 'aws:SecureTransport': 'false' } } },
      ],
    }),
  }));
}

async function uploadApp() {
  for (const f of readdirSync(appDir)) {
    const p = join(appDir, f);
    if (!statSync(p).isFile()) continue;
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: `${APP_PREFIX}${f}`, Body: readFileSync(p) }));
    console.log('uploaded', f, statSync(p).size);
  }
}

async function ensureApplication() {
  const existing = (await gl.send(new ListApplicationsCommand({}))).Items?.find((a) => a.Description === 'playagent-southpark-poc');
  let id = existing?.Id;
  if (!id) {
    const r = await gl.send(new CreateApplicationCommand({
      Description: 'playagent-southpark-poc',
      RuntimeEnvironment: { Type: 'WINDOWS', Version: '2022' },
      ExecutablePath: 'launcher.bat',
      ApplicationSourceUri: `s3://${BUCKET}/${APP_PREFIX}`,
      ApplicationLogOutputUri: `s3://${BUCKET}/logs/`,
      ApplicationLogPaths: ['pa-logs/'],
      Tags: { project: 'playagent-checker', purpose: 'gamelift-poc' },
    }));
    id = r.Id;
    console.log('application created', id);
  }
  for (;;) {
    const a = await gl.send(new GetApplicationCommand({ Identifier: id }));
    console.log('application', a.Status, a.StatusReason ?? '');
    if (a.Status === 'READY') return id;
    if (a.Status === 'ERROR') throw new Error(`application error: ${a.StatusReason}`);
    await sleep(20_000);
  }
}

async function ensureStreamGroup(appId) {
  const existing = (await gl.send(new ListStreamGroupsCommand({}))).Items?.find((g) => g.Description === 'playagent-poc-win');
  let id = existing?.Id;
  if (!id) {
    const r = await gl.send(new CreateStreamGroupCommand({
      Description: 'playagent-poc-win',
      StreamClass: 'gen6n_medium_win2022',
      DefaultApplicationIdentifier: appId,
      // 不保留常駐容量(不開 session 不計費);on-demand 最多 1 個 session。
      LocationConfigurations: [{ LocationName: REGION, AlwaysOnCapacity: 0, OnDemandCapacity: 1 }],
      Tags: { project: 'playagent-checker', purpose: 'gamelift-poc' },
    }));
    id = r.Id;
    console.log('stream group created', id);
  }
  for (;;) {
    const g = await gl.send(new GetStreamGroupCommand({ Identifier: id }));
    console.log('stream group', g.Status, g.StatusReason ?? '');
    if (g.Status === 'ACTIVE') return id;
    if (g.Status === 'ERROR') throw new Error(`stream group error: ${g.StatusReason}`);
    await sleep(30_000);
  }
}

if (appDir) {
  await ensureBucket();
  await uploadApp();
  const appId = await ensureApplication();
  const sg = await ensureStreamGroup(appId);
  console.log(JSON.stringify({ appId, streamGroupId: sg }));
}
