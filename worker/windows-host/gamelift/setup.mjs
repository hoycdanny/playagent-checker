/**
 * 建立 / 更新 PlayAgent 的 Windows 執行環境(Amazon GameLift Streams)。
 *
 * 做四件事:
 *  1. 準備工具(快取在 PA_TOOLS_DIR;預設 %TEMP%\pa-gls-tools)
 *       - Node.js Windows x64(跑 explorationRunner.mjs)
 *       - innoextract(zlib 授權,解開 Inno Setup 安裝檔,不必真的安裝遊戲)
 *       - ImageMagick 可攜版(座標校正 / pHash;用 innoextract 從官方 static 安裝檔取出)
 *       - runner 的 node_modules(npm install agent/exploration-runner.package.json)
 *  2. 組出 GameLift Streams 應用套件並上傳到專用 S3 桶
 *       launcher.bat → host.ps1 → 下載 runner 與遊戲 → 跑 AI runner → 寫結果 → 結束
 *  3. 建立 / 沿用 Application 與 Stream Group(gen6n_medium_win2022,NVIDIA GPU)
 *  4. 把兩個 ID 寫進 SSM,engine(windowsHost.ts)執行時讀取
 *
 * 用法:node setup.mjs [--capacity 2] [--stack PlayAgentDev-Execution]
 * 需要的權限:S3、GameLift Streams、SSM、STS。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { S3Client, CreateBucketCommand, HeadBucketCommand, PutBucketPolicyCommand, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import {
  GameLiftStreamsClient, CreateApplicationCommand, GetApplicationCommand, ListApplicationsCommand,
  CreateStreamGroupCommand, GetStreamGroupCommand, ListStreamGroupsCommand, UpdateStreamGroupCommand,
  AssociateApplicationsCommand,
} from '@aws-sdk/client-gameliftstreams';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
// 平台部署在 us-west-2。預設值原本是 us-east-2(早期 PoC 的區域),忘記設 AWS_REGION 就會
// 把 Application / Stream Group / SSM 全建到沒人讀的區域,而症狀跟「完全沒建」一模一樣。
const REGION = process.env.AWS_REGION ?? 'us-west-2';
const TOOLS = process.env.PA_TOOLS_DIR ?? join(tmpdir(), 'pa-gls-tools');
const BUILD = join(HERE, '.build', 'app');
const APP_PREFIX = 'app/v1/';
const NODE_VERSION = 'v22.12.0';
const IM_VERSION = '7.1.2-32';
const INNOEXTRACT_VERSION = '1.9';
/** 應用與串流群組的描述(= 識別名稱;ListApplications 沒有 name 欄位,用 Description 認)。 */
const APP_DESC = 'playagent-windows-host';
const SG_DESC = 'playagent-windows';

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const CAPACITY = Number(argOf('capacity', '2'));
const STACK = argOf('stack', 'PlayAgentDev-Execution');
const PARAM_PREFIX = `/playagent/${STACK}/windows-gls`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log(...m);

// ── 1) 工具準備 ───────────────────────────────────────────────────────────

