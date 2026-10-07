/**
 * Structured JSON log(每筆都帶 jobId / workerId / platform / testCaseId / stepId / severity)。
 * 輸出到 stdout,CloudWatch Logs agent 收走。不寫任何機密(呼叫端只傳 key 名)。
 */
import type { Platform } from './platform.js';

export type Severity = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface LogContext {
  jobId: string;
  workerId: string;
  platform: Platform;
  testCaseId?: string;
}

export interface Logger {
  log(severity: Severity, message: string, extra?: { stepId?: string | number; [k: string]: unknown }): void;
  child(ctx: Partial<LogContext>): Logger;
}

export function createLogger(ctx: LogContext, sink: (line: string) => void = (l) => process.stdout.write(`${l}\n`), now: () => Date = () => new Date()): Logger {
  return {
    log(severity, message, extra = {}) {
      const { stepId, ...rest } = extra;
      sink(JSON.stringify({
        timestamp: now().toISOString(),
        jobId: ctx.jobId,
        workerId: ctx.workerId,
        platform: ctx.platform,
        testCaseId: ctx.testCaseId ?? null,
        stepId: stepId ?? null,
        severity,
        message,
        ...rest,
      }));
    },
    child(more) {
      return createLogger({ ...ctx, ...more }, sink, now);
    },
  };
}
