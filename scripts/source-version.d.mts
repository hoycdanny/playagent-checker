/** 型別宣告:scripts/source-version.mjs(installer 版本偵測,infra 測試會引用)。 */
export interface SourceVersion {
  /** Docker tag:clean git = 40-hex commit;dirty = `<sha12>-dirty-<stamp>`;ZIP = `local-<stamp>`。 */
  version: string;
  source: 'git' | 'zip';
  commit: string | null;
  dirty: boolean;
}
export type GitRunner = (args: string[]) => { ok: boolean; stdout: string };
export const DOCKER_TAG_RE: RegExp;
export function utcStamp(date: Date): string;
export function defaultGit(root: string): GitRunner;
export function detectSourceVersion(root: string, opts?: { git?: GitRunner; now?: Date }): SourceVersion;
