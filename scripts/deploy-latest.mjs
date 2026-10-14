#!/usr/bin/env node
/**
 * PlayAgent Checker cross-platform one-click installer/updater.
 * Node.js 22+; tested on Windows 10/PowerShell 5.1 + Docker Desktop.
 * macOS/Linux use the exact same Node code (only the launcher differs).
 */
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { promptHidden, readSecretFromStdin, validateCognitoPassword } from './secret-input.mjs';

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
  --region REGION            AWS region (us-west-2)
  --stage STAGE              CDK stage (dev)
  --profile PROFILE          AWS CLI profile
  --expected-account-id ID   fail if the active AWS account differs
  --context key=value        extra CDK context (repeatable)
  --admin-email EMAIL        Cognito admin login email (required for install)
  --admin-tenant TENANT      admin tenant (default: default)
  --admin-password-stdin     read the admin password from stdin (automation only)
  --admin-invite             no password: Cognito emails a temporary password; set your own at first login
  --skip-tests               skip repeated tests
  --skip-bootstrap           skip CDK bootstrap
  --force-bootstrap          re-run CDK bootstrap even if CDKToolkit exists (admin upgrade)
  --plan-only                latest-source + preflight check, no changes
  --non-interactive          do not prompt
  -h, --help                 show this help
