/**
 * 跨平台打包 CodeBuild source zip(Windows 用 PowerShell Compress-Archive,其餘用 zip)。
 * 先把要打包的檔複製到暫存資料夾(buildspec 改名為 buildspec.yml 放在根),再壓縮。
 * 回傳 zip 的本機路徑。
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function packSource({ agentDir, buildspecPath, extraFiles, zipName }) {
  const stage = mkdtempSync(join(tmpdir(), 'pa-src-'));
  const files = [
    ...readdirSync(agentDir).filter((f) => f.endsWith('.mjs') && !f.startsWith('_')),
    ...extraFiles,
  ];
  for (const f of files) cpSync(join(agentDir, f), join(stage, f));
  cpSync(buildspecPath, join(stage, 'buildspec.yml'));
  const zip = join(tmpdir(), zipName);
  rmSync(zip, { force: true });
  if (process.platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${stage}\\*' -DestinationPath '${zip}' -Force`], { stdio: 'inherit' });
  } else {
    execFileSync('bash', ['-c', `cd "${stage}" && zip -q "${zip}" *`], { stdio: 'inherit' });
  }
  rmSync(stage, { recursive: true, force: true });
  return zip;
}
