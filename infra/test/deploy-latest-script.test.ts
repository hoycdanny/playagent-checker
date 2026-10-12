import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');
const ps = readFileSync(join(root, 'scripts', 'deploy-latest.ps1'), 'utf8');
const cmd = readFileSync(join(root, 'Install-Latest.cmd'), 'utf8');

describe('one-click latest deployment contract', () => {
  test('double-click entry launches the PowerShell installer', () => {
    expect(cmd).toContain('scripts\\deploy-latest.ps1');
    expect(cmd).toContain('pause');
  });

  test('all installation guides point to the same one-click entry', () => {
    for (const file of ['README.md', 'README_ZH.md', 'README_CN.md', 'README_JP.md', 'README_KR.md', 'CONTRIBUTING.md']) {
      expect(readFileSync(join(root, file), 'utf8'), file).toContain('Install-Latest.cmd');
    }
  });

  test('deploys an isolated canonical-main SHA without touching local work', () => {
    expect(ps).toContain("RepositoryUrl = 'https://github.com/hoycdanny/playagent-checker.git'");
    expect(ps).toContain("Branch = 'main'");
    expect(ps).toContain("'worktree', 'add', '--detach'");
    expect(ps).toContain('worktree remove --force');
    expect(ps).toContain('Remove-TempWorktree');
    expect(ps).toContain('main 已更新'); // re-check after a long deployment
    expect(ps).not.toMatch(/git[^\n]*(?:reset|stash|clean)/i);
  });

  test('builds both immutable runner tags, updates latest, and pins ECS', () => {
    expect(ps).toContain("Name = 'playagent-exploration-runner'");
    expect(ps).toContain("Name = 'playagent-web-runner'");
    expect(ps).toContain('org.opencontainers.image.revision=$SourceSha');
    expect(ps).toContain('SHA tag 與 latest digest 不一致');
    expect(ps).toContain('runnerImageTag=$ImageTag');
    expect(ps).toContain('ECS task definition 仍未鎖定 SHA');
  });

  test('fails closed and verifies every deploy surface', () => {
    expect(ps).toContain("Run 'npm' @('ci'");
    expect(ps).toContain('test/runner-dockerfiles.test.ts');
    expect(ps).toContain('test/apk-merge.test.ts');
    expect(ps).toContain('前端 bundle 沒有正確嵌入 API URL');
    expect(ps).toContain("Output-Containing $frontOut 'SiteUrl'");
    expect(ps).toContain('CloudFront 尚未回傳新版網站');
    expect(ps).toContain("'ssm', 'put-parameter'");
  });
});
