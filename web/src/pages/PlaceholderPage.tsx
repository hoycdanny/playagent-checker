import { useI18n } from '../i18n/I18nProvider.tsx';
import type { MessageKey } from '../i18n/messages.ts';
import './ListPage.css';

/**
 * 尚未接後端的功能頁骨架:只顯示標題與空狀態(對應後續階段才建的端點)。
 * 讓導覽此刻即可完整點擊,不會 404 或空白。
 */
export function PlaceholderPage({
  titleKey,
  emptyKey,
}: {
  titleKey: MessageKey;
  emptyKey: MessageKey;
}) {
  const { t } = useI18n();
  return (
    <section className="listpage">
      <header className="listpage__header">
        <h1 className="listpage__title">{t(titleKey)}</h1>
      </header>
      <div className="listpage__empty">
        <p>{t(emptyKey)}</p>
      </div>
    </section>
  );
}
