#!/usr/bin/env node
/**
 * 升級「系統更新器」(Updater stack)—— 只做這一件事。
 *
 * 為什麼需要這個腳本
 * ──────────────────
 * app 內的「一鍵更新」會部署 Foundation / Execution / Scheduling / ControlPlane / Frontend,
 * 但**不含 Updater 自己**(原本的設計是避免更新時改到正在執行更新的資源)。
 * 結果:更新器本身的修正永遠送不到已安裝的環境 —— 使用者會一直跑著當初安裝的那一版更新器。
 *
 * 2026-10 修掉的三個「升級失敗」成因都在更新器裡:
 *   1. 兩個更新同時跑 → 搶同一個 CloudFormation changeset,第二個以
 *      `Cannot delete ChangeSet in status CREATE_IN_PROGRESS` 失敗
 *      (實測某環境最近 20 次更新有 5 次失敗,每一次都是這個)
 *   2. stack 卡在 ROLLBACK_COMPLETE / UPDATE_ROLLBACK_FAILED → 之後每次升級都失敗
 *   3. 更新器無法更新自己 → 上面兩個修正送不出去
 * 跑過這個腳本一次之後,更新器就會在每次更新時順便更新自己,不需要再手動執行。
 *
 * 用法(在專案根目錄):
 *   node scripts/upgrade-updater.mjs              # 自動偵測區域與 stack 前綴
 *   node scripts/upgrade-updater.mjs --plan-only  # 只檢查,不做任何變更
 *   node scripts/upgrade-updater.mjs --region us-west-2 --stage dev
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const IS_WIN = process.platform === 'win32';

const C = { cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', reset: '\x1b[0m' };
const color = (c, s) => (process.stdout.isTTY ? `${c}${s}${C.reset}` : s);
const step = (t) => console.log(color(C.cyan, `\n==> ${t}`));
const info = (t) => console.log(t);
const ok = (t) => console.log(color(C.green, `  OK ${t}`));
const warn = (t) => console.warn(color(C.yellow, `  ! ${t}`));
function fail(t) { throw new Error(t); }

// ─────────────────────── 可測的純邏輯 ───────────────────────

/** 掃描時會看的區域(先看環境變數指定的,再看常見區域)。 */
export const CANDIDATE_REGIONS = [
  'us-west-2', 'us-east-1', 'us-east-2', 'ap-northeast-1', 'ap-southeast-1', 'eu-west-1',
];

/**
 * 從 stack 名稱清單找出更新器與它的前綴。
 * 名稱規則由 bin/app.ts 決定:<prefix>-Updater。
 * 找到多個時回傳全部,讓呼叫端要求使用者指定 —— 猜錯會升級到別的環境。
 */
export function findUpdaterStacks(names) {
  const found = [];
  for (const n of names ?? []) {
    const m = /^(.+)-Updater$/.exec(String(n ?? ''));
    if (m) found.push({ stackName: String(n), prefix: m[1] });
  }
  return found;
}

/** stack 狀態 → 可否更新,以及(不行時)該怎麼辦。 */
export function classifyStackStatus(status) {
  const s = String(status ?? '').toUpperCase();
  if (/_IN_PROGRESS$/.test(s)) {
    return { ok: false, why: '這個 stack 正在變更中(可能有另一個部署在跑)。請等它結束再試。' };
  }
  if (s === 'ROLLBACK_COMPLETE') {
    return { ok: false, why: '這個 stack 第一次建立就失敗了,CloudFormation 不允許更新。請先刪除它,再重新執行完整安裝(scripts/deploy-latest.mjs)。' };
  }
  if (s === 'UPDATE_ROLLBACK_FAILED') {
    return { ok: false, why: '上一次更新回滾失敗。請在 CloudFormation 主控台對這個 stack 執行 Continue rollback,完成後再試。' };
  }
  if (/^(CREATE|UPDATE|UPDATE_ROLLBACK|IMPORT)_COMPLETE$/.test(s)) return { ok: true };
  if (s === 'MISSING') {
    return { ok: false, why: '找不到這個 stack。這個環境可能還沒安裝過更新器,請改執行完整安裝(scripts/deploy-latest.mjs)。' };
  }
  return { ok: false, why: `無法從 ${s} 這個狀態更新。` };
}

/**
 * 驗證升級後的更新器專案真的帶上了修正。
 * 只看「結果」而不是「有沒有跑過部署」—— 部署成功但內容沒變的情況必須抓出來。
 */
export function verifyProject(project) {
  const problems = [];
  if (project?.concurrentBuildLimit !== 1) {
    problems.push(`並行上限應為 1,實際為 ${project?.concurrentBuildLimit ?? '(未設定)'} —— 兩個更新同時跑會互撞`);
  }
  const spec = String(project?.source?.buildspec ?? '');
  if (!spec.includes('部署前檢查')) problems.push('buildspec 缺少部署前檢查(卡住的 stack 不會被提前擋下)');
  if (!spec.includes('PA_UPDATER_STACK')) problems.push('buildspec 缺少更新器自我更新(之後仍需手動執行本腳本)');
  return problems;
}

