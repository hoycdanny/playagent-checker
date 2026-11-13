import { useEffect, useState } from 'react';
import type { BootPhase, BootProgress } from '../../api/useJobStream.ts';
import { pr, type RLang } from '../report/reportText.ts';
import { InfoIcon, type InfoIconName } from './InfoIcon.tsx';
// 時鐘格式與任務列表的「操作時間」欄共用,同一個任務兩邊看到的字串一致。
export { fmtDur } from '../duration.ts';
import { fmtDur } from '../duration.ts';

/**
 * 即時畫面上方的啟動時間軸:Device Farm 開機各階段(icon + 耗時)與總計時。
 * 啟動中 → 顯示「啟動已 m:ss」與目前階段(閃動);開機成功 → 顯示「啟動耗時」與「已執行 m:ss」。
 * 計時在前端每秒更新,不依賴後端推送頻率。
 */
type Stage = 'queue' | BootPhase;

const STAGES: Array<{ id: Stage; icon: InfoIconName; name: readonly [string, string]; tip: readonly [string, string] }> = [
  { id: 'queue', icon: 'cloud', name: ['排隊', 'Queue'], tip: ['任務已送出,啟動執行容器', 'Run submitted, starting the runner container'] },
  { id: 'download', icon: 'package', name: ['準備 APK', 'APK'], tip: ['下載並檢查安裝檔(XAPK 會先合併)', 'Downloading and checking the app package'] },
  { id: 'upload', icon: 'upload', name: ['上傳', 'Upload'], tip: ['上傳安裝檔到 Device Farm(同版本會直接沿用)', 'Uploading to Device Farm (reused if unchanged)'] },
  { id: 'device', icon: 'phone', name: ['配置真機', 'Device'], tip: ['Device Farm 分配實體手機、開機並安裝 App', 'Device Farm allocates, boots and installs the app'] },
  { id: 'connect', icon: 'plug', name: ['連線', 'Connect'], tip: ['真機就緒,建立 Appium 遙控連線', 'Device ready, connecting Appium'] },
  { id: 'run', icon: 'play', name: ['測試中', 'Testing'], tip: ['AI 開始操作遊戲', 'The AI is playing'] },
];

const DEVICE_STATUS: Record<string, [string, string]> = {
  PENDING: ['等待分配手機', 'Waiting for a device'],
  PENDING_CONCURRENCY: ['等待可用名額', 'Waiting for capacity'],
  PENDING_DEVICE: ['等待手機空出', 'Waiting for the device'],
  SCHEDULING: ['排程中', 'Scheduling'],
  PREPARING: ['手機準備中', 'Preparing device'],
  INITIALIZING: ['開機並安裝 App', 'Booting and installing'],
  PROCESSING: ['處理中', 'Processing'],
  RUNNING: ['手機已開機', 'Device running'],
};

const OPEN_KEY = 'pa.bootTimelineOpen';

const TERMINAL = new Set(['pass', 'fail', 'error', 'cancelled', 'budget_exceeded', 'dead']);

const ms = (iso?: string) => (iso ? Date.parse(iso) : NaN);

