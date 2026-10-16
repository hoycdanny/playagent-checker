import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CloudDevice } from '../api/client.ts';
import { useI18n } from '../i18n/I18nProvider.tsx';
import './DevicePicker.css';

export interface DevicePickerProps {
  /** 可選裝置池(來自 /devices/cloud)。 */
  devices: CloudDevice[];
  /** 目前選定的裝置 ARN(空字串 = 自動挑第一台可用)。 */
  value: string;
  /** 使用者點「選定」後回傳所選裝置(null = 自動)。 */
  onSelect: (device: CloudDevice | null) => void;
  /** 關閉挑選器(不變更)。 */
  onClose: () => void;
}

function memGb(bytes?: number): string | undefined {
  if (typeof bytes !== 'number' || bytes <= 0) return undefined;
  return `${Math.round(bytes / 1024 / 1024 / 1024)} GB`;
}

/**
 * Device Farm 真機挑選器(modal)。
 * Device Farm 有上百台裝置,用下拉很難挑;此挑選器提供:
 * - 關鍵字搜尋(機型名 / 製造商)
 * - 依 Android 版本篩選
 * - 卡片列出每台的機型特性(解析度 / 記憶體 / CPU),點卡片即選取(高亮)
 * - 「自動」選項(交給引擎挑第一台可用機)
 * 採對話框模式:Esc 關閉、點背景關閉、focus 進搜尋框。
 */
export default function DevicePicker({ devices, value, onSelect, onClose }: DevicePickerProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [osFilter, setOsFilter] = useState('');
  // 暫存挑選(按「選定」才提交),初始為傳入的 value。
  const [picked, setPicked] = useState(value);
  // 清單內若全是 iOS 就標 iOS,否則標 Android(版本篩選下拉用)。
  const platformName = devices.length > 0 && devices.every((d) => d.platform === 'ios') ? 'iOS' : 'Android';

  // Esc 關閉。
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 可選的 Android 版本(去重、新到舊)。
  const osOptions = useMemo(() => {
    const set = new Set<string>();
    for (const d of devices) if (d.os) set.add(d.os);
    return [...set].sort((a, b) => (parseFloat(b) || 0) - (parseFloat(a) || 0));
  }, [devices]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return devices
      .filter((d) => Boolean(d.arn))
      .filter((d) => (osFilter ? d.os === osFilter : true))
      .filter((d) =>
        q
          ? `${d.name} ${d.manufacturer} ${d.os}`.toLowerCase().includes(q)
          : true,
      );
  }, [devices, query, osFilter]);

  function confirm() {
    if (!picked) {
      onSelect(null);
    } else {
      const d = devices.find((x) => x.arn === picked) ?? null;
      onSelect(d);
    }
  }

  return createPortal(
    <div className="devpick__overlay" role="presentation" onMouseDown={onClose}>
      <div
        className="devpick"
        role="dialog"
        aria-modal="true"
        aria-label={t('device.pickTitle')}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="devpick__head">
          <h2 className="devpick__title">{t('device.pickTitle')}</h2>
          <button type="button" className="devpick__close" aria-label={t('device.close')} onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="devpick__controls">
          <input
            className="devpick__search"
            type="search"
            autoFocus
            placeholder={t('device.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            className="devpick__os"
            value={osFilter}
            onChange={(e) => setOsFilter(e.target.value)}
            aria-label={t('device.filterOs')}
          >
            <option value="">{t('device.allOs')}</option>
            {osOptions.map((os) => (
              <option key={os} value={os}>
                {platformName} {os}
              </option>
            ))}
          </select>
        </div>

        <p className="devpick__count">
          {t('device.count').replace('{n}', String(filtered.length))}
        </p>

        <div className="devpick__list">
          {/* 自動(不指定,由引擎挑第一台可用) */}
          <button
            type="button"
            className={`devpick__card devpick__card--auto${picked === '' ? ' devpick__card--selected' : ''}`}
            aria-pressed={picked === ''}
            onClick={() => setPicked('')}
            onDoubleClick={confirm}
          >
            <span className="devpick__card-name">{t('device.autoTitle')}</span>
            <span className="devpick__card-meta">{t('device.autoDesc')}</span>
          </button>

          {filtered.map((d) => {
            const specs = [d.resolution, memGb(d.memoryBytes), d.cpu].filter(Boolean);
            const isSel = picked === d.arn;
            return (
              <button
                type="button"
                key={d.arn}
                className={`devpick__card${isSel ? ' devpick__card--selected' : ''}`}
                aria-pressed={isSel}
                onClick={() => setPicked(d.arn!)}
                onDoubleClick={confirm}
              >
                <span className="devpick__card-name">{d.name}</span>
                <span className="devpick__card-badges">
                  <span className="devpick__badge">{d.platform === 'ios' ? 'iOS' : 'Android'} {d.os}</span>
                  {d.arch && <span className="devpick__badge">{d.arch}</span>}
                  {d.availability === 'HIGHLY_AVAILABLE' && (
                    <span className="devpick__badge devpick__badge--ok">{t('device.highlyAvailable')}</span>
                  )}
                </span>
                {specs.length > 0 && <span className="devpick__card-meta">{specs.join(' · ')}</span>}
              </button>
            );
          })}

          {filtered.length === 0 && <p className="devpick__empty">{t('device.noResults')}</p>}
        </div>

        <div className="devpick__foot">
          <button type="button" className="devpick__btn" onClick={onClose}>
            {t('device.cancel')}
          </button>
          <button type="button" className="devpick__btn devpick__btn--primary" onClick={confirm}>
            {t('device.confirm')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
