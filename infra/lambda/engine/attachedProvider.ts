import type { S3Client } from '@aws-sdk/client-s3';
import type {
  AcquireSpec,
  DeviceLease,
  DeviceProvider,
  RunResult,
} from './deviceProvider.js';

/**
 * AttachedProvider(Req 13)—— 使用者本地裝置,本地代理主動撥出 WS 連雲端。
 *
 * 決策恆雲端(Req 13.2/13.3):
 *   引擎(雲端)驅動迴圈:向代理要一張截圖 → 雲端 VLM 判座標/下一步 → 把指令回傳代理 →
 *   代理在本地執行 → 回下一張截圖。座標判定、下一步決策**永遠在雲端**,本地只截圖+執行。
 *
 * 錯誤語義(Req 13.6/13.7):
 *   - 代理斷線(非主動停止)→ 落 error(連線中斷不是「通過」)。
 *   - 使用者主動停止 → 落 cancelled。
 *   - 共用同一 Trace/報告(Req 13.8):step 一樣寫到 S3 jobs/<id>/steps/,報告產生器一致。
 *
 * ⚠ 環境限制誠實標註:attached 端到端需要「使用者機器上真的跑代理 + 真 WS 往返」,
 *    此建置環境不具備。此處落地的是**雲端側迴圈與錯誤語義可單元測試的骨架**,以注入的
 *    AgentChannel 模擬本地代理往返;真實承載時 AgentChannel 由 WS PostToConnection + S3
 *    截圖交換實作,介面不變。
 */

/** 與本地代理的往返通道(注入以利測試;真實為 WS + S3 截圖交換)。 */
export interface AgentChannel {
  /** 是否仍在線(斷線偵測)。 */
  isConnected(): Promise<boolean>;
  /** 向代理索取一張截圖(base64/URL);代理離線回 null。 */
  requestScreenshot(): Promise<string | null>;
  /** 把一步指令下發給代理(tap/type/swipe...);回是否送達。 */
  sendCommand(command: AgentCommand): Promise<boolean>;
}

export interface AgentCommand {
  index: number;
  action: 'tap' | 'type' | 'swipe' | 'done';
  /** 座標(千分制或像素,依 Seat 的 coordSystem);done 時省略。 */
  x?: number;
  y?: number;
  text?: string;
}

/** 雲端決策器(注入;真實為 VLM 呼叫)。回下一步指令或 done。 */
export interface Decider {
  decide(screenshot: string, spec: AcquireSpec, stepIndex: number): Promise<AgentCommand>;
}

/** 取消旗標查詢(協作式取消;真實為讀 S3 cancel.json)。 */
export interface CancelCheck {
  isCancelled(spec: AcquireSpec): Promise<boolean>;
}

/** 寫 step 到共用 Trace(真實為寫 S3 jobs/<id>/steps/)。 */
export interface StepSink {
  writeStep(s3: S3Client, spec: AcquireSpec, step: Record<string, unknown>): Promise<void>;
}

export interface AttachedProviderDeps {
  s3: S3Client;
  channel: AgentChannel;
  decider: Decider;
  cancel: CancelCheck;
  steps: StepSink;
  /** 迴圈上限,避免失控(預設 50 步)。 */
  maxSteps?: number;
}

export class AttachedProvider implements DeviceProvider {
  readonly backend = 'attached';

  constructor(private readonly deps: AttachedProviderDeps) {}

  async acquire(spec: AcquireSpec): Promise<DeviceLease> {
    // attached 不供給主機,只確認代理在線;endpoint 為代理連線標識。
    const connected = await this.deps.channel.isConnected();
    if (!connected) {
      throw new Error(`本地代理未連線(job ${spec.jobId})`);
    }
    return {
      endpoint: `attached:${spec.jobId}`,
      // 本地畫面即 Live View 來源(截圖串流);此處骨架標識為 attached 通道。
      viewUrl: `attached://${spec.jobId}`,
      hostOrigin: 'attached', // 絕不被 provisioned 回收路徑終結(Req 4.5)
    };
  }

  /**
   * 雲端主導的截圖→決策→指令→執行迴圈(Req 13.2/13.3)。
   * 每步頂部檢查:取消 → cancelled;斷線 → error。決策恆雲端。
   */
  async run(_lease: DeviceLease, spec: AcquireSpec): Promise<RunResult> {
    const maxSteps = this.deps.maxSteps ?? 50;
    for (let i = 0; i < maxSteps; i++) {
      // 主動停止 → cancelled(Req 13.7)。
      if (await this.deps.cancel.isCancelled(spec)) {
        return { state: 'cancelled', steps: i, message: '使用者主動停止' };
      }
      // 斷線 → error(Req 13.6:連線中斷不算通過)。
      if (!(await this.deps.channel.isConnected())) {
        return { state: 'error', steps: i, message: '本地代理斷線' };
      }
      const shot = await this.deps.channel.requestScreenshot();
      if (shot === null) {
        return { state: 'error', steps: i, message: '取得本地截圖失敗(代理離線)' };
      }
      // 決策恆雲端(Req 13.3)。
      const command = await this.deps.decider.decide(shot, spec, i);
      await this.deps.steps.writeStep(this.deps.s3, spec, {
        index: i,
        action: command.action,
        ...(command.x !== undefined ? { x: command.x } : {}),
        ...(command.y !== undefined ? { y: command.y } : {}),
        decidedInCloud: true,
      });
      if (command.action === 'done') {
        return { state: 'pass', steps: i + 1, message: '流程完成' };
      }
      const delivered = await this.deps.channel.sendCommand(command);
      if (!delivered) {
        return { state: 'error', steps: i + 1, message: '指令下發失敗(代理斷線)' };
      }
    }
    // 達步數上限未完成 → fail(未達成目標,非 error)。
    return { state: 'fail', steps: maxSteps, message: '達步數上限仍未完成' };
  }

  async release(_lease: DeviceLease): Promise<void> {
    // attached 主機是使用者的,絕不由雲端終結(Req 4.5)。代理連線由 WS $disconnect 收尾。
  }
}
