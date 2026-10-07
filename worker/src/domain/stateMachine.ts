/**
 * 明確的狀態機(不用 isRunning 之類的 boolean 管生命週期)。
 * 每次轉移都檢查是否合法並留下歷史,非法轉移直接丟錯。
 */
export class InvalidTransitionError extends Error {
  override name = 'InvalidTransitionError';
}

export interface Transition<S extends string> {
  from: S;
  to: S;
  at: string;
  reason?: string;
}

export class StateMachine<S extends string> {
  #state: S;
  readonly #table: Readonly<Record<S, readonly S[]>>;
  readonly #terminal: ReadonlySet<S>;
  readonly history: Transition<S>[] = [];

  constructor(initial: S, table: Readonly<Record<S, readonly S[]>>, terminal: readonly S[], private readonly now: () => Date = () => new Date()) {
    this.#state = initial;
    this.#table = table;
    this.#terminal = new Set(terminal);
  }

  get state(): S {
    return this.#state;
  }
  get isTerminal(): boolean {
    return this.#terminal.has(this.#state);
  }
  can(to: S): boolean {
    return this.#table[this.#state].includes(to);
  }
  transition(to: S, reason?: string): void {
    if (!this.can(to)) throw new InvalidTransitionError(`不允許的狀態轉移:${this.#state} → ${to}`);
    this.history.push({ from: this.#state, to, at: this.now().toISOString(), ...(reason ? { reason } : {}) });
    this.#state = to;
  }
}

// ───────── Job ─────────

export const JOB_STATES = ['QUEUED', 'ALLOCATING', 'PREPARING', 'RUNNING', 'RETRYING', 'PASSED', 'FAILED', 'ENVIRONMENT_ERROR', 'TIMEOUT', 'CANCELLED'] as const;
export type JobState = (typeof JOB_STATES)[number];
export const JOB_TERMINAL: readonly JobState[] = ['PASSED', 'FAILED', 'ENVIRONMENT_ERROR', 'TIMEOUT', 'CANCELLED'];

const JOB_TABLE: Record<JobState, readonly JobState[]> = {
  QUEUED: ['ALLOCATING', 'CANCELLED'],
  ALLOCATING: ['PREPARING', 'ENVIRONMENT_ERROR', 'CANCELLED', 'TIMEOUT'],
  PREPARING: ['RUNNING', 'ENVIRONMENT_ERROR', 'RETRYING', 'CANCELLED', 'TIMEOUT'],
  RUNNING: ['PASSED', 'FAILED', 'ENVIRONMENT_ERROR', 'RETRYING', 'TIMEOUT', 'CANCELLED'],
  // RETRYING:Spot 中斷 / Worker 掛掉,由 Scheduler 在另一台恢復。
  RETRYING: ['ALLOCATING', 'ENVIRONMENT_ERROR', 'CANCELLED', 'TIMEOUT'],
  PASSED: [],
  FAILED: [],
  ENVIRONMENT_ERROR: [],
  TIMEOUT: [],
  CANCELLED: [],
};

export function createJobStateMachine(now?: () => Date): StateMachine<JobState> {
  return new StateMachine<JobState>('QUEUED', JOB_TABLE, JOB_TERMINAL, now);
}

/**
 * 對應既有 status.json 的 TaskState(前端、報告、成本都讀這個)。
 * ENVIRONMENT_ERROR → error(報告依訊息歸為「環境」,不算遊戲缺陷);TIMEOUT → dead。
 */
export function toTaskState(s: JobState): 'running' | 'pass' | 'fail' | 'error' | 'cancelled' | 'dead' {
  switch (s) {
    case 'PASSED': return 'pass';
    case 'FAILED': return 'fail';
    case 'ENVIRONMENT_ERROR': return 'error';
    case 'TIMEOUT': return 'dead';
    case 'CANCELLED': return 'cancelled';
    default: return 'running';
  }
}

// ───────── Worker ─────────

export const WORKER_STATES = ['CREATED', 'BOOTING', 'READY', 'PREPARING', 'INSTALLING', 'RUNNING', 'COLLECTING_ARTIFACTS', 'RECOVERING', 'COMPLETED', 'FAILED', 'TERMINATED'] as const;
export type WorkerState = (typeof WORKER_STATES)[number];
export const WORKER_TERMINAL: readonly WorkerState[] = ['TERMINATED'];

const WORKER_TABLE: Record<WorkerState, readonly WorkerState[]> = {
  CREATED: ['BOOTING', 'TERMINATED'],
  BOOTING: ['READY', 'FAILED', 'TERMINATED'],
  READY: ['PREPARING', 'TERMINATED'],
  PREPARING: ['INSTALLING', 'FAILED', 'RECOVERING', 'TERMINATED'],
  INSTALLING: ['RUNNING', 'FAILED', 'RECOVERING', 'TERMINATED'],
  RUNNING: ['COLLECTING_ARTIFACTS', 'RECOVERING', 'FAILED', 'TERMINATED'],
  RECOVERING: ['PREPARING', 'RUNNING', 'FAILED', 'COLLECTING_ARTIFACTS', 'TERMINATED'],
  // 收證據一定要在 COMPLETED / FAILED 之前(失敗也要留截圖 / log / 錄影)。
  COLLECTING_ARTIFACTS: ['COMPLETED', 'FAILED', 'TERMINATED'],
  // 同一台 Worker 可以接下一個 session(回 READY)。
  COMPLETED: ['READY', 'TERMINATED'],
  FAILED: ['COLLECTING_ARTIFACTS', 'READY', 'TERMINATED'],
  TERMINATED: [],
};

export function createWorkerStateMachine(now?: () => Date): StateMachine<WorkerState> {
  return new StateMachine<WorkerState>('CREATED', WORKER_TABLE, WORKER_TERMINAL, now);
}
