import { useState } from 'react';
import './CopyId.css';

/**
 * 識別碼小標籤(等寬字,點一下複製)。
 *
 * 任務列表原本完全不顯示任務編號 —— 它只存在於每列連結的網址裡,所以使用者拿到一個
 * jobId 之後在畫面上既搜不到也看不到。這個標籤把編號攤在列上,並且可以直接複製去
 * 貼給別人或丟進搜尋框。
 */
export default function CopyId({
  value,
  title,
  copiedLabel,
}: {
  value?: string;
  /** 滑過的提示(呼叫端給已翻譯的字)。 */
  title: string;
  /** 複製成功的提示(呼叫端給已翻譯的字)。 */
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  return (
    <button
      type="button"
      className="copyid"
      title={title}
      aria-label={`${value} — ${title}`}
      onClick={(e) => {
        // 整列是可點的連結(進任務詳情),複製不該順便跳頁。
        e.stopPropagation();
        e.preventDefault();
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      <span className="copyid__value">{value}</span>
      {copied && (
        <span className="copyid__ok" role="status">
          {copiedLabel}
        </span>
      )}
    </button>
  );
}
