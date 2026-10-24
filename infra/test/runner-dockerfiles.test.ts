import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * runner 容器映像只 COPY Dockerfile 列出的 .mjs;漏列一個被 import 的模組,容器一啟動就
 * ERR_MODULE_NOT_FOUND 崩潰(2026-10-10:explorationRunner 新增 windowsClient.mjs import,
 * Dockerfile 沒跟上 → Device Farm 任務全部卡在「開真機中」)。
 */
const AGENT = join(__dirname, '..', '..', 'agent');

function localImports(file: string, seen = new Set<string>()): Set<string> {
  if (seen.has(file)) return seen;
  seen.add(file);
  const src = readFileSync(join(AGENT, file), 'utf8');
  for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*)'\.\/([^']+\.mjs)'/g)) localImports(m[1]!, seen);
  return seen;
}

function copiedModules(dockerfile: string): Set<string> {
  const text = readFileSync(join(AGENT, dockerfile), 'utf8');
  return new Set(
    text.split('\n').filter((l) => l.startsWith('COPY ')).flatMap((l) => l.split(/\s+/)).filter((w) => w.endsWith('.mjs')),
  );
}

describe('runner Dockerfiles copy every imported module', () => {
  test.each([
    ['Dockerfile.exploration', 'explorationRunner.mjs'],
    ['Dockerfile.web', 'webExplorationRunner.mjs'],
    ['Dockerfile.keepalive', 'keepAliveRunner.mjs'],
  ])('%s covers %s', (dockerfile, entry) => {
    const copied = copiedModules(dockerfile);
    const missing = [...localImports(entry)].filter((f) => !copied.has(f));
    expect(missing).toEqual([]);
  });
});
