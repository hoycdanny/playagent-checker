import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');
const core = readFileSync(join(root, 'scripts', 'deploy-latest.mjs'), 'utf8');
const secretInput = readFileSync(join(root, 'scripts', 'secret-input.mjs'), 'utf8');
const createUser = readFileSync(join(root, 'agent', 'sagemaker', 'createUser.mjs'), 'utf8');
const ps = readFileSync(join(root, 'scripts', 'deploy-latest.ps1'), 'utf8');
const sh = readFileSync(join(root, 'scripts', 'deploy-latest.sh'), 'utf8');
const cmd = readFileSync(join(root, 'Install-Latest.cmd'), 'utf8');
const mac = readFileSync(join(root, 'Install-Latest.command'), 'utf8');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

describe('cross-platform one-click latest deployment contract', () => {
  test('Windows, macOS, shell, PowerShell, and npm all call the same Node core', () => {
    expect(cmd).toContain('scripts\\deploy-latest.mjs');
    expect(cmd).toContain('%*');
    expect(cmd).toContain('pause');
    expect(mac).toMatch(/^#!\/usr\/bin\/env bash/);
    expect(mac).toContain('scripts/deploy-latest.mjs');
    expect(sh).toMatch(/^#!\/usr\/bin\/env bash/);
    expect(sh).toContain('scripts/deploy-latest.mjs');
    expect(ps).toContain("'deploy-latest.mjs'");
    expect(core).toContain("file === 'npm' ? 'npm-cli.js' : 'npx-cli.js'");
    expect(core).toContain('shell: false');
    expect(pkg.scripts['deploy:latest']).toBe('node scripts/deploy-latest.mjs');
  });

  test('all installation guides show both Windows and macOS launchers', () => {
    for (const file of ['README.md', 'README_ZH.md', 'README_CN.md', 'README_JP.md', 'README_KR.md', 'CONTRIBUTING.md']) {
      const text = readFileSync(join(root, file), 'utf8');
      expect(text, file).toContain('Install-Latest.cmd');
      expect(text, file).toContain('Install-Latest.command');
      expect(text, file).toContain('us-east-2');
      expect(text, file).toContain('--admin-password-stdin');
      expect(text, file).not.toContain('adminPassword=');
      expect(text, file).not.toMatch(/--password\s+['"]/);
    }
  });

  test('all install guides explain retained resources before a reset', () => {
    for (const file of ['README.md', 'README_ZH.md', 'README_CN.md', 'README_JP.md', 'README_KR.md']) {
      const text = readFileSync(join(root, file), 'utf8');
      expect(text, file).toContain('cdk destroy');
      expect(text, file).toContain('Retain');
    }
  });

  test('deploys an isolated canonical-main SHA without touching local work', () => {
    expect(core).toContain("const DEFAULT_REPO = 'https://github.com/hoycdanny/playagent-checker.git'");
    expect(core).toContain("branch: 'main'");
    expect(core).toContain("'worktree', 'add', '--detach'");
    expect(core).toContain("'worktree', 'remove', '--force'");
    expect(core).toContain('main 已更新');
    expect(core).not.toMatch(/git[^\n]*(?:reset|stash|clean)/i);
  });

  test('builds both immutable runner tags, updates latest, and pins ECS', () => {
    expect(core).toContain("name: 'playagent-exploration-runner'");
    expect(core).toContain("name: 'playagent-web-runner'");
    expect(core).toContain('org.opencontainers.image.revision=${o.sourceSha}');
    expect(core).toContain('SHA tag 與 latest digest 不一致');
    expect(core).toContain('runnerImageTag=${imageTag}');
    expect(core).toContain('ECS 尚未鎖定 SHA');
    expect(core).toContain('existingRunnerRepos=true');
    expect(core).toContain('ensureRepo');
  });

  test('defaults to us-east-2 and provisions the required admin without secret argv', () => {
    expect(core).toContain("region: 'us-east-2'");
    expect(core).toContain("adminTenant: 'default'");
    expect(ps).toContain("[string]$Region = 'us-east-2'");
    expect(core).toContain("'--password-stdin'");
    expect(core).toContain('input: adminPassword');
    expect(core).not.toContain('adminPasswordEnv');
    expect(core).toContain("else if (a === '--admin-password-env')");
    expect(core).not.toMatch(/'--password',\s*adminPassword/);
    expect(createUser).toContain('AdminGetUserCommand');
    expect(createUser).toContain('AdminCreateUserCommand');
    expect(createUser).toContain('AdminSetUserPasswordCommand');
    expect(createUser).toContain('AdminAddUserToGroupCommand');
    expect(createUser).toContain("startsWith('--password=')");
    expect(secretInput).toContain('setRawMode(true)');
    expect(secretInput).toContain('readSecretFromStdin');
  });

  test('fails closed and verifies every deploy surface', () => {
    expect(core).toContain("await run('npm', ['ci'");
    expect(core).toContain('test/runner-dockerfiles.test.ts');
    expect(core).toContain('test/apk-merge.test.ts');
    expect(core).toContain('前端 bundle 沒有正確嵌入 API URL');
    expect(core).toContain("outputContaining(await stackOutputs(names.frontend, o.region), 'SiteUrl')");
    expect(core).toContain('CloudFront 尚未回傳新版網站');
    expect(core).toContain("'ssm', 'put-parameter'");
  });
});

describe('least-privilege deployer (no AdministratorAccess)', () => {
  const policyText = readFileSync(join(root, 'infra', 'iam', 'playagent-deployer-policy.json'), 'utf8');
  const policy = JSON.parse(policyText) as { Statement: { Action: string | string[]; Resource: string | string[]; Condition?: Record<string, Record<string, string | string[]>> }[] };
  const setup = readFileSync(join(root, 'scripts', 'setup-deployer-role.sh'), 'utf8');
  const list = (v: string | string[]) => (Array.isArray(v) ? v : [v]);
  const allowed = new Set(policy.Statement.flatMap((s) => list(s.Action)));
  const pascal = (op: string) => op.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join('');

  test('every AWS CLI/SDK call the installer makes is granted, and nothing broader', () => {
    const calls = [...core.matchAll(/'aws', \['([a-z0-9-]+)', '([a-z0-9-]+)'/g)].map(([, svc, op]) => [svc, op]);
    expect(calls.length).toBeGreaterThan(5);
    for (const [svc, op] of calls) {
      if (svc === 'sts' && op === 'get-caller-identity') continue; // needs no permission
      const action = svc === 'ecr' && op === 'get-login-password' ? 'ecr:GetAuthorizationToken' : `${svc}:${pascal(op)}`;
      expect(allowed.has(action), action).toBe(true);
    }
    for (const cmd of createUser.matchAll(/new (Admin\w+)Command\(/g)) {
      expect(allowed.has(`cognito-idp:${cmd[1]}`), cmd[1]).toBe(true);
    }
    for (const a of allowed) expect(a, a).not.toMatch(/\*|^iam:|^s3:|^cloudformation:(Create|Update|Delete|Execute)/);
  });

  test('wildcard resources only where AWS has no resource-level support', () => {
    for (const s of policy.Statement) {
      if (list(s.Resource).includes('*')) {
        for (const a of list(s.Action)) expect(['ecr:GetAuthorizationToken', 'ecs:DescribeTaskDefinition']).toContain(a);
      }
    }
    const assume = policy.Statement.find((s) => list(s.Action).includes('sts:AssumeRole'))!;
    expect(list(assume.Resource)).toEqual(['arn:aws:iam::<ACCOUNT_ID>:role/cdk-hnb659fds-*-<ACCOUNT_ID>-us-east-2']);
    expect(assume.Condition?.StringEquals?.['iam:ResourceTag/aws-cdk:bootstrap-role']).toEqual(['deploy', 'file-publishing', 'lookup']);
    const cognito = policy.Statement.find((s) => list(s.Action).some((a) => a.startsWith('cognito-idp:')))!;
    expect(cognito.Condition?.StringLike?.['aws:ResourceTag/aws:cloudformation:stack-name']).toBeDefined();
    expect(policyText).not.toMatch(/\d{12}/);
  });

  test('installer skips bootstrap when CDKToolkit exists so the deployer never needs admin', () => {
    expect(core).toContain("'--stack-name', 'CDKToolkit'");
    expect(core).toContain('TOOLKIT_READY.test(toolkit) && !o.forceBootstrap');
    expect(core).toContain("a === '--force-bootstrap'");
    expect(core).toContain('scripts/setup-deployer-role.sh');
  });

  test('one-time admin setup script creates only the scoped role', () => {
    expect(setup).toMatch(/^#!\/usr\/bin\/env bash/);
    expect(setup).toContain('set -euo pipefail');
    expect(setup).toContain('infra/iam/playagent-deployer-policy.json');
    expect(setup).toContain('s/<ACCOUNT_ID>/$ACCOUNT/g');
    expect(setup).toContain('"Service":"ec2.amazonaws.com"');
    expect(setup).toContain('policy/AmazonSSMManagedInstanceCore');
    expect(setup).not.toContain('AdministratorAccess');
    for (const file of ['README.md', 'README_ZH.md', 'README_CN.md', 'README_JP.md', 'README_KR.md']) {
      const text = readFileSync(join(root, file), 'utf8');
      expect(text, file).toContain('scripts/setup-deployer-role.sh');
      expect(text, file).toContain('infra/iam/playagent-deployer-policy.json');
      expect(text, file).toContain('cdk-hnb659fds-cfn-exec-role');
      expect(text, file).not.toContain('**AdministratorAccess**');
    }
  });
});
