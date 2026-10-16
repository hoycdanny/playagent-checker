import { useState } from 'react';
import { useI18n } from '../i18n/I18nProvider.tsx';
import { shortUser } from './userLabel.ts';
import './UserTag.css';

/**
 * 「誰做的」小標籤:顯示短名,滑過 / 聚焦看完整 email,點一下複製完整識別(追蹤用)。
 * 沒有使用者(舊資料)時不顯示任何東西。
 */
export default function UserTag({ user, prefix }: { user?: string | null; prefix?: string }) {
  const { locale } = useI18n();
  const zh = locale !== 'en';
  const [copied, setCopied] = useState(false);
  const full = (user ?? '').trim();
  if (!full) return null;
  const label = `${prefix ? `${prefix} ` : ''}${full}`;
  return (
    <button
      type="button"
      className="usertag"
      title={`${label}\n${zh ? '點一下複製' : 'Click to copy'}`}
      aria-label={`${label}${zh ? '(點一下複製)' : ' (click to copy)'}`}
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
      {copied && <span className="usertag__ok" role="status">{zh ? '已複製' : 'Copied'}</span>}
    </button>
  );
}
