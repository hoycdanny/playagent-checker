import { useState } from 'react';
import type { SlotCaptureManifest } from './reportTypes.ts';
import type { RLang } from './reportText.ts';

/** 逐局盤面證據:摘要、缺口與盤面圖庫。只呈現 runner 已保存的不可變 board/context。 */
export function SlotCapturePanel({ capture: c, lang, onOpenImage }: { capture: SlotCaptureManifest; lang: RLang; onOpenImage: (url: string) => void }) {
  const [all, setAll] = useState(false);
  const zh = lang === 'zh';
  const s = c.summary;
  const spins = all ? c.spins : c.spins.slice(0, 60);
  const fmt = (n: number) => n.toLocaleString();
  const rate = s.detectedSpins ? Math.round((s.capturedBoards / s.detectedSpins) * 10000) / 100 : null;
  return (
    <div className="srep__slotcap">
      <div className="srep__ac-kpis">
        <div><span>{zh ? '偵測停輪' : 'Stable boards detected'}</span><strong>{fmt(s.detectedSpins)}</strong></div>
        <div><span>{zh ? '成功保存' : 'Boards saved'}</span><strong>{fmt(s.capturedBoards)}</strong></div>
        <div><span>{zh ? '事件保存率' : 'Event save rate'}</span><strong>{rate === null ? '—' : `${rate}%`}</strong></div>
        <div><span>{zh ? '抽幀／分析失敗' : 'Extraction / analysis failures'}</span><strong>{s.captureFailures + s.analysisFailures}</strong></div>
        <div><span>{zh ? '影片缺口' : 'Video gaps'}</span><strong>{s.gapCount} / {fmt(s.gapMs)} ms</strong></div>
        <div><span>{zh ? '付費／免費／未分類' : 'Paid / free / unknown'}</span><strong>{s.paidSpins ?? 0} / {s.freeSpins ?? 0} / {s.unknownSpins ?? 0}</strong></div>
        <div><span>{zh ? '影片分段' : 'Video segments'}</span><strong>{fmt(s.segmentCount)}</strong></div>
      </div>
      <p className="srep__muted">
        {zh
          ? `來源:${c.capture.source} · ${c.capture.fps} FPS 分析 · ROI (${c.capture.roi.x}, ${c.capture.roi.y}, ${c.capture.roi.w}, ${c.capture.roi.h})。保存率只代表「已偵測事件都有檔案」；付費／Free Spin 分類與 AutoSpin 計數逐局對帳另行驗收。`
          : `Source: ${c.capture.source} · ${c.capture.fps} FPS analysis · ROI (${c.capture.roi.x}, ${c.capture.roi.y}, ${c.capture.roi.w}, ${c.capture.roi.h}). Save rate only means every detected event has files; paid/free-spin classification and counter reconciliation are assessed separately.`}
      </p>
      {c.gaps.length > 0 && (
        <details className="srep__ac-details">
          <summary>{zh ? `影片時間缺口 (${c.gaps.length})` : `Video timeline gaps (${c.gaps.length})`}</summary>
          <ul>{c.gaps.map((g, i) => <li key={i} className="srep__mono">{g.after} → {g.before}: {fmt(g.ms)} ms</li>)}</ul>
        </details>
      )}
      <p className="srep__muted">
        {zh ? `盤面預覽 ${c.spins.length} / ${s.detectedSpins}` : `Board preview ${c.spins.length} / ${s.detectedSpins}`}
      </p>
      <div className="srep__slotcap-grid">
        {spins.map((spin) => {
          const img = spin.boardUrl ?? spin.contextUrl;
          return (
            <article key={spin.sequence} className={`srep__slotcap-card ${spin.status !== 'captured' ? 'is-fail' : ''}`}>
              {img ? (
                <button type="button" onClick={() => onOpenImage(spin.contextUrl ?? img)} aria-label={`Spin #${spin.sequence}`}>
                  <img src={img} alt="" loading="lazy" />
                </button>
              ) : <div className="srep__slotcap-missing">{zh ? '無影像' : 'No image'}</div>}
              <strong>#{String(spin.sequence).padStart(4, '0')} · {spin.kind === 'paid' ? (zh ? '付費' : 'paid') : spin.kind === 'free' ? 'Free Spin' : (zh ? '未分類' : 'unknown')}</strong>
              <small>{Math.round(spin.busyMs)} ms · conf {spin.confidence.toFixed(3)}</small>
              {spin.error && <small className="srep__slotcap-error">{spin.error}</small>}
            </article>
          );
        })}
      </div>
      {c.spins.length > 60 && (
        <button type="button" className="srep__more" onClick={() => setAll((v) => !v)}>
          {all ? (zh ? '收合' : 'Show less') : `${zh ? '顯示全部' : 'Show all'} (${c.spins.length})`}
        </button>
      )}
    </div>
  );
}
