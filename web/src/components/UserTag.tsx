import { useState } from 'react';
import { useI18n } from '../i18n/I18nProvider.tsx';
import { loc5, pick5, type L5 } from '../i18n/locale5.ts';
import { shortUser } from './userLabel.ts';
import './UserTag.css';

const COPY: L5 = ['點一下複製', 'Click to copy', '点一下复制', 'クリックでコピー', '클릭하여 복사'];
const COPIED: L5 = ['已複製', 'Copied', '已复制', 'コピーしました', '복사됨'];
/**
 * 「誰做的」小標籤:顯示短名,滑過 / 聚焦看完整 email,點一下複製完整識別(追蹤用)。
 * 沒有使用者(舊資料)時不顯示任何東西。
 */
export default function UserTag({ user, prefix }: { user?: string | null; prefix?: string }) {
  const { locale } = useI18n();
  const loc = loc5(locale);
  const [copied, setCopied] = useState(false);
  const full = (user ?? '').trim();
  if (!full) return null;
  const label = `${prefix ? `${prefix} ` : ''}${full}`;
  return (
    <button
      type="button"
      className="usertag"
      title={`${label}\n${pick5(COPY, loc)}`}
      aria-label={`${label} (${pick5(COPY, loc)})`}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        void navigator.clipboard?.writeText(full).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      <span className="usertag__icon" aria-hidden="true">👤</span>
      <span className="usertag__name">{shortUser(full)}</span>
      {copied && <span className="usertag__ok" role="status">{pick5(COPIED, loc)}</span>}
    </button>
  );
}