async function download(url, dest) {
  if (existsSync(dest) && statSync(dest).size > 0) return dest;
  log('下載', url);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`下載失敗 ${res.status} ${url}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  log('  →', dest, `${Math.round(statSync(dest).size / 1024 / 1024)} MB`);
  return dest;
}

/** 用 Windows 內建的 bsdtar 解 zip(不必外掛套件)。 */
function unzip(zip, outDir) {
  mkdirSync(outDir, { recursive: true });
  execFileSync('tar', ['-xf', zip, '-C', outDir], { stdio: 'inherit' });
}

function findFile(root, name) {
  if (!existsSync(root)) return null;
  for (const e of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, e.name);
    if (e.isDirectory()) {
      const hit = findFile(p, name);
      if (hit) return hit;
    } else if (e.name.toLowerCase() === name.toLowerCase()) return p;
  }
  return null;
}

async function prepareTools() {
  mkdirSync(TOOLS, { recursive: true });

  // innoextract(zlib 授權):解 Inno Setup 安裝檔,也用來取出 ImageMagick。
  const innoDir = join(TOOLS, 'innoextract');
  if (!existsSync(join(innoDir, 'innoextract.exe'))) {
    const zip = await download(
      `https://constexpr.org/innoextract/files/innoextract-${INNOEXTRACT_VERSION}-windows.zip`,
      join(TOOLS, 'innoextract.zip'),
    );
    unzip(zip, innoDir);
  }
  const innoextract = findFile(innoDir, 'innoextract.exe');
  if (!innoextract) throw new Error('innoextract.exe 準備失敗');

  // Node.js(Windows x64)。
  const nodeDir = join(TOOLS, 'node');
  if (!findFile(nodeDir, 'node.exe')) {
    const zip = await download(
      `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-win-x64.zip`,
      join(TOOLS, 'node.zip'),
    );
    unzip(zip, nodeDir);
  }
  const nodeExe = findFile(nodeDir, 'node.exe');
  if (!nodeExe) throw new Error('node.exe 準備失敗');

  // ImageMagick:官方 Windows static 安裝檔本身是 Inno Setup,用 innoextract 取出 magick.exe。
  const imDir = join(TOOLS, 'im');
  if (!findFile(imDir, 'magick.exe')) {
    const exe = await download(
      `https://github.com/ImageMagick/ImageMagick/releases/download/${IM_VERSION}/ImageMagick-${IM_VERSION}-Q16-x64-static.exe`,
      join(TOOLS, 'im-setup.exe'),
    );
    execFileSync(innoextract, ['--silent', '--extract', '--output-dir', imDir, exe], { stdio: 'inherit' });
  }
  const magick = findFile(imDir, 'magick.exe');
  if (!magick) throw new Error('magick.exe 準備失敗');

  // runner 依賴:用 runner 自己的 package.json 安裝(與 Device Farm 容器同一份清單)。
  const depsDir = join(TOOLS, 'runner-deps');
  if (!existsSync(join(depsDir, 'node_modules'))) {
    mkdirSync(depsDir, { recursive: true });
    cpSync(join(REPO, 'agent', 'exploration-runner.package.json'), join(depsDir, 'package.json'));
    log('安裝 runner 依賴…');
    execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: depsDir, stdio: 'inherit', shell: true });
  }
  return { innoextract, nodeExe, magickDir: dirname(magick), depsDir };
}

// ── 2) 組套件 ─────────────────────────────────────────────────────────────

/** PowerShell 5.1 讀含中文的腳本需要 UTF-8 BOM,否則字串會變亂碼。 */
function writePs1WithBom(src, dest) {
  const text = readFileSync(src, 'utf8').replace(/^\uFEFF/, '');
  writeFileSync(dest, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]));
}

function assemble(tools) {
  rmSync(BUILD, { recursive: true, force: true });
  mkdirSync(BUILD, { recursive: true });
  // GameLift Streams 的進入點:只能指一個檔案,用 .bat 轉呼叫 PowerShell。
  writeFileSync(
    join(BUILD, 'launcher.bat'),
    '@echo off\r\n'
    + 'rem PlayAgent Windows host entry point (Amazon GameLift Streams).\r\n'
    + 'rem The stream session ends when this script exits.\r\n'
    + 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0host.ps1"\r\n',
  );
  writePs1WithBom(join(HERE, 'host.ps1'), join(BUILD, 'host.ps1'));
  cpSync(tools.innoextract, join(BUILD, 'innoextract.exe'));
  mkdirSync(join(BUILD, 'node'), { recursive: true });
  cpSync(tools.nodeExe, join(BUILD, 'node', 'node.exe'));
  // ImageMagick:magick.exe + VC++ runtime DLL + 設定 xml(文件類不帶)。
  mkdirSync(join(BUILD, 'im'), { recursive: true });
  for (const f of readdirSync(tools.magickDir, { withFileTypes: true })) {
    if (!f.isFile()) continue;
    if (!/\.(exe|dll|xml|icc)$/i.test(f.name)) continue;
    cpSync(join(tools.magickDir, f.name), join(BUILD, 'im', f.name));
  }
  cpSync(join(tools.depsDir, 'node_modules'), join(BUILD, 'runner-deps', 'node_modules'), { recursive: true });
  const files = [];
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(p);
    }
  })(BUILD);
  const bytes = files.reduce((n, f) => n + statSync(f).size, 0);
  log(`套件組好:${files.length} 個檔案 ${Math.round(bytes / 1024 / 1024)} MB`);
  return files;
}

// ── 3) S3 ────────────────────────────────────────────────────────────────

