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