export function BootTimeline({ boot, createdAt, updatedAt, firstStepAt, state, backend, lang }: {
  boot?: BootProgress;
  createdAt?: string;
  updatedAt?: string;
  /**
   * 第一步的時間 —— 只有 web runner 不寫 boot(沒有開機/連線階段可報),
   * 這時用「AI 的第一個動作」當測試開始,否則 web 任務永遠看不到測試耗時。
   * 列表的「操作時間」欄用同一個回退(見 duration.ts / listJobs 的 runStartedAt)。
   */
  firstStepAt?: string;
  state: string;
  backend?: string;
  lang: RLang;
}) {
  const ended = TERMINAL.has(state);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (ended) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ended]);

  // 各階段明細可收合:使用者按過就記住(localStorage);沒按過 → 啟動中展開、開始測試後自動收起。
  const [pref, setPref] = useState<boolean | null>(() => {
    try {
      const v = localStorage.getItem(OPEN_KEY);
      return v === '1' ? true : v === '0' ? false : null;
    } catch { return null; }
  });
  const toggle = (next: boolean) => {
    setPref(next);
    try { localStorage.setItem(OPEN_KEY, next ? '1' : '0'); } catch { /* ignore */ }
  };

  const start = ms(createdAt);
  const endAt = ended ? ms(updatedAt) : now;
  const stamp: Partial<Record<Stage, number>> = {
    queue: start,
    download: ms(boot?.at?.download ?? boot?.runnerAt),
    upload: ms(boot?.at?.upload),
    device: ms(boot?.at?.device),
    connect: ms(boot?.at?.connect),
    run: ms(boot?.at?.run ?? firstStepAt),
  };
  const isDeviceFarm = backend === 'devicefarm' || !!boot;
  const stages = isDeviceFarm ? STAGES : STAGES.filter((s) => s.id === 'queue' || s.id === 'run');
  // 目前階段:最後一個有時間戳的階段;還沒任何 runner 進度 → 排隊中。
  let current: Stage = 'queue';
  for (const s of stages) if (Number.isFinite(stamp[s.id])) current = s.id;
  if (!isDeviceFarm && state !== 'queued' && !ended) current = 'run';
  const curIdx = stages.findIndex((s) => s.id === current);
  const runStart = stamp.run;
  const booted = Number.isFinite(runStart);
  const failedDuringBoot = ended && !booted && isDeviceFarm;

  // 每階段耗時 = 下一個有時間戳的階段開始(或現在/結束)− 本階段開始。
  const durOf = (i: number): number | undefined => {
    const a = stamp[stages[i]!.id];
    if (!Number.isFinite(a)) return undefined;
    for (let j = i + 1; j < stages.length; j++) {
      const b = stamp[stages[j]!.id];
      if (Number.isFinite(b)) return b! - a!;
    }
    return stages[i]!.id === 'run' || !ended || failedDuringBoot ? endAt - a! : undefined;
  };

  const bootMs = booted ? runStart! - start : endAt - start;
  const runMs = booted ? endAt - runStart! : undefined;
  const devLabel = boot?.deviceStatus ? DEVICE_STATUS[boot.deviceStatus]?.[lang === 'zh' ? 0 : 1] ?? boot.deviceStatus : undefined;
  if (!Number.isFinite(start)) return null;
  const open = pref ?? !booted;
  const stepsId = 'dboot-steps';

  return (
    <div className="dboot" aria-label={pr(['啟動進度', 'Startup progress'], lang)}>
      <div className="dboot__summary" aria-live="polite">
        <span className={`dboot__timer ${!booted && !ended ? 'is-active' : ''} ${failedDuringBoot ? 'is-fail' : ''}`}>
          <InfoIcon name={booted ? 'rocket' : failedDuringBoot ? 'x' : 'clock'} size={15} />
          <span className="dboot__timer-label">
            {booted ? (pr(['啟動耗時', 'Startup'], lang)) : failedDuringBoot ? (pr(['啟動失敗', 'Startup failed'], lang)) : pr(['啟動中', 'Starting'], lang)}
          </span>
          <b>{fmtDur(bootMs)}</b>
        </span>
        {runMs !== undefined && (
          <span className={`dboot__timer ${!ended ? 'is-running' : ''}`}>
            <InfoIcon name={ended ? 'check' : 'play'} size={15} />
            <span className="dboot__timer-label">{ended ? (pr(['測試耗時', 'Test time'], lang)) : pr(['已執行', 'Running'], lang)}</span>
            <b>{fmtDur(runMs)}</b>
          </span>
        )}
        {boot?.session && booted && !ended && (() => {
          // 連線時間上限:單段 → 到點收尾;長時 → 到點換新連線(第 N / M 段)。
          const ss = boot.session;
          const wrapAt = ms(ss.wrapAt);
          if (!Number.isFinite(wrapAt)) return null;
          const last = ss.maxSegments !== 0 && ss.segment >= ss.maxSegments;
          const hhmm = new Date(wrapAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          const segNo = `${ss.segment}${ss.maxSegments ? `/${ss.maxSegments}` : ''}`;
          const segText = ss.maxSegments === 1 ? '' : pr([`第 ${segNo} 段 · `, `Session ${segNo} · `], lang);
          const what = last ? (pr(['收尾', 'wrap-up'], lang)) : (pr(['換新連線', 'new session'], lang));
          return (
            <span className="dboot__total" title={pr(['Device Farm 單次連線最長 150 分鐘', 'A Device Farm session lasts at most 150 minutes'], lang)}>
              {segText}{hhmm} {what}({fmtDur(Math.max(0, wrapAt - now))})
            </span>
          );
        })()}
        {ended && Number.isFinite(endAt) && (
          <span className="dboot__total">{pr(['總計', 'Total'], lang)} {fmtDur(endAt - start)}</span>
        )}
        <button
          type="button"
          className="dboot__fold"
          aria-expanded={open}
          aria-controls={stepsId}
          onClick={() => toggle(!open)}
          title={open ? (pr(['收合啟動階段', 'Hide startup stages'], lang)) : (pr(['展開啟動階段', 'Show startup stages'], lang))}
        >
          <span aria-hidden="true">{open ? '▴' : '▾'}</span>
          <span className="visually-hidden">{open ? (pr(['收合啟動階段', 'Hide startup stages'], lang)) : (pr(['展開啟動階段', 'Show startup stages'], lang))}</span>
        </button>
      </div>

      <ol className="dboot__steps" id={stepsId} hidden={!open}>
        {stages.map((s, i) => {
          const done = i < curIdx || (s.id === 'run' && ended && booted);
          const active = i === curIdx && !ended;
          const failed = failedDuringBoot && i === curIdx;
          const d = durOf(i);
          const cls = done ? 'is-done' : failed ? 'is-fail' : active ? 'is-active' : 'is-todo';
          const tipId = `dboot-tip-${s.id}`;
          const detail = s.id === 'device' && devLabel && (active || failed) ? devLabel : undefined;
          return (
            <li key={s.id} className={`dboot__step ${cls}`}>
              <span className="dboot__dot" tabIndex={0} aria-describedby={tipId}>
                <InfoIcon name={done ? 'check' : failed ? 'x' : s.icon} size={14} />
              </span>
              <span className="dboot__name">{pr(s.name, lang)}</span>
              <span className="dboot__dur">{d !== undefined && (done || active || failed) ? fmtDur(d) : ''}</span>
              {detail && <span className="dboot__detail">{detail}</span>}
              <span role="tooltip" id={tipId} className="dboot__tip">
                <b>{pr(s.name, lang)}</b>
                <span>{pr(s.tip, lang)}</span>
                {s.id === 'device' && boot?.deviceModel && <span>{boot.deviceModel}</span>}
                {s.id === 'upload' && boot?.sizeMB ? <span>{boot.sizeMB} MB</span> : null}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