/** 參數解析。 */
export function parseArgs(argv) {
  const o = { region: '', stage: '', profile: '', planOnly: false, yes: false };
  const val = (i, name) => { if (!argv[i + 1]) fail(`${name} 缺少值`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return { ...o, help: true };
    else if (a === '--region') o.region = val(i++, a);
    else if (a === '--stage') o.stage = val(i++, a);
    else if (a === '--profile') o.profile = val(i++, a);
    else if (a === '--plan-only') o.planOnly = true;
    else if (a === '--yes' || a === '-y') o.yes = true;
    else fail(`不支援的參數:${a}`);
  }
  return o;
}

// ─────────────────────── 執行層 ───────────────────────

function commandSpec(file, args) {
  // Windows 無法在 shell:false 下直接 spawn *.cmd;改用本行程的 node 執行 npm/npx 的 JS 入口。
  if (IS_WIN && (file === 'npm' || file === 'npx')) {
    const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', file === 'npm' ? 'npm-cli.js' : 'npx-cli.js');
    if (!existsSync(cli)) fail(`找不到 ${file} CLI:${cli}`);
    return { file: process.execPath, args: [cli, ...args] };
  }
  return { file, args };
}

function run(file, args = [], { cwd, capture = false, allowFailure = false } = {}) {
  return new Promise((res, rej) => {
    const spec = commandSpec(file, args);
    const child = spawn(spec.file, spec.args, { cwd, env: process.env, shell: false, stdio: ['inherit', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (b) => { const s = b.toString(); stdout += s; if (!capture) process.stdout.write(s); });
    child.stderr.on('data', (b) => { const s = b.toString(); stderr += s; if (!capture) process.stderr.write(s); });
    child.on('error', (e) => rej(new Error(`無法執行 ${file}:${e.message}`)));
    child.on('close', (code) => {
      const r = { code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() };
      if (r.code !== 0 && !allowFailure) rej(new Error(`${file} 執行失敗(exit=${r.code})${r.stderr ? `\n${r.stderr.slice(-2000)}` : ''}`));
      else res(r);
    });
  });
}
const cap = async (file, args, opts = {}) => (await run(file, args, { capture: true, ...opts })).stdout;

/** 列出某區域裡所有 PlayAgent 的 stack 名(含狀態),用於自動偵測。 */
async function listStackNames(region) {
  const r = await run('aws', [
    'cloudformation', 'list-stacks', '--region', region,
    '--stack-status-filter', 'CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE',
    'ROLLBACK_COMPLETE', 'UPDATE_ROLLBACK_FAILED', 'UPDATE_IN_PROGRESS', 'CREATE_IN_PROGRESS',
    '--query', 'StackSummaries[].StackName', '--output', 'json',
  ], { capture: true, allowFailure: true });
  if (r.code !== 0) return null; // 這個區域問不到(權限/未啟用)
  try { return JSON.parse(r.stdout); } catch { return []; }
}

async function stackStatus(name, region) {
  const r = await run('aws', ['cloudformation', 'describe-stacks', '--region', region, '--stack-name', name,
    '--query', 'Stacks[0].StackStatus', '--output', 'text'], { capture: true, allowFailure: true });
  if (r.code === 0 && r.stdout) return r.stdout;
  if (/does not exist/i.test(r.stderr)) return 'MISSING';
  return `UNKNOWN (${r.stderr.split('\n').pop() || `exit=${r.code}`})`;
}

function usage() {
  console.log(`升級 PlayAgent 系統更新器(只升級 Updater stack)

用法:
  node scripts/upgrade-updater.mjs [選項]

選項:
  --region REGION   AWS 區域(未指定時自動偵測)
  --stage STAGE     CDK stage(未指定時自動偵測)
  --profile NAME    AWS CLI profile
  --plan-only       只檢查,不做任何變更
  -y, --yes         不詢問確認
  -h, --help        顯示說明

為什麼要跑這個:app 內的一鍵更新不會更新「更新器」自己,所以更新器的修正
(並行防護、部署前檢查、自我更新)送不到已安裝的環境。跑過一次之後就會自動了。
`);
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { usage(); return; }
  if (o.profile) process.env.AWS_PROFILE = o.profile;

  step('檢查工具與 AWS 身分');
  for (const [cmd, how] of [['node', 'Node.js 22+'], ['aws', 'AWS CLI v2']]) {
    const probe = IS_WIN ? ['where', cmd] : ['sh', '-c', 'command -v "$1"', 'sh', cmd];
    const r = await run(probe[0], probe.slice(1), { capture: true, allowFailure: true });
    if (r.code !== 0) fail(`找不到 ${cmd}。請先安裝:${how}`);
  }

  // 區域:優先用參數,其次環境變數,最後掃描候選區域找 *-Updater。
  // 自動偵測的理由很實際:指定錯區域時 cdk 會丟「bootstrap 版本找不到」,
  // 那個錯誤完全看不出真正的問題是區域。
  step('偵測區域與 stack 前綴');
  const hinted = [o.region, process.env.AWS_REGION, process.env.AWS_DEFAULT_REGION].filter(Boolean);
  const order = [...new Set([...hinted, ...CANDIDATE_REGIONS])];
  let region = '';
  let candidates = [];
  for (const r of order) {
    const names = await listStackNames(r);
    if (names === null) { info(`  ${r}:問不到(略過)`); continue; }
    const found = findUpdaterStacks(names);
    if (found.length > 0) { region = r; candidates = found; break; }
    info(`  ${r}:沒有找到更新器`);
  }
  if (!region) {
    fail('在這些區域都找不到更新器 stack(名稱應為 <前綴>-Updater):'
      + `${order.join(', ')}\n`
      + '若這個環境還沒安裝過,請執行完整安裝:node scripts/deploy-latest.mjs');
  }
  if (o.stage) {
    const want = o.stage === 'dev' ? 'PlayAgentDev' : `PlayAgent-${o.stage}`;
    candidates = candidates.filter((c) => c.prefix === want);
    if (candidates.length === 0) fail(`區域 ${region} 找不到 stage=${o.stage} 的更新器(前綴 ${want})`);
  }
  if (candidates.length > 1) {
    fail(`區域 ${region} 有多個環境:${candidates.map((c) => c.stackName).join(', ')}\n`
      + '請用 --stage 指定要升級哪一個(猜錯會升級到別的環境)。');
  }
  const { stackName, prefix } = candidates[0];
  const identity = JSON.parse(await cap('aws', ['sts', 'get-caller-identity', '--region', region, '--output', 'json']));
  ok(`區域 ${region} · 環境 ${prefix} · 帳號 ${identity.Account}`);

  step('確認可以安全升級');
  const st = await stackStatus(stackName, region);
  info(`  ${stackName} = ${st}`);
  const verdict = classifyStackStatus(st);
  if (!verdict.ok) fail(`${verdict.why}`);
  ok('stack 狀態可更新');

  // 更新器正在跑的時候不要改它的定義:當前那個 build 不受影響,但同時改動容易看不懂發生什麼事。
  const projectName = `${prefix}-self-update`;
  const builds = await run('aws', ['codebuild', 'list-builds-for-project', '--project-name', projectName,
    '--region', region, '--max-items', '3', '--query', 'ids', '--output', 'json'], { capture: true, allowFailure: true });
  if (builds.code === 0 && builds.stdout) {
    let ids = [];
    try { ids = JSON.parse(builds.stdout) ?? []; } catch { ids = []; }
    if (ids.length > 0) {
      const statuses = await cap('aws', ['codebuild', 'batch-get-builds', '--ids', ...ids,
        '--region', region, '--query', 'builds[].buildStatus', '--output', 'text'], { allowFailure: true });
      if (/IN_PROGRESS/.test(statuses)) fail('目前有更新正在執行。請等它結束後再升級更新器。');
      ok('沒有正在執行的更新');
    }
  } else {
    warn(`查不到 ${projectName} 的 build 記錄(略過這項檢查)`);
  }

  if (o.planOnly) {
    info(color(C.green, `\nPLAN OK:將以 cdk deploy ${stackName} --exclusively 升級更新器(未做任何變更)。`));
    return;
  }

  step(`升級 ${stackName}`);
  // --exclusively:只部署這一個 stack,不連帶部署相依的 Foundation —— 把影響範圍壓到最小。
  // 區域要明確注入:CDK 讀的是 CDK_DEFAULT_REGION,和 aws CLI 的 --region 是兩套。
  Object.assign(process.env, { AWS_REGION: region, AWS_DEFAULT_REGION: region, CDK_DEFAULT_REGION: region });
  const stageArgs = o.stage ? ['-c', `stage=${o.stage}`] : [];
  await run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: ROOT });
  await run('npx', ['cdk', 'deploy', stackName, '--exclusively', '--require-approval', 'never', '--progress', 'events', ...stageArgs],
    { cwd: join(ROOT, 'infra') });

  step('驗證升級結果');
  const proj = JSON.parse(await cap('aws', ['codebuild', 'batch-get-projects', '--names', projectName,
    '--region', region, '--output', 'json']));
  const problems = verifyProject(proj?.projects?.[0]);
  if (problems.length > 0) {
    fail(`更新器部署完成,但內容不符預期:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`
      + '請確認目前的原始碼是含有該修正的版本(git pull 之後重試)。');
  }
  ok('並行上限 = 1');
  ok('部署前檢查已就位');
  ok('更新器會自我更新(之後不用再跑這個腳本)');

  info(color(C.green, '\n========================================\n'
    + ' 更新器升級完成\n'
    + ` 環境    : ${prefix} (${region})\n`
    + ' 接下來  : 到系統管理頁按「一鍵更新」即可;\n'
    + '           之後的每次更新都會順便更新更新器自己。\n'
    + '========================================'));
}

// 直接執行時才跑(被測試 import 時不執行)。
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try { await main(); } catch (e) { console.error(color(C.red, `\n升級失敗:${e?.message ?? e}`)); process.exitCode = 1; }
}
