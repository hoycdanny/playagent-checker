#!/usr/bin/env node
/**
 * PlayAgent Checker cross-platform one-click installer/updater.
 * Node.js 22+; tested on Windows 10/PowerShell 5.1 + Docker Desktop.
 * macOS/Linux use the exact same Node code (only the launcher differs).
 */
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
const CALLER_ROOT = resolve(HERE, '..');
const IS_WIN = process.platform === 'win32';
const DEFAULT_REPO = 'https://github.com/hoycdanny/playagent-checker.git';
let logStream = null;

const C = { cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', reset: '\x1b[0m' };
const color = (c, s) => process.stdout.isTTY ? `${c}${s}${C.reset}` : s;
function step(text) { const s = `\n==> ${text}`; console.log(color(C.cyan, s)); logStream?.write(`${s}\n`); }
function info(text) { console.log(text); logStream?.write(`${text}\n`); }
function warn(text) { const s = `WARNING: ${text}`; console.warn(color(C.yellow, s)); logStream?.write(`${s}\n`); }
function fail(text) { throw new Error(text); }


function commandSpec(file, args) {
  // Windows cannot spawn *.cmd with shell:false (EINVAL). Invoke npm's JS entry through the
  // current node.exe instead; this preserves argument boundaries and avoids shell injection.
  if (IS_WIN && (file === 'npm' || file === 'npx')) {
    const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', file === 'npm' ? 'npm-cli.js' : 'npx-cli.js');
    if (!existsSync(cli)) fail(`找不到 ${file} CLI:${cli}`);
    return { file: process.execPath, args: [cli, ...args] };
  }
  return { file, args };
}

/** Spawn without a shell (no quoting differences/injection); optionally capture or suppress output. */
function run(file, args = [], { cwd, capture = false, quiet = false, input, allowFailure = false, env } = {}) {
  return new Promise((resolvePromise, reject) => {
    const spec = commandSpec(file, args);
    const child = spawn(spec.file, spec.args, {
      cwd,
      env: { ...process.env, ...(env ?? {}) },
      shell: false,
      windowsHide: false,
      stdio: [input === undefined ? 'inherit' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (b) => {
      const s = b.toString(); stdout += s;
      if (!capture && !quiet) process.stdout.write(s);
      if (!capture && !quiet) logStream?.write(s);
    });
    child.stderr.on('data', (b) => {
      const s = b.toString(); stderr += s;
      if (!capture && !quiet) process.stderr.write(s);
      if (!capture && !quiet) logStream?.write(s);
    });
    child.on('error', (e) => reject(new Error(`無法執行 ${file}:${e.message}`)));
    child.on('close', (code) => {
      const result = { code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() };
      if (result.code !== 0 && !allowFailure) {
        reject(new Error(`${file} 執行失敗(exit=${result.code})${result.stderr ? `\n${result.stderr.slice(-3000)}` : ''}`));
      } else resolvePromise(result);
    });
    if (input !== undefined) child.stdin.end(input);
  });
}
async function succeeds(file, args, cwd) { return (await run(file, args, { cwd, quiet: true, allowFailure: true })).code === 0; }
async function capture(file, args, cwd, options = {}) { return (await run(file, args, { cwd, capture: true, ...options })).stdout; }
async function requireCommand(name, install) {
  const probe = IS_WIN ? ['where', name] : ['sh', '-c', `command -v "$1"`, 'sh', name];
  const ok = IS_WIN ? await succeeds(probe[0], probe.slice(1)) : await succeeds(probe[0], probe.slice(1));
  if (!ok) fail(`找不到 ${name}。請先安裝:${install}`);
}

function usage() {
  console.log(`PlayAgent Checker latest installer

Usage:
  node scripts/deploy-latest.mjs [options]

Options:
  --repository-url URL       canonical repository (${DEFAULT_REPO})
  --branch NAME              branch to deploy (main)
  --region REGION            AWS region (us-east-2)
  --stage STAGE              CDK stage (dev)
  --profile PROFILE          AWS CLI profile
  --expected-account-id ID   fail if the active AWS account differs
  --context key=value        extra CDK context (repeatable)
  --admin-email EMAIL        create/update the first admin
  --admin-tenant TENANT      admin tenant
  --admin-password-env NAME  password environment variable (PA_ADMIN_PASSWORD)
  --skip-tests               skip repeated tests
  --skip-bootstrap           skip CDK bootstrap
  --plan-only                latest-source + preflight check, no changes
  --non-interactive          do not prompt
  -h, --help                 show this help
`);
}

function parseArgs(argv) {
  const o = {
    repositoryUrl: DEFAULT_REPO, branch: 'main', region: 'us-east-2', stage: 'dev', profile: '',
    expectedAccountId: '', context: [], adminEmail: '', adminTenant: '', adminPasswordEnv: 'PA_ADMIN_PASSWORD',
    skipTests: false, skipBootstrap: false, planOnly: false, nonInteractive: false,
    internal: false, sourceRoot: '', sourceSha: '',
  };
  const value = (i, name) => { if (!argv[i + 1]) fail(`${name} 缺少值`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { usage(); process.exit(0); }
    else if (a === '--repository-url') o.repositoryUrl = value(i++, a);
    else if (a === '--branch') o.branch = value(i++, a);
    else if (a === '--region') o.region = value(i++, a);
    else if (a === '--stage') o.stage = value(i++, a);
    else if (a === '--profile') o.profile = value(i++, a);
    else if (a === '--expected-account-id') o.expectedAccountId = value(i++, a);
    else if (a === '--context') o.context.push(value(i++, a));
    else if (a === '--admin-email') o.adminEmail = value(i++, a);
    else if (a === '--admin-tenant') o.adminTenant = value(i++, a);
    else if (a === '--admin-password-env') o.adminPasswordEnv = value(i++, a);
    else if (a === '--skip-tests') o.skipTests = true;
    else if (a === '--skip-bootstrap') o.skipBootstrap = true;
    else if (a === '--plan-only') o.planOnly = true;
    else if (a === '--non-interactive') o.nonInteractive = true;
    else if (a === '--internal') o.internal = true;
    else if (a === '--source-root') o.sourceRoot = value(i++, a);
    else if (a === '--source-sha') o.sourceSha = value(i++, a);
    else fail(`不支援的參數:${a}`);
  }
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(o.branch)) fail('Branch 格式不正確');
  return o;
}

async function question(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(prompt)).trim(); } finally { rl.close(); }
}
async function hiddenQuestion(prompt) {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) return question(prompt);
  process.stdout.write(prompt);
  process.stdin.setRawMode(true); process.stdin.resume();
  let value = '';
  return new Promise((resolvePromise) => {
    const onData = (b) => {
      const s = b.toString('utf8');
      if (s === '\r' || s === '\n') {
        process.stdin.off('data', onData); process.stdin.setRawMode(false); process.stdout.write('\n'); resolvePromise(value); return;
      }
      if (s === '\u0003') { process.stdin.setRawMode(false); process.exit(130); }
      if (s === '\u007f' || s === '\b') { value = value.slice(0, -1); return; }
      if (/^[\x20-\x7e]+$/.test(s)) value += s;
    };
    process.stdin.on('data', onData);
  });
}

function childArgs(o, root, sha) {
  const a = ['--internal', '--source-root', root, '--source-sha', sha,
    '--repository-url', o.repositoryUrl, '--branch', o.branch, '--region', o.region, '--stage', o.stage,
    '--admin-password-env', o.adminPasswordEnv];
  if (o.profile) a.push('--profile', o.profile);
  if (o.expectedAccountId) a.push('--expected-account-id', o.expectedAccountId);
  for (const c of o.context) a.push('--context', c);
  if (o.adminEmail) a.push('--admin-email', o.adminEmail);
  if (o.adminTenant) a.push('--admin-tenant', o.adminTenant);
  if (o.skipTests) a.push('--skip-tests');
  if (o.skipBootstrap) a.push('--skip-bootstrap');
  if (o.planOnly) a.push('--plan-only');
  if (o.nonInteractive) a.push('--non-interactive');
  return a;
}

async function removeSource(repoRoot, work, isWorktree) {
  if (isWorktree) {
    for (let i = 0; i < 3; i++) {
      if (await succeeds('git', ['-C', repoRoot, 'worktree', 'remove', '--force', work])) return;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  try { rmSync(work, { recursive: true, force: true, maxRetries: 6, retryDelay: 1000 }); }
  catch { warn(`請稍後手動刪除暫存目錄:${work}`); }
  if (isWorktree) await run('git', ['-C', repoRoot, 'worktree', 'prune'], { quiet: true, allowFailure: true });
}

/** Always execute the latest copy of this script from an isolated source tree. */
async function outer(o) {
  await requireCommand('git', 'https://git-scm.com/downloads');
  const isRepo = await succeeds('git', ['-C', CALLER_ROOT, 'rev-parse', '--is-inside-work-tree']);
  for (let round = 1; round <= 3; round++) {
    step(`取得最新版 (${o.repositoryUrl} / ${o.branch}),第 ${round} 輪`);
    let work, sha, isWorktree = false;
    if (isRepo) {
      await run('git', ['-C', CALLER_ROOT, 'fetch', '--force', '--prune', o.repositoryUrl,
        `+refs/heads/${o.branch}:refs/remotes/playagent-installer/${o.branch}`]);
      sha = await capture('git', ['-C', CALLER_ROOT, 'rev-parse', `refs/remotes/playagent-installer/${o.branch}^{commit}`]);
      work = join(tmpdir(), `playagent-latest-${sha.slice(0, 12)}-${process.pid}-${round}`);
      await run('git', ['-C', CALLER_ROOT, 'worktree', 'add', '--detach', work, sha]);
      isWorktree = true;
    } else {
      work = join(tmpdir(), `playagent-latest-clone-${process.pid}-${round}`);
      await run('git', ['clone', '--quiet', '--single-branch', '--branch', o.branch, o.repositoryUrl, work]);
      sha = await capture('git', ['-C', work, 'rev-parse', 'HEAD']);
    }
    try {
      info(color(C.green, `將部署 commit ${sha}`));
      await run(process.execPath, [join(work, 'scripts', 'deploy-latest.mjs'), ...childArgs(o, work, sha)]);
    } finally {
      await removeSource(CALLER_ROOT, work, isWorktree);
    }
    const latest = (await capture('git', ['ls-remote', o.repositoryUrl, `refs/heads/${o.branch}`])).split(/\s+/)[0];
    if (latest === sha) { info(color(C.green, `\n最新版部署完成:${sha}`)); return; }
    warn(`部署期間 main 已更新:${sha} -> ${latest};自動重跑最新版。`);
  }
  fail('main 在三輪部署期間持續更新,請稍後再執行一次。');
}

function contextArgs(o, imageTag) {
  const a = ['-c', `stage=${o.stage}`, '-c', `runnerImageTag=${imageTag}`];
  for (const c of o.context) if (c.trim()) a.push('-c', c.trim());
  return a;
}
async function deployStacks(o, stacks, tag, concurrency = 2) {
  await run('npx', ['cdk', 'deploy', ...stacks, '--require-approval', 'never', '--concurrency', String(concurrency), ...contextArgs(o, tag)], { cwd: join(o.sourceRoot, 'infra') });
}
async function stackOutputs(name, region) {
  return JSON.parse(await capture('aws', ['cloudformation', 'describe-stacks', '--region', region, '--stack-name', name, '--query', 'Stacks[0].Outputs', '--output', 'json']));
}
const outputStarting = (outs, prefix) => String(outs.find((x) => String(x.OutputKey).startsWith(prefix))?.OutputValue ?? '');
const outputContaining = (outs, text) => String(outs.find((x) => String(x.OutputKey).includes(text))?.OutputValue ?? '');
async function imageDigest(repo, tag, region) {
  return capture('aws', ['ecr', 'describe-images', '--region', region, '--repository-name', repo, '--image-ids', `imageTag=${tag}`, '--query', 'imageDetails[0].imageDigest', '--output', 'text']);
}
async function ensureRepo(name, region) {
  if (await succeeds('aws', ['ecr', 'describe-repositories', '--region', region, '--repository-names', name])) return;
  info(color(C.yellow, `  建立保留的 ECR repository:${name}`));
  await run('aws', ['ecr', 'create-repository', '--region', region, '--repository-name', name, '--image-scanning-configuration', 'scanOnPush=true', '--image-tag-mutability', 'MUTABLE']);
  const policy = JSON.stringify({ rules: [{ rulePriority: 1, description: 'Keep last 10 images', selection: { tagStatus: 'any', countType: 'imageCountMoreThan', countNumber: 10 }, action: { type: 'expire' } }] });
  await run('aws', ['ecr', 'put-lifecycle-policy', '--region', region, '--repository-name', name, '--lifecycle-policy-text', policy]);
}
async function verifyStack(name, region) {
  const status = await capture('aws', ['cloudformation', 'describe-stacks', '--region', region, '--stack-name', name, '--query', 'Stacks[0].StackStatus', '--output', 'text']);
  if (!/^(CREATE|UPDATE)_COMPLETE$/.test(status)) fail(`Stack ${name} 狀態不是完成:${status}`);
  info(color(C.green, `  OK ${name} (${status})`));
}
function filesRecursive(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name); if (e.isDirectory()) out.push(...filesRecursive(p)); else out.push(p);
  }
  return out;
}

async function inner(o) {
  if (!o.sourceRoot || !o.sourceSha) fail('Internal 模式缺少 source root/SHA');
  o.sourceRoot = resolve(o.sourceRoot);
  const actual = await capture('git', ['-C', o.sourceRoot, 'rev-parse', 'HEAD']);
  if (actual !== o.sourceSha) fail(`來源 SHA 不一致:${actual} != ${o.sourceSha}`);

  const logDir = join(homedir(), '.playagent', 'logs'); mkdirSync(logDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  const logFile = join(logDir, `deploy-${stamp}-${o.sourceSha.slice(0, 12)}-${process.platform}.log`);
  logStream = createWriteStream(logFile, { flags: 'a' });
  try {
    step('檢查工具與 AWS 身分');
    await requireCommand('node', 'Node.js 22 LTS:https://nodejs.org/');
    await requireCommand('npm', 'Node.js 22 LTS:https://nodejs.org/');
    await requireCommand('aws', 'AWS CLI v2:https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html');
    await requireCommand('docker', 'Docker Desktop:https://www.docker.com/products/docker-desktop/');
    const nodeMajor = Number((await capture('node', ['--version'])).replace(/^v/, '').split('.')[0]);
    if (nodeMajor < 22) fail(`需要 Node.js 22+,目前是 v${nodeMajor}`);
    if (o.profile) process.env.AWS_PROFILE = o.profile;
    Object.assign(process.env, { AWS_REGION: o.region, AWS_DEFAULT_REGION: o.region, CDK_DEFAULT_REGION: o.region });
    const identity = JSON.parse(await capture('aws', ['sts', 'get-caller-identity', '--region', o.region, '--output', 'json']));
    const account = String(identity.Account);
    if (o.expectedAccountId && o.expectedAccountId !== account) fail(`AWS 帳號錯誤:預期 ${o.expectedAccountId},目前 ${account}`);
    if (!await succeeds('docker', ['info'])) fail('Docker Desktop 尚未啟動');
    info(`  Platform     : ${process.platform}/${process.arch}`);
    info(`  AWS account  : ${account}`); info(`  AWS identity : ${identity.Arn}`);
    info(`  Region       : ${o.region}`); info(`  Source SHA   : ${o.sourceSha}`);
    if (!o.nonInteractive && !/^y(es)?$/i.test(await question('確認部署到以上 AWS 帳號? [y/N] '))) fail('使用者取消部署');

    const prefix = o.stage === 'dev' ? 'PlayAgentDev' : `PlayAgent-${o.stage}`;
    const names = { foundation: `${prefix}-Foundation`, execution: `${prefix}-Execution`, scheduling: `${prefix}-Scheduling`, control: `${prefix}-ControlPlane`, frontend: `${prefix}-Frontend` };
    if (o.planOnly) {
      info(color(C.green, `PLAN OK:${process.platform} 將從乾淨 SHA ${o.sourceSha} 部署 ${Object.values(names).join(', ')}`));
      return;
    }
    const foundationExists = await succeeds('aws', ['cloudformation', 'describe-stacks', '--region', o.region, '--stack-name', names.foundation]);
    if (!foundationExists) warn('Foundation stack 不存在:將建立新資料桶與 Cognito User Pool;Retain 的舊資料不會自動接管。');

    step('以 lockfile 安裝相依套件');
    await run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: o.sourceRoot });
    if (!o.skipTests) {
      step('執行部署前檢查');
      await run('npm', ['run', 'test:web'], { cwd: o.sourceRoot });
      await run('npm', ['run', 'test:worker'], { cwd: o.sourceRoot });
      await run('npx', ['tsc', '--noEmit', '-p', '.'], { cwd: join(o.sourceRoot, 'infra') });
      await run('npx', ['vitest', 'run', 'test/runner-dockerfiles.test.ts', 'test/apk-merge.test.ts', 'test/secretsResolver.test.ts'], { cwd: join(o.sourceRoot, 'infra') });
    }
    if (!o.skipBootstrap) {
      step('CDK bootstrap（可重複執行）');
      await run('npx', ['cdk', 'bootstrap', `aws://${account}/${o.region}`], { cwd: join(o.sourceRoot, 'infra') });
    }

    step('建立 Foundation、Execution 與 ECR repositories');
    const executionExists = await succeeds('aws', ['cloudformation', 'describe-stacks', '--region', o.region, '--stack-name', names.execution]);
    const exploreExists = await succeeds('aws', ['ecr', 'describe-repositories', '--region', o.region, '--repository-names', 'playagent-exploration-runner']);
    const webExists = await succeeds('aws', ['ecr', 'describe-repositories', '--region', o.region, '--repository-names', 'playagent-web-runner']);
    let ownsRepos = false;
    if (executionExists) {
      const owned = await capture('aws', ['cloudformation', 'list-stack-resources', '--region', o.region, '--stack-name', names.execution, '--query', "StackResourceSummaries[?ResourceType=='AWS::ECR::Repository'].PhysicalResourceId", '--output', 'text']);
      ownsRepos = !!owned && owned !== 'None';
    }
    if (!ownsRepos && (executionExists || exploreExists || webExists)) {
      await ensureRepo('playagent-exploration-runner', o.region); await ensureRepo('playagent-web-runner', o.region);
      o.context = o.context.filter((x) => !/^existingRunnerRepos=/.test(x)); o.context.push('existingRunnerRepos=true');
      info(color(C.yellow, '  偵測到 Retain 的 ECR;Execution 將匯入既有 repositories。'));
    }
    await deployStacks(o, [names.foundation, names.execution], 'latest');
    await ensureRepo('playagent-exploration-runner', o.region); await ensureRepo('playagent-web-runner', o.region);

    step('由同一個 Git SHA 建置並推送 runner images');
    const registry = `${account}.dkr.ecr.${o.region}.amazonaws.com`;
    const password = await capture('aws', ['ecr', 'get-login-password', '--region', o.region]);
    await run('docker', ['login', '--username', 'AWS', '--password-stdin', registry], { input: `${password}\n` });
    const repos = [
      { name: 'playagent-exploration-runner', dockerfile: 'Dockerfile.exploration' },
      { name: 'playagent-web-runner', dockerfile: 'Dockerfile.web' },
    ];
    for (const r of repos) {
      const uri = `${registry}/${r.name}`;
      await run('docker', ['build', '--platform', 'linux/amd64', '--label', `org.opencontainers.image.revision=${o.sourceSha}`, '-f', r.dockerfile, '-t', `${uri}:${o.sourceSha}`, '.'], { cwd: join(o.sourceRoot, 'agent') });
      await run('docker', ['push', `${uri}:${o.sourceSha}`]);
    }
    for (const r of repos) {
      const uri = `${registry}/${r.name}`; await run('docker', ['tag', `${uri}:${o.sourceSha}`, `${uri}:latest`]); await run('docker', ['push', `${uri}:latest`]);
    }
    const digests = {};
    for (const r of repos) {
      const shaDigest = await imageDigest(r.name, o.sourceSha, o.region), latestDigest = await imageDigest(r.name, 'latest', o.region);
      if (shaDigest !== latestDigest) fail(`${r.name}:SHA tag 與 latest digest 不一致`);
      digests[r.name] = shaDigest; info(color(C.green, `  OK ${r.name}:${o.sourceSha.slice(0, 12)} = latest = ${shaDigest}`));
    }

    step('鎖定 ECS task definitions 到 Git SHA'); await deployStacks(o, [names.execution], o.sourceSha, 1);
    step('部署 Scheduling 與 ControlPlane'); await deployStacks(o, [names.scheduling, names.control], o.sourceSha);

    step('由 Stack outputs 產生前端設定並建置');
    const fo = await stackOutputs(names.foundation, o.region), co = await stackOutputs(names.control, o.region);
    const poolId = outputStarting(fo, 'AuthUserPoolId'), clientId = outputStarting(fo, 'AuthUserPoolClientId');
    const apiUrl = outputStarting(co, 'ApiUrl'), wsUrl = outputStarting(co, 'WsUrl');
    const missing = Object.entries({ poolId, clientId, apiUrl, wsUrl }).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) fail(`前端設定缺少:${missing.join(',')}`);
    writeFileSync(join(o.sourceRoot, 'web', '.env.production'), `VITE_COGNITO_REGION=${o.region}\nVITE_COGNITO_USER_POOL_ID=${poolId}\nVITE_COGNITO_CLIENT_ID=${clientId}\nVITE_API_URL=${apiUrl}\nVITE_WS_URL=${wsUrl}\n`);
    const dist = join(o.sourceRoot, 'web', 'dist'); rmSync(dist, { recursive: true, force: true });
    await run('npm', ['run', 'build:web'], { cwd: o.sourceRoot });
    if (!filesRecursive(join(dist, 'assets')).some((f) => readFileSync(f).includes(apiUrl))) fail('前端 bundle 沒有正確嵌入 API URL');
    step('部署前端'); await deployStacks(o, [names.frontend], o.sourceSha, 1);

    if (!o.adminEmail && !o.nonInteractive) o.adminEmail = await question('要建立/更新第一個管理員嗎? 輸入 email；略過請直接 Enter ');
    if (o.adminEmail) {
      if (!o.adminTenant) { if (o.nonInteractive) fail('指定 admin email 時也必須指定 tenant'); o.adminTenant = await question('管理員 tenant（例如 acme） '); }
      let adminPassword = process.env[o.adminPasswordEnv] ?? '';
      if (!adminPassword) { if (o.nonInteractive) fail(`請設定環境變數 ${o.adminPasswordEnv}`); adminPassword = await hiddenQuestion('管理員密碼（至少 8 字，大小寫與數字） '); }
      if (adminPassword.length < 8) fail('管理員密碼至少 8 字');
      step(`建立/更新管理員 ${o.adminEmail}`);
      const exists = await succeeds('aws', ['cognito-idp', 'admin-get-user', '--region', o.region, '--user-pool-id', poolId, '--username', o.adminEmail]);
      if (!exists) await run('aws', ['cognito-idp', 'admin-create-user', '--region', o.region, '--user-pool-id', poolId, '--username', o.adminEmail,
        '--user-attributes', `Name=email,Value=${o.adminEmail}`, 'Name=email_verified,Value=true', `Name=custom:tenantId,Value=${o.adminTenant}`, '--message-action', 'SUPPRESS']);
      await run('aws', ['cognito-idp', 'admin-set-user-password', '--region', o.region, '--user-pool-id', poolId, '--username', o.adminEmail, '--password', adminPassword, '--permanent']);
      await run('aws', ['cognito-idp', 'admin-add-user-to-group', '--region', o.region, '--user-pool-id', poolId, '--username', o.adminEmail, '--group-name', 'admins']);
      adminPassword = '';
    }

    step('部署後驗證');
    for (const s of Object.values(names)) await verifyStack(s, o.region);
    const resources = JSON.parse(await capture('aws', ['cloudformation', 'list-stack-resources', '--region', o.region, '--stack-name', names.execution, '--output', 'json']));
    const taskDefs = resources.StackResourceSummaries.filter((x) => x.ResourceType === 'AWS::ECS::TaskDefinition');
    if (taskDefs.length < 2) fail('Execution stack 找不到兩個 runner task definitions');
    for (const td of taskDefs) {
      const images = (await capture('aws', ['ecs', 'describe-task-definition', '--region', o.region, '--task-definition', String(td.PhysicalResourceId), '--query', 'taskDefinition.containerDefinitions[].image', '--output', 'text'])).split(/\s+/);
      for (const image of images.filter(Boolean)) { if (!image.endsWith(`:${o.sourceSha}`)) fail(`ECS 尚未鎖定 SHA:${image}`); info(color(C.green, `  OK ECS image ${image}`)); }
    }
    const siteUrl = outputContaining(await stackOutputs(names.frontend, o.region), 'SiteUrl');
    if (!siteUrl) fail('Frontend stack 沒有 SiteUrl output');
    let siteOk = false;
    for (let i = 0; i < 12; i++) {
      try { const r = await fetch(siteUrl); if (r.ok && /id=["']root["']/.test(await r.text())) { siteOk = true; break; } } catch { }
      await new Promise((r) => setTimeout(r, 10_000));
    }
    if (!siteOk) fail(`CloudFront 尚未回傳新版網站:${siteUrl}`);
    info(color(C.green, `  OK ${siteUrl}`));

    const manifest = { repository: o.repositoryUrl, branch: o.branch, sha: o.sourceSha, account, region: o.region, stage: o.stage,
      platform: `${process.platform}/${process.arch}`, explorationDigest: digests['playagent-exploration-runner'], webDigest: digests['playagent-web-runner'], siteUrl, deployedAt: new Date().toISOString() };
    await run('aws', ['ssm', 'put-parameter', '--region', o.region, '--name', `/playagent/${prefix}/deployed-version`, '--type', 'String', '--overwrite', '--value', JSON.stringify(manifest)]);
    const localDir = join(homedir(), '.playagent', 'deployments'); mkdirSync(localDir, { recursive: true }); writeFileSync(join(localDir, `${account}-${o.stage}.json`), JSON.stringify(manifest, null, 2));
    info(color(C.green, `\n========================================\n PlayAgent 最新版部署完成\n SHA : ${o.sourceSha}\n URL : ${siteUrl}\n Log : ${logFile}\n========================================`));
  } finally {
    await new Promise((r) => logStream.end(r)); logStream = null;
  }
}

const options = parseArgs(process.argv.slice(2));
try { if (options.internal) await inner(options); else await outer(options); }
catch (e) { console.error(color(C.red, `\n部署失敗:${e?.message ?? e}`)); process.exitCode = 1; }
