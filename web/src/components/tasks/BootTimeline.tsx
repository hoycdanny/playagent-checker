import { useEffect, useState } from 'react';
import type { BootPhase, BootProgress } from '../../api/useJobStream.ts';
import type { RLang } from '../report/reportText.ts';
import { InfoIcon, type InfoIconName } from './InfoIcon.tsx';

/**
 * 即時畫面上方的啟動時間軸:Device Farm 開機各階段(icon + 耗時)與總計時。
 * 啟動中 → 顯示「啟動已 m:ss」與目前階段(閃動);開機成功 → 顯示「啟動耗時」與「已執行 m:ss」。
 * 計時在前端每秒更新,不依賴後端推送頻率。
 */
type Stage = 'queue' | BootPhase;

const STAGES: Array<{ id: Stage; icon: InfoIconName; zh: string; en: string; tipZh: string; tipEn: string }> = [
  { id: 'queue', icon: 'cloud', zh: '排隊', en: 'Queue', tipZh: '任務已送出,啟動執行容器', tipEn: 'Run submitted, starting the runner container' },
  { id: 'download', icon: 'package', zh: '準備 APK', en: 'APK', tipZh: '下載並檢查安裝檔(XAPK 會先合併)', tipEn: 'Downloading and checking the app package' },
  { id: 'upload', icon: 'upload', zh: '上傳', en: 'Upload', tipZh: '上傳安裝檔到 Device Farm(同版本會直接沿用)', tipEn: 'Uploading to Device Farm (reused if unchanged)' },
  { id: 'device', icon: 'phone', zh: '配置真機', en: 'Device', tipZh: 'Device Farm 分配實體手機、開機並安裝 App', tipEn: 'Device Farm allocates, boots and installs the app' },
  { id: 'connect', icon: 'plug', zh: '連線', en: 'Connect', tipZh: '真機就緒,建立 Appium 遙控連線', tipEn: 'Device ready, connecting Appium' },
  { id: 'run', icon: 'play', zh: '測試中', en: 'Testing', tipZh: 'AI 開始操作遊戲', tipEn: 'The AI is playing' },
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

const TERMINAL = new Set(['pass', 'fail', 'error', 'cancelled', 'budget_exceeded', 'dead']);

export function fmtDur(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

const ms = (iso?: string) => (iso ? Date.parse(iso) : NaN);

export function BootTimeline({ boot, createdAt, updatedAt, state, backend, lang }: {
  boot?: BootProgress;
  createdAt?: string;
  updatedAt?: string;
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

  const zh = lang === 'zh';
  const start = ms(createdAt);
  const endAt = ended ? ms(updatedAt) : now;
  const stamp: Partial<Record<Stage, number>> = {
    queue: start,
    download: ms(boot?.at?.download ?? boot?.runnerAt),
    upload: ms(boot?.at?.upload),
    device: ms(boot?.at?.device),
    connect: ms(boot?.at?.connect),
    run: ms(boot?.at?.run),
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
  const devLabel = boot?.deviceStatus ? DEVICE_STATUS[boot.deviceStatus]?.[zh ? 0 : 1] ?? boot.deviceStatus : undefined;
  if (!Number.isFinite(start)) return null;

  return (
    <div className="dboot" aria-label={zh ? '啟動進度' : 'Startup progress'}>
      <div className="dboot__summary" aria-live="polite">
        <span className={`dboot__timer ${!booted && !ended ? 'is-active' : ''} ${failedDuringBoot ? 'is-fail' : ''}`}>
          <InfoIcon name={booted ? 'rocket' : failedDuringBoot ? 'x' : 'clock'} size={15} />
          <span className="dboot__timer-label">
            {booted ? (zh ? '啟動耗時' : 'Startup') : failedDuringBoot ? (zh ? '啟動失敗' : 'Startup failed') : zh ? '啟動中' : 'Starting'}
          </span>
          <b>{fmtDur(bootMs)}</b>
        </span>
        {runMs !== undefined && (
          <span className={`dboot__timer ${!ended ? 'is-running' : ''}`}>
            <InfoIcon name={ended ? 'check' : 'play'} size={15} />
            <span className="dboot__timer-label">{ended ? (zh ? '測試耗時' : 'Test time') : zh ? '已執行' : 'Running'}</span>
            <b>{fmtDur(runMs)}</b>
          </span>
        )}
        {ended && Number.isFinite(endAt) && (
          <span className="dboot__total">{zh ? '總計' : 'Total'} {fmtDur(endAt - start)}</span>
        )}
      </div>

      <ol className="dboot__steps">
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
              <span className="dboot__name">{zh ? s.zh : s.en}</span>
              <span className="dboot__dur">{d !== undefined && (done || active || failed) ? fmtDur(d) : ''}</span>
              {detail && <span className="dboot__detail">{detail}</span>}
              <span role="tooltip" id={tipId} className="dboot__tip">
                <b>{zh ? s.zh : s.en}</b>
                <span>{zh ? s.tipZh : s.tipEn}</span>
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
