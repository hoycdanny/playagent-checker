import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPut } from '../../api/client.ts';
import { useI18n } from '../../i18n/I18nProvider.tsx';

/** 與後端 uitarsSwitch.ts 的 UitarsStatus 對齊。 */
type UitarsState = 'off' | 'starting' | 'on' | 'stopping' | 'failed';
interface UitarsStatus {
  state: UitarsState;
  endpointStatus?: string;
  failureReason?: string;
  endpointName: string;
  instanceType: string;
  last?: { action: 'enable' | 'disable'; by: string; at: string };
}

/** 轉換中(啟動 / 關閉)時的輪詢間隔。 */
const POLL_MS = 15_000;

/**
 * 系統管理頁的 UI-TARS 開關(admin 專用,預設關閉)。
 * 開啟 = 建 SageMaker GPU endpoint(按小時計費、冷啟 10~15 分鐘);關閉 = 刪 endpoint。
 * 開啟後,建立任務時的 VLM 下拉才會出現 UI-TARS。
 */
export function UitarsPanel() {
  const { locale } = useI18n();
  const T = text(locale);
  const [status, setStatus] = useState<UitarsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 二次確認:開啟會開始計費,關閉會讓選 UI-TARS 的新任務不能送出。
  const [confirming, setConfirming] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await apiGet<UitarsStatus>('/system/uitars'));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // 啟動 / 關閉中:定期刷新,直到穩定。
  const transitional = status?.state === 'starting' || status?.state === 'stopping';
  useEffect(() => {
    if (!transitional) return;
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [transitional, load]);

  async function apply(enabled: boolean) {
    setBusy(true);
    setError(null);
    try {
      setStatus(await apiPut<UitarsStatus>('/system/uitars', { enabled }));
      setConfirming(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const state = status?.state ?? 'off';
  // 失敗的 endpoint 仍可能計費,所以「關閉」在 failed 時也要能按。
  const canEnable = state === 'off';
  const canDisable = state === 'on' || state === 'starting' || state === 'failed';

  return (
    <>
      <h2 className="sysupd__section">{T.section}</h2>
      <div className="sysupd__card" aria-labelledby="uitars-title">
        <div className="sysupd__switch-row">
          <h3 id="uitars-title" className="sysupd__card-title">
            UI-TARS-1.5-7B <span className="sysupd__muted">{T.subtitle}</span>
          </h3>
          <span className="sysupd__state" data-state={state} role="status" aria-live="polite">
            {status ? T.state[state] : T.loading}
          </span>
        </div>

        <p className="sysupd__hint">{T.intro}</p>
        <p className="sysupd__muted">{T.cost.replace('{type}', status?.instanceType ?? 'ml.g6e.xlarge')}</p>
        {state === 'starting' && <p className="sysupd__warn">{T.startingHint}</p>}
        {state === 'failed' && (
          <p className="sysupd__error" role="alert">{T.failedHint}{status?.failureReason ? `(${status.failureReason})` : ''}</p>
        )}
        {error && <p className="sysupd__error" role="alert">{error}</p>}

        {confirming === null ? (
          <div className="sysupd__confirm-actions">
            {canEnable && (
              <button type="button" className="sysupd__primary" disabled={busy || !status} onClick={() => setConfirming(true)}>
                {T.enable}
              </button>
            )}
            {canDisable && (
              <button type="button" className="sysupd__danger-btn" disabled={busy} onClick={() => setConfirming(false)}>
                {T.disable}
              </button>
            )}
            <button type="button" className="sysupd__refresh" disabled={busy} onClick={() => void load()}>
              {T.refresh}
            </button>
          </div>
        ) : (
          <div className="sysupd__confirm">
            <p className="sysupd__danger">{confirming ? T.confirmEnable : T.confirmDisable}</p>
            <div className="sysupd__confirm-actions">
              <button
                type="button"
                className={confirming ? 'sysupd__primary' : 'sysupd__danger-btn'}
                disabled={busy}
                onClick={() => void apply(confirming)}
              >
                {busy ? T.working : confirming ? T.enableGo : T.disableGo}
              </button>
              <button type="button" className="sysupd__secondary" disabled={busy} onClick={() => setConfirming(null)}>
                {T.cancel}
              </button>
            </div>
          </div>
        )}

        {status?.last && (
          <p className="sysupd__muted">
            {T.last
              .replace('{action}', status.last.action === 'enable' ? T.enable : T.disable)
              .replace('{by}', status.last.by)
              .replace('{at}', new Date(status.last.at).toLocaleString())}
          </p>
        )}
      </div>
    </>
  );
}

/** [繁中, English, 简中, 日本語, 한국어] */
type L5 = readonly [string, string, string, string, string];
const IDX: Record<string, number> = { 'zh-Hant': 0, en: 1, 'zh-Hans': 2, ja: 3, ko: 4 };
const pick = (t: L5, i: number) => t[i] ?? t[1];

function text(locale: string) {
  const i = IDX[locale] ?? 1;
  const S = {
    section: ['UI-TARS 定位模型', 'UI-TARS grounding model', 'UI-TARS 定位模型', 'UI-TARS グラウンディングモデル', 'UI-TARS 그라운딩 모델'] as L5,
    subtitle: ['SageMaker GPU', 'SageMaker GPU', 'SageMaker GPU', 'SageMaker GPU', 'SageMaker GPU'] as L5,
    loading: ['讀取中…', 'Loading…', '读取中…', '読み込み中…', '불러오는 중…'] as L5,
    state: {
      off: ['已關閉', 'Off', '已关闭', 'オフ', '꺼짐'] as L5,
      starting: ['啟動中', 'Starting', '启动中', '起動中', '시작 중'] as L5,
      on: ['已開啟', 'On', '已开启', 'オン', '켜짐'] as L5,
      stopping: ['關閉中', 'Stopping', '关闭中', '停止中', '끄는 중'] as L5,
      failed: ['啟動失敗', 'Failed', '启动失败', '起動失敗', '시작 실패'] as L5,
    },
    intro: [
      '專門做 GUI 定位的視覺模型,點小按鈕比通用模型準。開啟後,建立任務時的 VLM 選單才會出現 UI-TARS;目前只支援 Device Farm 真機,其他環境會自動改用 Bedrock 的視覺模型。',
      'A vision model specialised for GUI grounding; more precise on small buttons than general models. Once on, UI-TARS appears in the VLM menu when creating a task. Only Device Farm real devices use it; other runtimes fall back to a Bedrock vision model.',
      '专门做 GUI 定位的视觉模型,点小按钮比通用模型准。开启后,建立任务时的 VLM 菜单才会出现 UI-TARS;目前只支持 Device Farm 真机,其他环境会自动改用 Bedrock 的视觉模型。',
      'GUI のグラウンディングに特化した視覚モデルで、小さなボタンを汎用モデルより正確に押せます。オンにするとタスク作成時の VLM メニューに UI-TARS が表示されます。Device Farm 実機のみ対応で、他の環境は Bedrock の視覚モデルに自動で切り替わります。',
      'GUI 그라운딩에 특화된 비전 모델로, 작은 버튼을 범용 모델보다 정확하게 누릅니다. 켜면 작업 생성 시 VLM 메뉴에 UI-TARS가 나타납니다. Device Farm 실기기만 지원하며, 다른 환경은 Bedrock 비전 모델로 자동 전환됩니다.',
    ] as L5,
    cost: [
      '開著就計費({type} GPU,約 US$62.5/天,不管有沒有任務在用);不用時請關閉。',
      'Billed while on ({type} GPU, about US$62.5/day whether or not tasks use it). Turn it off when idle.',
      '开着就计费({type} GPU,约 US$62.5/天,不管有没有任务在用);不用时请关闭。',
      'オンの間は課金されます({type} GPU、タスクの有無にかかわらず約 US$62.5/日)。使わないときはオフにしてください。',
      '켜져 있는 동안 과금됩니다({type} GPU, 작업 사용 여부와 관계없이 약 US$62.5/일). 사용하지 않을 때는 꺼 주세요.',
    ] as L5,
    startingHint: [
      'GPU 主機啟動與載入模型約需 10–15 分鐘,完成後狀態會自動變成「已開啟」。啟動期間已經開始計費。',
      'Starting the GPU host and loading the model takes about 10–15 minutes; the status turns On automatically. Billing starts during startup.',
      'GPU 主机启动与加载模型约需 10–15 分钟,完成后状态会自动变成「已开启」。启动期间已经开始计费。',
      'GPU ホストの起動とモデルの読み込みに約 10〜15 分かかります。完了すると自動で「オン」になります。起動中から課金されます。',
      'GPU 호스트 시작과 모델 로딩에 약 10~15분이 걸리며, 완료되면 자동으로 "켜짐"이 됩니다. 시작 중에도 과금됩니다.',
    ] as L5,
    failedHint: [
      'UI-TARS 啟動失敗,主機可能仍在計費。請先按「關閉」,再重新開啟。',
      'UI-TARS failed to start and may still be billed. Turn it off, then on again.',
      'UI-TARS 启动失败,主机可能仍在计费。请先按「关闭」,再重新开启。',
      'UI-TARS の起動に失敗しました。課金が続いている可能性があります。いったんオフにしてから再度オンにしてください。',
      'UI-TARS 시작에 실패했으며 계속 과금될 수 있습니다. 끈 다음 다시 켜 주세요.',
    ] as L5,
    enable: ['開啟', 'Turn on', '开启', 'オンにする', '켜기'] as L5,
    disable: ['關閉', 'Turn off', '关闭', 'オフにする', '끄기'] as L5,
    refresh: ['重新整理', 'Refresh', '刷新', '更新', '새로고침'] as L5,
    confirmEnable: [
      '確定要開啟 UI-TARS?會開一台 GPU 主機並開始計費(約 US$62.5/天),直到你關閉為止。',
      'Turn on UI-TARS? This starts a GPU host that is billed (about US$62.5/day) until you turn it off.',
      '确定要开启 UI-TARS?会开一台 GPU 主机并开始计费(约 US$62.5/天),直到你关闭为止。',
      'UI-TARS をオンにしますか?GPU ホストが起動し、オフにするまで課金されます(約 US$62.5/日)。',
      'UI-TARS를 켜시겠습니까? GPU 호스트가 시작되며 끌 때까지 과금됩니다(약 US$62.5/일).',
    ] as L5,
    confirmDisable: [
      '確定要關閉 UI-TARS?之後選 UI-TARS 的任務將無法送出;正在用 UI-TARS 跑的任務會失去定位能力。',
      'Turn off UI-TARS? New tasks can no longer select it, and runs currently using it lose grounding.',
      '确定要关闭 UI-TARS?之后选 UI-TARS 的任务将无法送出;正在用 UI-TARS 跑的任务会失去定位能力。',
      'UI-TARS をオフにしますか?以後 UI-TARS を選んだタスクは送信できず、実行中のタスクは位置特定ができなくなります。',
      'UI-TARS를 끄시겠습니까? 이후 UI-TARS를 선택한 작업은 제출할 수 없고, 실행 중인 작업은 그라운딩을 잃습니다.',
    ] as L5,
    enableGo: ['確認開啟', 'Confirm turn on', '确认开启', 'オンにする', '켜기 확인'] as L5,
    disableGo: ['確認關閉', 'Confirm turn off', '确认关闭', 'オフにする', '끄기 확인'] as L5,
    cancel: ['取消', 'Cancel', '取消', 'キャンセル', '취소'] as L5,
    working: ['處理中…', 'Working…', '处理中…', '処理中…', '처리 중…'] as L5,
    last: ['最後一次:{by} 於 {at} {action}', 'Last: {action} by {by} at {at}', '最后一次:{by} 于 {at} {action}', '最終操作:{at} に {by} が{action}', '마지막: {at}에 {by}님이 {action}'] as L5,
  };
  return {
    section: pick(S.section, i),
    subtitle: pick(S.subtitle, i),
    loading: pick(S.loading, i),
    state: {
      off: pick(S.state.off, i),
      starting: pick(S.state.starting, i),
      on: pick(S.state.on, i),
      stopping: pick(S.state.stopping, i),
      failed: pick(S.state.failed, i),
    } as Record<UitarsState, string>,
    intro: pick(S.intro, i),
    cost: pick(S.cost, i),
    startingHint: pick(S.startingHint, i),
    failedHint: pick(S.failedHint, i),
    enable: pick(S.enable, i),
    disable: pick(S.disable, i),
    refresh: pick(S.refresh, i),
    confirmEnable: pick(S.confirmEnable, i),
    confirmDisable: pick(S.confirmDisable, i),
    enableGo: pick(S.enableGo, i),
    disableGo: pick(S.disableGo, i),
    cancel: pick(S.cancel, i),
    working: pick(S.working, i),
    last: pick(S.last, i),
  };
}
