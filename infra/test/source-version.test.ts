import { describe, expect, test } from 'vitest';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOCKER_TAG_RE, detectSourceVersion, utcStamp } from '../../scripts/source-version.mjs';
import type { GitRunner } from '../../scripts/source-version.mjs';

const root = join(__dirname, '..', '..');
const now = new Date(Date.UTC(2025, 0, 2, 3, 4, 5));
const SHA = '0123456789abcdef0123456789abcdef01234567';

/** Fake git: maps the first two args to a canned response; anything else fails. */
function fakeGit(responses: Record<string, { ok: boolean; stdout: string }>): GitRunner {
  return (args) => responses[args.slice(0, 2).join(' ')] ?? { ok: false, stdout: '' };
}
const cleanRepo = {
  'rev-parse --show-toplevel': { ok: true, stdout: root },
  'rev-parse HEAD': { ok: true, stdout: SHA },
  'status --porcelain': { ok: true, stdout: '' },
};

describe('installer source version detection (git optional)', () => {
  test('utcStamp is UTC yyyymmddHHMMSS', () => {
    expect(utcStamp(now)).toBe('20250102030405');
  });

  test('clean git checkout uses the full commit SHA', () => {
    expect(detectSourceVersion(root, { git: fakeGit(cleanRepo), now }))
      .toEqual({ version: SHA, source: 'git', commit: SHA, dirty: false });
  });

  test('dirty git checkout gets a unique -dirty tag but keeps the real commit', () => {
    const git = fakeGit({ ...cleanRepo, 'status --porcelain': { ok: true, stdout: ' M scripts/deploy-latest.mjs' } });
    expect(detectSourceVersion(root, { git, now }))
      .toEqual({ version: `${SHA.slice(0, 12)}-dirty-20250102030405`, source: 'git', commit: SHA, dirty: true });
  });

  test('missing git or not a repository falls back to a local ZIP tag', () => {
    expect(detectSourceVersion(root, { git: () => ({ ok: false, stdout: '' }), now }))
      .toEqual({ version: 'local-20250102030405', source: 'zip', commit: null, dirty: false });
  });

  test('a folder nested inside an unrelated repository is treated as ZIP', () => {
    const git = fakeGit({ ...cleanRepo, 'rev-parse --show-toplevel': { ok: true, stdout: join(root, '..') } });
    expect(detectSourceVersion(root, { git, now }).source).toBe('zip');
  });

  test('a repository without commits is treated as ZIP', () => {
    const git = fakeGit({ ...cleanRepo, 'rev-parse HEAD': { ok: true, stdout: 'HEAD' } });
    expect(detectSourceVersion(root, { git, now })).toMatchObject({ source: 'zip', commit: null });
  });

  test('every variant is a valid Docker tag and never "latest"', () => {
    const variants = [
      detectSourceVersion(root, { git: fakeGit(cleanRepo), now }),
      detectSourceVersion(root, { git: fakeGit({ ...cleanRepo, 'status --porcelain': { ok: true, stdout: '?? x' } }), now }),
      detectSourceVersion(root, { git: () => ({ ok: false, stdout: '' }), now }),
    ];
    for (const v of variants) {
      expect(v.version).toMatch(DOCKER_TAG_RE);
      expect(v.version).not.toBe('latest');
      expect(v.version).not.toContain(':');
    }
  });

  test('real ZIP simulation: scripts copied outside git use the default runner without error', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'pa-zip-'));
    try {
      cpSync(join(root, 'scripts'), join(tempRoot, 'scripts'), { recursive: true });
      expect(detectSourceVersion(tempRoot, { now }))
        .toEqual({ version: 'local-20250102030405', source: 'zip', commit: null, dirty: false });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
