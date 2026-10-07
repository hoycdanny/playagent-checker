import { execFile, spawn, type ChildProcess } from 'node:child_process';

/**
 * 安全執行外部指令:
 *  - 一律 execFile(檔名 + 參數陣列),不經 shell,不拼接字串 → 沒有 command injection。
 *  - 每個指令都必須給 timeout;逾時殺掉並回 timedOut。
 *  - 支援 AbortSignal(取消測試時中止進行中的指令)。
 */
export interface CommandResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
}

export interface CommandOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  maxBuffer?: number;
  env?: Record<string, string>;
  cwd?: string;
}

export type CommandRunner = (file: string, args: readonly string[], opts: CommandOptions) => Promise<CommandResult>;

export class CommandArgError extends Error {
  override name = 'CommandArgError';
}

/** 參數檢查:禁止 NUL 與換行(防止注入到 `adb shell` 這類會再交給裝置端 shell 的指令)。 */
export function assertSafeArgs(args: readonly string[]): void {
  for (const a of args) {
    if (typeof a !== 'string' || /[\0\r\n]/.test(a)) throw new CommandArgError(`不安全的指令參數:${JSON.stringify(a)}`);
  }
}

export const runCommand: CommandRunner = (file, args, opts) => {
  assertSafeArgs([file, ...args]);
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) throw new CommandArgError('timeoutMs 必須 > 0');
  return new Promise((resolve) => {
    const child = execFile(
      file,
      [...args],
      {
        timeout: opts.timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
        encoding: 'buffer',
        windowsHide: true,
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
      },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string | null }) | null;
        const timedOut = Boolean(e?.killed) && !opts.signal?.aborted;
        resolve({
          code: e ? (typeof e.code === 'number' ? e.code : null) : 0,
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ''),
          stderr: Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? ''),
          timedOut,
        });
      },
    );
    child.stdin?.end();
  });
};

/** 長時間背景程序(Emulator 本體、錄影):回傳 ChildProcess,由呼叫端負責 kill。 */
export function spawnBackground(file: string, args: readonly string[], env?: Record<string, string>): ChildProcess {
  assertSafeArgs([file, ...args]);
  return spawn(file, [...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...(env ? { env: { ...process.env, ...env } } : {}) });
}