async function ensureBucket(s3, bucket, account) {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await s3.send(new CreateBucketCommand({
      Bucket: bucket,
      ...(REGION === 'us-east-1' ? {} : { CreateBucketConfiguration: { LocationConstraint: REGION } }),
    }));
    log('建立桶', bucket);
  }
  // 只允許本帳號的 GameLift Streams 讀應用檔案、寫它自己的 log。
  await s3.send(new PutBucketPolicyCommand({
    Bucket: bucket,
    Policy: JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'GlsReadApp', Effect: 'Allow', Principal: { Service: 'gameliftstreams.amazonaws.com' },
          Action: ['s3:GetObject', 's3:ListBucket'],
          Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/${APP_PREFIX}*`],
          Condition: { StringEquals: { 'aws:SourceAccount': account } },
        },
        {
          Sid: 'GlsWriteLogs', Effect: 'Allow', Principal: { Service: 'gameliftstreams.amazonaws.com' },
          Action: ['s3:PutObject'], Resource: `arn:aws:s3:::${bucket}/logs/*`,
          Condition: { StringEquals: { 'aws:SourceAccount': account } },
        },
        {
          Sid: 'DenyInsecure', Effect: 'Deny', Principal: '*', Action: 's3:*',
          Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`],
          Condition: { Bool: { 'aws:SecureTransport': 'false' } },
        },
      ],
    }),
  }));
}

async function upload(s3, bucket, files) {
  // 既有物件以 size + etag 判斷要不要重傳(node_modules 有數千個小檔)。
  const existing = new Map();
  let token;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: APP_PREFIX, ContinuationToken: token }));
    for (const o of r.Contents ?? []) existing.set(o.Key, { size: o.Size, etag: (o.ETag ?? '').replaceAll('"', '') });
    token = r.NextContinuationToken;
  } while (token);

  let sent = 0, skipped = 0;
  const queue = [...files];
  const worker = async () => {
    for (;;) {
      const f = queue.pop();
      if (!f) return;
      const key = `${APP_PREFIX}${f.slice(BUILD.length + 1).replaceAll('\\', '/')}`;
      const body = readFileSync(f);
      const have = existing.get(key);
      if (have && have.size === body.length && have.etag === createHash('md5').update(body).digest('hex')) { skipped++; continue; }
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
      sent++;
      if (sent % 200 === 0) log(`  上傳 ${sent}…`);
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));
  log(`上傳完成:新增/更新 ${sent}、未變更 ${skipped}`);
  return sent;
}

// ── 4) GameLift Streams 資源 ─────────────────────────────────────────────

async function ensureApplication(gl, bucket, changed) {
  const items = (await gl.send(new ListApplicationsCommand({}))).Items ?? [];
  // 一定要挑「最新的」那個,不是清單裡第一個。
  // 應用內容是建立時從 S3 快照的,改不了,所以套件每更新一次就多一個同名 application。
  // 挑到舊的會安靜地跑舊版套件 —— 程式明明改好也推上去了,主機上跑的卻是改修前的版本,
  // 而且完全沒有任何錯誤訊息。實際踩過一次。
  const existing = items
    .filter((a) => a.Description === APP_DESC && a.Status !== 'DELETING')
    .sort((a, b) => Date.parse(b.CreatedAt ?? 0) - Date.parse(a.CreatedAt ?? 0))[0];
  if (existing && !changed) {
    log('沿用 application', existing.Id, `(建於 ${existing.CreatedAt})`);
    return existing.Id;
  }
  if (existing && changed) log('套件有更新 → 建立新的 application(舊的可於驗證後刪除:', existing.Id, ')');
  const r = await gl.send(new CreateApplicationCommand({
    Description: APP_DESC,
    RuntimeEnvironment: { Type: 'WINDOWS', Version: '2022' },
    ExecutablePath: 'launcher.bat',
    ApplicationSourceUri: `s3://${bucket}/${APP_PREFIX}`,
    ApplicationLogOutputUri: `s3://${bucket}/logs/`,
    ApplicationLogPaths: ['pa-logs/'],
    Tags: { project: 'playagent-checker', component: 'windows-host' },
  }));
  log('建立 application', r.Id);
  for (;;) {
    const a = await gl.send(new GetApplicationCommand({ Identifier: r.Id }));
    log('  application', a.Status, a.StatusReason ?? '');
    if (a.Status === 'READY') return r.Id;
    if (a.Status === 'ERROR') throw new Error(`application 失敗:${a.StatusReason}`);
    await sleep(20_000);
  }
}

async function ensureStreamGroup(gl, appId) {
  const items = (await gl.send(new ListStreamGroupsCommand({}))).Items ?? [];
  const existing = items.find((g) => g.Description === SG_DESC && g.Status !== 'DELETING');
  let id = existing?.Id;
  if (!id) {
    const r = await gl.send(new CreateStreamGroupCommand({
      Description: SG_DESC,
      StreamClass: 'gen6n_medium_win2022',
      DefaultApplicationIdentifier: appId,
      // AlwaysOn 0 = 不保留常駐容量(沒跑測試就不計費);OnDemand = 可同時跑幾個測試。
      LocationConfigurations: [{ LocationName: REGION, AlwaysOnCapacity: 0, OnDemandCapacity: CAPACITY }],
      Tags: { project: 'playagent-checker', component: 'windows-host' },
    }));
    id = r.Id;
    log('建立 stream group', id);
  } else {
    log('沿用 stream group', id);
    await gl.send(new UpdateStreamGroupCommand({
      Identifier: id,
      LocationConfigurations: [{ LocationName: REGION, AlwaysOnCapacity: 0, OnDemandCapacity: CAPACITY }],
    })).catch((e) => log('  更新容量略過:', e.message));
  }
  for (;;) {
    const g = await gl.send(new GetStreamGroupCommand({ Identifier: id }));
    log('  stream group', g.Status, g.StatusReason ?? '');
    if (g.Status === 'ACTIVE') break;
    if (g.Status === 'ERROR') throw new Error(`stream group 失敗:${g.StatusReason}`);
    await sleep(30_000);
  }
  // 套件有更新時會建立新的 application(內容是建立時從 S3 快照的,無法原地改)。
  // 建立 stream group 時 DefaultApplicationIdentifier 會順便關聯,但「沿用」這條路
  // 不會 —— 於是 SSM 指向新 application、group 只認得舊的,下一次開 session 直接失敗。
  // 症狀又跟「環境沒建」幾乎一樣,所以這裡明確補上關聯並驗證。
  await ensureAssociated(gl, id, appId);
  return id;
}

/** 確保 application 已關聯到 stream group(已關聯就跳過)。 */
async function ensureAssociated(gl, sgId, appId) {
  const linked = async () => {
    const g = await gl.send(new GetStreamGroupCommand({ Identifier: sgId }));
    return (g.AssociatedApplications ?? []).some((a) => String(a).endsWith(`/${appId}`));
  };
  if (await linked()) { log('  application 已關聯', appId); return; }
  log('  關聯 application 到 stream group', appId);
  await gl.send(new AssociateApplicationsCommand({ Identifier: sgId, ApplicationIdentifiers: [appId] }));
  for (let i = 0; i < 30; i++) {
    if (await linked()) { log('  關聯完成'); return; }
    await sleep(10_000);
  }
  // 不要在這裡「盡力而為」就算了:關聯沒成功的話,寫進 SSM 的 application 根本跑不起來,
  // 而失敗會發生在使用者送出任務的時候,不是現在。
  throw new Error(`application ${appId} 關聯到 stream group ${sgId} 逾時;請確認 group 狀態後重跑`);
}

// ── main ─────────────────────────────────────────────────────────────────

const sts = new STSClient({ region: REGION });
const account = (await sts.send(new GetCallerIdentityCommand({}))).Account;
const bucket = `playagent-windows-gls-${account}-${REGION.replace(/[^a-z0-9]/g, '')}`;
log(`帳號 ${account} 區域 ${REGION} 桶 ${bucket}`);

const tools = await prepareTools();
const files = assemble(tools);
const s3 = new S3Client({ region: REGION });
await ensureBucket(s3, bucket, account);
const changed = (await upload(s3, bucket, files)) > 0;

const gl = new GameLiftStreamsClient({ region: REGION });
const applicationId = await ensureApplication(gl, bucket, changed);
const streamGroupId = await ensureStreamGroup(gl, applicationId);

const ssm = new SSMClient({ region: REGION });
for (const [name, value] of [['applicationId', applicationId], ['streamGroupId', streamGroupId]]) {
  await ssm.send(new PutParameterCommand({ Name: `${PARAM_PREFIX}/${name}`, Value: value, Type: 'String', Overwrite: true }));
}
log('SSM 已寫入', `${PARAM_PREFIX}/{applicationId,streamGroupId}`);
log(JSON.stringify({ bucket, applicationId, streamGroupId, paramPrefix: PARAM_PREFIX }, null, 2));
