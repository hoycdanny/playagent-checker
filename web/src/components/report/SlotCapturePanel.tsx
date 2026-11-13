import { useState } from 'react';
import type { SlotCaptureManifest } from './reportTypes.ts';
import { pr, type RLang } from './reportText.ts';

/** 逐局盤面證據:摘要、缺口與盤面圖庫。只呈現 runner 已保存的不可變 board/context。 */
export function SlotCapturePanel({ capture: c, lang, onOpenImage }: { capture: SlotCaptureManifest; lang: RLang; onOpenImage: (url: string) => void }) {
  const [all, setAll] = useState(false);
  const s = c.summary;
  const spins = all ? c.spins : c.spins.slice(0, 60);
  const fmt = (n: number) => n.toLocaleString();
  const rate = s.detectedSpins ? Math.round((s.capturedBoards / s.detectedSpins) * 10000) / 100 : null;
  return (
    <div className="srep__slotcap">
      <div className="srep__ac-kpis">
        <div><span>{pr(['偵測停輪', 'Stable boards detected'], lang)}</span><strong>{fmt(s.detectedSpins)}</strong></div>
        <div><span>{pr(['成功保存', 'Boards saved'], lang)}</span><strong>{fmt(s.capturedBoards)}</strong></div>
        <div><span>{pr(['事件保存率', 'Event save rate'], lang)}</span><strong>{rate === null ? '—' : `${rate}%`}</strong></div>
        <div><span>{pr(['抽幀／分析失敗', 'Extraction / analysis failures'], lang)}</span><strong>{s.captureFailures + s.analysisFailures}</strong></div>
        <div><span>{pr(['影片缺口', 'Video gaps'], lang)}</span><strong>{s.gapCount} / {fmt(s.gapMs)} ms</strong></div>
        <div><span>{pr(['付費／免費／未分類', 'Paid / free / unknown'], lang)}</span><strong>{s.paidSpins ?? 0} / {s.freeSpins ?? 0} / {s.unknownSpins ?? 0}</strong></div>
        <div><span>{pr(['影片分段', 'Video segments'], lang)}</span><strong>{fmt(s.segmentCount)}</strong></div>
      </div>
      <p className="srep__muted">
        {pr([`來源:${c.capture.source} · ${c.capture.fps} FPS 分析 · ROI (${c.capture.roi.x}, ${c.capture.roi.y}, ${c.capture.roi.w}, ${c.capture.roi.h})。保存率只代表「已偵測事件都有檔案」；付費／Free Spin 分類與 AutoSpin 計數逐局對帳另行驗收。`, `Source: ${c.capture.source} · ${c.capture.fps} FPS analysis · ROI (${c.capture.roi.x}, ${c.capture.roi.y}, ${c.capture.roi.w}, ${c.capture.roi.h}). Save rate only means every detected event has files; paid/free-spin classification and counter reconciliation are assessed separately.`], lang)}
      </p>
      {c.gaps.length > 0 && (
        <details className="srep__ac-details">
          <summary>{pr([`影片時間缺口 (${c.gaps.length})`, `Video timeline gaps (${c.gaps.length})`], lang)}</summary>
          <ul>{c.gaps.map((g, i) => <li key={i} className="srep__mono">{g.after} → {g.before}: {fmt(g.ms)} ms</li>)}</ul>
        </details>
      )}
      <p className="srep__muted">
        {pr([`盤面預覽 ${c.spins.length} / ${s.detectedSpins}`, `Board preview ${c.spins.length} / ${s.detectedSpins}`], lang)}
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
              ) : <div className="srep__slotcap-missing">{pr(['無影像', 'No image'], lang)}</div>}
              <strong>#{String(spin.sequence).padStart(4, '0')} · {spin.kind === 'paid' ? (pr(['付費', 'paid'], lang)) : spin.kind === 'free' ? 'Free Spin' : (pr(['未分類', 'unknown'], lang))}</strong>
              <small>{Math.round(spin.busyMs)} ms · conf {spin.confidence.toFixed(3)}</small>
              {spin.error && <small className="srep__slotcap-error">{spin.error}</small>}
            </article>
          );
        })}
      </div>
      {c.spins.length > 60 && (
        <button type="button" className="srep__more" onClick={() => setAll((v) => !v)}>
          {all ? (pr(['收合', 'Show less'], lang)) : `${pr(['顯示全部', 'Show all'], lang)} (${c.spins.length})`}
        </button>
      )}
    </div>
  );
}
