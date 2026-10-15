/**
 * Source version detection for the one-click installer.
 * Git is optional: a git checkout yields its commit SHA, an extracted ZIP (no .git or no git
 * binary) yields `local-<UTC yyyymmddHHMMSS>`. Every result is a valid Docker tag.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

export const DOCKER_TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const COMMIT_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** UTC `yyyymmddHHMMSS` (14 digits). */
export function utcStamp(date) {
  return date.toISOString().replace(/[-:T]/g, '').replace(/\..+$/, '');
}

/** Shell-free git runner bound to `root`; a missing git binary becomes `ok: false`, never a throw. */
export function defaultGit(root) {
  return (args) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false, windowsHide: true });
    return { ok: !r.error && r.status === 0, stdout: String(r.stdout ?? '').trim() };
  };
}

function canonical(p) {
  let out = resolve(p);
  try { out = realpathSync.native(out); } catch { /* keep resolved path */ }
  return process.platform === 'win32' ? out.toLowerCase() : out;
}

/**
 * @returns {{ version: string, source: 'git' | 'zip', commit: string | null, dirty: boolean }}
 */
export function detectSourceVersion(root, { git = defaultGit(root), now = new Date() } = {}) {
  const stamp = utcStamp(now);
  let result = { version: `local-${stamp}`, source: 'zip', commit: null, dirty: false };
  const top = git(['rev-parse', '--show-toplevel']);
  // A ZIP extracted inside some unrelated repo must not borrow that repo's SHA.
  if (top.ok && top.stdout && canonical(top.stdout) === canonical(root)) {
    const head = git(['rev-parse', 'HEAD']);
    if (head.ok && COMMIT_RE.test(head.stdout)) {
      const status = git(['status', '--porcelain', '--untracked-files=normal']);
      const dirty = !status.ok || status.stdout.length > 0;
      result = {
        version: dirty ? `${head.stdout.slice(0, 12)}-dirty-${stamp}` : head.stdout,
        source: 'git',
        commit: head.stdout,
        dirty,
      };
    }
  }
  if (!DOCKER_TAG_RE.test(result.version) || result.version === 'latest') {
    throw new Error(`版本 tag 不符合 Docker 規則:${result.version}`);
  }
  return result;
}