`);
}

function parseArgs(argv) {
  const o = {
    repositoryUrl: DEFAULT_REPO, branch: 'main', region: 'us-west-2', stage: 'dev', profile: '',
    expectedAccountId: '', context: [], adminEmail: '', adminTenant: 'default', adminPasswordStdin: false, adminInvite: false,
    skipTests: false, skipBootstrap: false, forceBootstrap: false, planOnly: false, nonInteractive: false,
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
    else if (a === '--admin-password-stdin') o.adminPasswordStdin = true;
    else if (a === '--admin-invite') o.adminInvite = true;
    // Accepted only so an older interactive outer launcher can hand off to this newer core.
    // The environment variable name is deliberately ignored; secrets are never read from env.
    else if (a === '--admin-password-env') { value(i++, a); }
    else if (a === '--skip-tests') o.skipTests = true;
    else if (a === '--skip-bootstrap') o.skipBootstrap = true;
    else if (a === '--force-bootstrap') o.forceBootstrap = true;
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
function validateAdminIdentity(o) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(o.adminEmail)) fail('請提供有效的 Cognito 管理員 Email（登入 username）');
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(o.adminTenant)) fail('admin tenant 只能使用 1–128 個英數字、點、底線或連字號');
}

async function promptConfirmedAdminPassword() {
  while (true) {
    const password = await promptHidden('管理員密碼（8–256 字元，含英文大小寫與數字）: ');
    try {
      validateCognitoPassword(password);
      const confirmation = await promptHidden('再次輸入密碼: ');
      try {
        if (password.length === confirmation.length && timingSafeEqual(password, confirmation)) return password;
        warn('兩次密碼不同，請重新輸入。');
      } finally {
        confirmation.fill(0);
      }
    } catch (error) {
      if (error.message === '使用者取消') {
        password.fill(0);
        throw error;
      }
      warn(error.message);
    }
    password.fill(0);
  }
}

async function collectAdminPassword(o) {
  if (o.planOnly || !o.nonInteractive) return null;
  if (!o.adminEmail) fail('非互動安裝必須指定 --admin-email');
  // 邀請模式(CloudShell / CodeBuild):沒有密碼,Cognito 寄臨時密碼到管理員信箱。
  if (o.adminInvite) { validateAdminIdentity(o); return null; }
  if (!o.adminPasswordStdin) fail('非互動安裝必須使用 --admin-password-stdin 安全傳入密碼,或用 --admin-invite 改寄邀請信');
  validateAdminIdentity(o);
  const password = await readSecretFromStdin();
  validateCognitoPassword(password);
  return password;
}

function childArgs(o, root, sha) {
  const a = ['--internal', '--source-root', root, '--source-sha', sha,
    '--repository-url', o.repositoryUrl, '--branch', o.branch, '--region', o.region, '--stage', o.stage];
  if (o.profile) a.push('--profile', o.profile);
  if (o.expectedAccountId) a.push('--expected-account-id', o.expectedAccountId);
  for (const c of o.context) a.push('--context', c);
  if (!o.planOnly) {
    if (o.adminEmail) a.push('--admin-email', o.adminEmail);
    a.push('--admin-tenant', o.adminTenant);
    if (o.adminInvite) a.push('--admin-invite');
    else if (o.nonInteractive) a.push('--admin-password-stdin');
  }
  if (o.skipTests) a.push('--skip-tests');
  if (o.skipBootstrap) a.push('--skip-bootstrap');
  if (o.forceBootstrap) a.push('--force-bootstrap');
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
  const adminPassword = await collectAdminPassword(o);
  try {
    await requireCommand('git', 'https://git-scm.com/downloads');
    const isRepo = await succeeds('git', ['-C', CALLER_ROOT, 'rev-parse', '--is-inside-work-tree']);
    for (let round = 1; round <= 3; round++) {
      if (process.env.PA_PROGRESS) console.log(`PA_PREPARE|${round}`);
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
        await run(process.execPath, [join(work, 'scripts', 'deploy-latest.mjs'), ...childArgs(o, work, sha)],
          adminPassword ? { input: adminPassword } : {});
      } finally {
        await removeSource(CALLER_ROOT, work, isWorktree);
      }
      const latest = (await capture('git', ['ls-remote', o.repositoryUrl, `refs/heads/${o.branch}`])).split(/\s+/)[0];
      if (latest === sha) { info(color(C.green, `\n最新版部署完成:${sha}`)); return; }
      warn(`部署期間 main 已更新:${sha} -> ${latest};自動重跑最新版。`);
    }
    fail('main 在三輪部署期間持續更新,請稍後再執行一次。');
  } finally {
    adminPassword?.fill(0);
  }
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
/** CDKToolkit status, or 'MISSING'. A least-privilege deployer can read it but cannot create/update it. */
async function toolkitStatus(region) {
  const r = await run('aws', ['cloudformation', 'describe-stacks', '--region', region, '--stack-name', 'CDKToolkit', '--query', 'Stacks[0].StackStatus', '--output', 'text'], { capture: true, allowFailure: true });
  if (r.code === 0 && r.stdout) return r.stdout;
  if (/does not exist/i.test(r.stderr)) return 'MISSING';
  return `UNKNOWN (${r.stderr.split('\n').pop() || `exit=${r.code}`})`;
}
const TOOLKIT_READY = /^(CREATE|UPDATE|UPDATE_ROLLBACK)_COMPLETE$/;
const bootstrapHint = (account, region) =>
  `請 AWS 管理員在 CloudShell 執行一次:bash scripts/setup-deployer-role.sh(或 npx -y aws-cdk@2 bootstrap aws://${account}/${region}),之後最小權限的部署身分就能安裝。`;
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

  let adminPassword = null;
  if (!o.planOnly && o.nonInteractive && o.adminInvite) {
    validateAdminIdentity(o);
  } else if (!o.planOnly && o.nonInteractive) {
    if (!o.adminPasswordStdin) fail('Internal 安裝缺少安全密碼 stdin');
    validateAdminIdentity(o);
    adminPassword = await readSecretFromStdin();
    validateCognitoPassword(adminPassword);
  }

  const logDir = join(homedir(), '.playagent', 'logs'); mkdirSync(logDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  const logFile = join(logDir, `deploy-${stamp}-${o.sourceSha.slice(0, 12)}-${process.platform}.log`);
  logStream = createWriteStream(logFile, { flags: 'a' });
  // 進度標記:只在 PA_PROGRESS=1(CloudShell/CodeBuild)時輸出,讓 CloudShell 顯示 [i/N] 進度;
  // 本機安裝器不設這個環境變數,看到的是原本的詳細輸出,不會被標記污染。
  const PA_EMIT = !!process.env.PA_PROGRESS;
  const stepsTotal = o.skipTests ? 12 : 13;
  let stepNo = 0;
  const pstep = (key, label) => {
    stepNo += 1;
    if (PA_EMIT) { const m = `PA_STEP|${key}|${stepNo}|${stepsTotal}`; console.log(m); logStream?.write(`${m}\n`); }
    step(label);
  };
  try {
    pstep('tools', '檢查工具與 AWS 身分');
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
      const toolkit = await toolkitStatus(o.region);
      if (TOOLKIT_READY.test(toolkit)) info(color(C.green, `  CDK bootstrap: ${toolkit}`));
      else warn(`CDK bootstrap: ${toolkit}。${bootstrapHint(account, o.region)}`);
      info(color(C.green, `PLAN OK:${process.platform} 將從乾淨 SHA ${o.sourceSha} 部署 ${Object.values(names).join(', ')}`));
      return;
    }
    if (!o.nonInteractive) {
      if (!process.stdin.isTTY) fail('互動安裝需要終端機；自動化請使用 --non-interactive --admin-email ... --admin-password-stdin');
      if (!o.adminEmail) o.adminEmail = await question('Cognito 管理員登入 Email（username）: ');
      validateAdminIdentity(o);
      adminPassword = await promptConfirmedAdminPassword();
    }
    const foundationExists = await succeeds('aws', ['cloudformation', 'describe-stacks', '--region', o.region, '--stack-name', names.foundation]);
    if (!foundationExists) warn('Foundation stack 不存在:將建立新資料桶與 Cognito User Pool;Retain 的舊資料不會自動接管。');

    pstep('deps', '以 lockfile 安裝相依套件');
    await run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: o.sourceRoot });
    if (!o.skipTests) {
      pstep('tests', '執行部署前檢查');
      await run('npm', ['run', 'test:web'], { cwd: o.sourceRoot });
      await run('npm', ['run', 'test:worker'], { cwd: o.sourceRoot });
      await run('npx', ['tsc', '--noEmit', '-p', '.'], { cwd: join(o.sourceRoot, 'infra') });
      await run('npx', ['vitest', 'run', 'test/deploy-latest-script.test.ts', 'test/foundation-stack.test.ts', 'test/runner-dockerfiles.test.ts', 'test/apk-merge.test.ts', 'test/secretsResolver.test.ts'], { cwd: join(o.sourceRoot, 'infra') });
    }
    if (!o.skipBootstrap) {
      // Bootstrap runs with the caller's own credentials and needs IAM/CloudFormation admin rights.
      // When CDKToolkit already exists, skip it so a least-privilege deployer only assumes cdk-* roles;
      // cdk deploy still enforces the minimum bootstrap version itself.
      const toolkit = await toolkitStatus(o.region);
      if (TOOLKIT_READY.test(toolkit) && !o.forceBootstrap) {
        pstep('bootstrap', `CDK bootstrap 已存在(${toolkit}),略過`);
      } else {
        pstep('bootstrap', 'CDK bootstrap');
        try {
          await run('npx', ['cdk', 'bootstrap', `aws://${account}/${o.region}`], { cwd: join(o.sourceRoot, 'infra') });
        } catch (e) {
          fail(`CDK bootstrap 失敗(CDKToolkit: ${toolkit})。${bootstrapHint(account, o.region)}\n${e.message}`);
        }
      }
    }

    pstep('foundation', '建立 Foundation、Execution 與 ECR repositories');
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

    const fo = await stackOutputs(names.foundation, o.region);
    const poolId = outputStarting(fo, 'AuthUserPoolId');
    if (!poolId) fail('Foundation stack 找不到 Cognito User Pool ID');
    pstep('admin', '建立／更新 Cognito 管理員');
    try {
      const userArgs = [
        join(o.sourceRoot, 'agent', 'sagemaker', 'createUser.mjs'),
        '--email', o.adminEmail,
        '--tenant', o.adminTenant,
        '--pool-id', poolId,
        '--admin',
      ];
      // 邀請模式:Cognito 寄含臨時密碼的信,並把同一組臨時密碼寫進短效 SSM 參數,
      // 讓安裝器在結束時顯示在畫面上(讀取後立刻刪除)。第一次登入時使用者自設新密碼。
      if (o.adminInvite && !adminPassword) await run(process.execPath, [...userArgs, '--invite', '--temp-pw-param', `/playagent/${prefix}/admin-temp-password`], { cwd: o.sourceRoot });
      else await run(process.execPath, [...userArgs, '--password-stdin'], { cwd: o.sourceRoot, input: adminPassword });
    } finally {
      adminPassword?.fill(0);
      adminPassword = null;
    }

    pstep('images', '由同一個 Git SHA 建置並推送 runner images');
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

    pstep('pin_ecs', '鎖定 ECS task definitions 到 Git SHA'); await deployStacks(o, [names.execution], o.sourceSha, 1);
    pstep('scheduling', '部署 Scheduling 與 ControlPlane'); await deployStacks(o, [names.scheduling, names.control], o.sourceSha);

    pstep('frontend_build', '由 Stack outputs 產生前端設定並建置');
    const co = await stackOutputs(names.control, o.region);
    const clientId = outputStarting(fo, 'AuthUserPoolClientId');
    const apiUrl = outputStarting(co, 'ApiUrl'), wsUrl = outputStarting(co, 'WsUrl');
    const missing = Object.entries({ poolId, clientId, apiUrl, wsUrl }).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) fail(`前端設定缺少:${missing.join(',')}`);
    writeFileSync(join(o.sourceRoot, 'web', '.env.production'), `VITE_COGNITO_REGION=${o.region}\nVITE_COGNITO_USER_POOL_ID=${poolId}\nVITE_COGNITO_CLIENT_ID=${clientId}\nVITE_API_URL=${apiUrl}\nVITE_WS_URL=${wsUrl}\n`);
    const dist = join(o.sourceRoot, 'web', 'dist'); rmSync(dist, { recursive: true, force: true });
    await run('npm', ['run', 'build:web'], { cwd: o.sourceRoot });
    if (!filesRecursive(join(dist, 'assets')).some((f) => readFileSync(f).includes(apiUrl))) fail('前端 bundle 沒有正確嵌入 API URL');
    pstep('frontend', '部署前端'); await deployStacks(o, [names.frontend], o.sourceSha, 1);

    // 系統更新器(Updater):建立「系統管理頁 → 一鍵更新」用的 CodeBuild 專案。
    // 它刻意不在核心清單裡(一鍵更新時不自我修改),但乾淨安裝必須一併建立,
    // 否則新環境的一鍵更新沒有後端專案可用。倉庫已公開,Updater 不需要 GitHub token。
    pstep('updater', '部署系統更新器(Updater)'); await deployStacks(o, [`${prefix}-Updater`], o.sourceSha);

    pstep('verify', '部署後驗證');
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
    adminPassword?.fill(0);
    await new Promise((r) => logStream.end(r)); logStream = null;
  }
}

const options = parseArgs(process.argv.slice(2));
try { if (options.internal) await inner(options); else await outer(options); }
catch (e) { console.error(color(C.red, `\n部署失敗:${e?.message ?? e}`)); process.exitCode = 1; }
