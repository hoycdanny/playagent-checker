import { useEffect, useRef, useState, type FormEvent } from 'react';
import { apiDelete, apiGet, apiPut } from '../../api/client.ts';
import { useI18n } from '../../i18n/I18nProvider.tsx';
import SecretRefsPanel from '../secrets/SecretRefsPanel.tsx';
import './CredentialsPanel.css';

interface CredItem { key: string; visible: boolean }

/**
 * 應用工作區的「測試憑證」分頁。
 *
 * 版面:一張表(已設定的欄位)+ 表格最下面一列直接新增。
 * 「AI 看不看得到」用兩個選項說清楚(機密 / 選項),不再是一個勾選框加一大段說明。
 * 跨應用共用的機密引用(進階、少用)收進最下面的摺疊區。
 * 值只寫不讀:API 只回 {key, visible},前端永遠拿不到值。
 */
export function CredentialsPanel({ appId }: { appId: string }) {
  const { locale } = useI18n();
  const T = text(locale);
  const [items, setItems] = useState<CredItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const keyRef = useRef<HTMLInputElement>(null);
  const valueRef = useRef<HTMLInputElement>(null);

  function load() {
    apiGet<{ items: CredItem[] }>(`/apps/${encodeURIComponent(appId)}/credentials`)
      .then((r) => setItems(r.items ?? []))
      .catch(() => setItems([]))
      .finally(() => setLoaded(true));
  }
  useEffect(load, [appId]);

  const existing = items.find((i) => i.key === key.trim());

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const k = key.trim();
      await apiPut(`/apps/${encodeURIComponent(appId)}/credentials`, { key: k, value, visible });
      setNotice((existing ? T.updated : T.added).replace('{k}', k));
      setKey('');
      setValue('');
      setVisible(false);
      load();
      keyRef.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(k: string) {
    if (!window.confirm(T.confirmDelete.replace('{k}', k))) return;
    setError(null);
    try {
      await apiDelete(`/apps/${encodeURIComponent(appId)}/credentials?key=${encodeURIComponent(k)}`);
      setNotice(T.deleted.replace('{k}', k));
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  /** 「更換值」:把欄位名與類型帶進新增列,游標移到值。 */
  function onReplace(it: CredItem) {
    setKey(it.key);
    setVisible(it.visible);
    setValue('');
    setNotice(null);
    valueRef.current?.focus();
  }

  /** 常用欄位:一鍵帶入名稱(密碼類預設機密,伺服器類預設選項)。 */
  function quick(k: string, vis: boolean) {
    setKey(k);
    setVisible(vis);
    valueRef.current?.focus();
  }

  return (
    <div className="ws__panel cred">
      <div className="cred__intro">
        <p className="cred__lead">{T.lead}</p>
        <p className="ws__muted">{T.how}</p>
      </div>

      {error && <p className="listpage__error" role="alert">{error}</p>}
      {notice && <p className="cred__notice" role="status">{notice}</p>}

      <form onSubmit={onSave}>
        <table className="cred__table">
          <thead>
            <tr>
              <th scope="col">{T.colKey}</th>
              <th scope="col">{T.colValue}</th>
              <th scope="col">{T.colType}</th>
              <th scope="col"><span className="visually-hidden">{T.colActions}</span></th>
            </tr>
          </thead>
          <tbody>
            {loaded && items.length === 0 && (
              <tr><td colSpan={4} className="cred__empty">{T.empty}</td></tr>
            )}
            {items.map((it) => (
              <tr key={it.key}>
                <td><code className="cred__key">{it.key}</code></td>
                <td className="cred__masked" aria-label={T.hiddenValue}>••••••••</td>
                <td>
                  <span className={`cred__type cred__type--${it.visible ? 'option' : 'secret'}`}>
                    {it.visible ? T.typeOption : T.typeSecret}
                  </span>
                </td>
                <td className="cred__actions">
                  <button type="button" className="ws__secondary" onClick={() => onReplace(it)}>{T.replace}</button>
                  <button type="button" className="ws__remove" onClick={() => void onDelete(it.key)}>{T.remove}</button>
                </td>
              </tr>
            ))}

            {/* 新增 / 更換列 */}
            <tr className="cred__new">
              <td>
                <input
                  ref={keyRef}
                  required
                  value={key}
                  maxLength={64}
                  placeholder={T.keyPlaceholder}
                  aria-label={T.colKey}
                  onChange={(e) => setKey(e.target.value)}
                />
              </td>
              <td>
                <input
                  ref={valueRef}
                  required
                  type="password"
                  autoComplete="new-password"
                  value={value}
                  placeholder={existing ? T.newValuePlaceholder : T.valuePlaceholder}
                  aria-label={T.colValue}
                  onChange={(e) => setValue(e.target.value)}
                />
              </td>
              <td>
                <select value={visible ? 'option' : 'secret'} aria-label={T.colType} onChange={(e) => setVisible(e.target.value === 'option')}>
                  <option value="secret">{T.typeSecret}</option>
                  <option value="option">{T.typeOption}</option>
                </select>
              </td>
              <td className="cred__actions">
                <button type="submit" className="ws__primary" disabled={busy || !key.trim() || !value}>
                  {busy ? T.saving : existing ? T.saveReplace : T.add}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </form>

      <div className="cred__quick">
        <span className="ws__muted">{T.quick}</span>
        {T.quickItems.map(([k, vis]) => (
          <button key={k} type="button" className="cred__chip" onClick={() => quick(k, vis)}>+ {k}</button>
        ))}
      </div>

      <dl className="cred__legend">
        <div><dt><span className="cred__type cred__type--secret">{T.typeSecret}</span></dt><dd>{T.secretHelp}</dd></div>
        <div><dt><span className="cred__type cred__type--option">{T.typeOption}</span></dt><dd>{T.optionHelp}</dd></div>
      </dl>

      <p className="ws__muted cred__security">🔒 {T.security}</p>

      <details className="cred__advanced">
        <summary>{T.advanced}</summary>
        <p className="ws__muted">{T.advancedHelp}</p>
        <SecretRefsPanel />
      </details>
    </div>
  );
}

/** [繁中, English, 简中, 日本語, 한국어] */
type L5 = readonly [string, string, string, string, string];
const IDX: Record<string, number> = { 'zh-Hant': 0, en: 1, 'zh-Hans': 2, ja: 3, ko: 4 };

function text(locale: string) {
  const i = IDX[locale] ?? 1;
  const p = (t: L5) => t[i] ?? t[1];
  const S = {
    lead: ['遊戲需要登入時,把帳號密碼存在這裡。AI 遇到登入畫面會自己填,測試案例裡不用寫。', 'If the game needs a login, store the account and password here. The AI fills them in when it reaches a login screen; your test case does not need them.', '游戏需要登录时,把账号密码存在这里。AI 遇到登录画面会自己填,测试用例里不用写。', 'ゲームにログインが必要なら、アカウントとパスワードをここに保存します。AI がログイン画面で自動入力するので、テストケースに書く必要はありません。', '게임에 로그인이 필요하면 계정과 비밀번호를 여기에 저장하세요. AI가 로그인 화면에서 자동으로 입력하므로 테스트 케이스에 쓸 필요가 없습니다.'] as L5,
    how: ['一列一個欄位。欄位名稱用你看得懂的就好(例如「帳號」),AI 會依意思對到畫面上的輸入框。', 'One row per field. Use any name you understand (e.g. "account"); the AI matches it to the on-screen field by meaning.', '一行一个字段。字段名称用你看得懂的就好(例如「账号」),AI 会按意思对到画面上的输入框。', '1 行に 1 項目。項目名はわかりやすいもので構いません(例:「アカウント」)。AI が意味から画面の入力欄に対応付けます。', '한 행에 한 항목. 항목 이름은 알아보기 쉬운 것이면 됩니다(예: "계정"). AI가 의미로 화면의 입력란에 맞춥니다.'] as L5,
    colKey: ['欄位名稱', 'Field', '字段名称', '項目名', '항목'] as L5,
    colValue: ['值', 'Value', '值', '値', '값'] as L5,
    colType: ['AI 看得到嗎', 'Can the AI see it?', 'AI 看得到吗', 'AI に見せるか', 'AI에게 보이기'] as L5,
    colActions: ['操作', 'Actions', '操作', '操作', '작업'] as L5,
    hiddenValue: ['已儲存,值不會顯示', 'Saved; the value is never shown', '已保存,值不会显示', '保存済み(値は表示されません)', '저장됨(값은 표시되지 않음)'] as L5,
    typeSecret: ['🔒 機密(AI 看不到)', '🔒 Secret (hidden from AI)', '🔒 机密(AI 看不到)', '🔒 機密(AI から隠す)', '🔒 비밀(AI에게 숨김)'] as L5,
    typeOption: ['👁 選項(AI 看得到)', '👁 Option (AI can see)', '👁 选项(AI 看得到)', '👁 選択肢(AI に見せる)', '👁 선택지(AI가 봄)'] as L5,
    secretHelp: ['帳號、密碼都選這個。AI 只知道「有這個欄位」,打字的那一刻才由系統換成真正的值。', 'Use for accounts and passwords. The AI only knows the field exists; the real value is typed in by the system at the moment of input.', '账号、密码都选这个。AI 只知道「有这个字段」,打字的那一刻才由系统换成真正的值。', 'アカウントやパスワードはこちら。AI は項目があることだけを知り、入力の瞬間にシステムが実際の値に置き換えます。', '계정과 비밀번호는 이것을 선택하세요. AI는 항목이 있다는 것만 알고, 입력하는 순간 시스템이 실제 값으로 바꿉니다.'] as L5,
    optionHelp: ['AI 要從清單裡「挑出對的項目」時用,例如伺服器名稱、區域。AI 會看到這個值,所以不要放密碼。', 'Use when the AI must pick the right item from a list, e.g. a server name or region. The AI sees this value, so never use it for passwords.', 'AI 要从清单里「挑出对的项目」时用,例如服务器名称、区域。AI 会看到这个值,所以不要放密码。', 'AI が一覧から正しい項目を選ぶ必要があるとき(サーバー名、地域など)に使います。AI に値が見えるので、パスワードには使わないでください。', 'AI가 목록에서 올바른 항목을 골라야 할 때(서버 이름, 지역 등) 사용합니다. AI가 값을 보므로 비밀번호에는 쓰지 마세요.'] as L5,
    keyPlaceholder: ['例如:帳號', 'e.g. account', '例如:账号', '例:アカウント', '예: 계정'] as L5,
    valuePlaceholder: ['輸入值', 'Enter the value', '输入值', '値を入力', '값 입력'] as L5,
    newValuePlaceholder: ['輸入新的值', 'Enter the new value', '输入新的值', '新しい値を入力', '새 값 입력'] as L5,
    add: ['新增', 'Add', '新增', '追加', '추가'] as L5,
    saveReplace: ['更新', 'Update', '更新', '更新', '업데이트'] as L5,
    saving: ['儲存中…', 'Saving…', '保存中…', '保存中…', '저장 중…'] as L5,
    replace: ['更換值', 'Change value', '更换值', '値を変更', '값 변경'] as L5,
    remove: ['刪除', 'Delete', '删除', '削除', '삭제'] as L5,
    confirmDelete: ['確定刪除「{k}」?', 'Delete "{k}"?', '确定删除「{k}」?', '「{k}」を削除しますか?', '"{k}"을(를) 삭제할까요?'] as L5,
    added: ['已新增「{k}」。', 'Added "{k}".', '已新增「{k}」。', '「{k}」を追加しました。', '"{k}"을(를) 추가했습니다.'] as L5,
    updated: ['已更新「{k}」。', 'Updated "{k}".', '已更新「{k}」。', '「{k}」を更新しました。', '"{k}"을(를) 업데이트했습니다.'] as L5,
    deleted: ['已刪除「{k}」。', 'Deleted "{k}".', '已删除「{k}」。', '「{k}」を削除しました。', '"{k}"을(를) 삭제했습니다.'] as L5,
    empty: ['還沒有任何欄位。不需要登入的遊戲可以不填。', 'No fields yet. Games without a login can leave this empty.', '还没有任何字段。不需要登录的游戏可以不填。', 'まだ項目がありません。ログイン不要のゲームは空のままで構いません。', '아직 항목이 없습니다. 로그인이 필요 없는 게임은 비워 두어도 됩니다.'] as L5,
    quick: ['常用:', 'Common:', '常用:', 'よく使う項目:', '자주 쓰는 항목:'] as L5,
    security: ['值加密存在 AWS Secrets Manager,存好之後連你也看不到;不會出現在畫面、記錄、報告或執行軌跡。', 'Values are stored encrypted in AWS Secrets Manager and cannot be read back, even by you. They never appear on screen, in logs, reports, or the step trace.', '值加密存在 AWS Secrets Manager,存好之后连你也看不到;不会出现在画面、日志、报告或执行轨迹。', '値は AWS Secrets Manager に暗号化して保存され、保存後はあなたにも表示されません。画面・ログ・レポート・実行軌跡にも出ません。', '값은 AWS Secrets Manager에 암호화되어 저장되며 저장 후에는 본인도 볼 수 없습니다. 화면, 로그, 보고서, 실행 궤적에도 나타나지 않습니다.'] as L5,
    advanced: ['進階:所有應用共用的機密(多數情況用不到)', 'Advanced: secrets shared by all apps (rarely needed)', '进阶:所有应用共用的机密(多数情况用不到)', '詳細:全アプリ共通の機密(通常は不要)', '고급: 모든 앱이 공유하는 비밀(대부분 필요 없음)'] as L5,
    advancedHelp: ['同一組帳密要給很多個應用用時才需要,在測試案例裡用 ${鍵名} 引用。只給這個應用用的,用上面的表格就好。', 'Only needed when the same account is used by many apps; reference it in a test case as ${KEY}. For this app only, use the table above.', '同一组账密要给很多个应用用时才需要,在测试用例里用 ${键名} 引用。只给这个应用用的,用上面的表格就好。', '同じアカウントを多くのアプリで使う場合のみ必要です。テストケースでは ${キー名} で参照します。このアプリだけなら上の表を使ってください。', '같은 계정을 여러 앱에서 쓸 때만 필요하며, 테스트 케이스에서 ${키} 로 참조합니다. 이 앱 전용이면 위 표를 사용하세요.'] as L5,
  };
  const quickByLocale: Record<number, [string, boolean][]> = {
    0: [['帳號', false], ['密碼', false], ['伺服器名稱', true]],
    1: [['account', false], ['password', false], ['server name', true]],
    2: [['账号', false], ['密码', false], ['服务器名称', true]],
    3: [['アカウント', false], ['パスワード', false], ['サーバー名', true]],
    4: [['계정', false], ['비밀번호', false], ['서버 이름', true]],
  };
  const out = Object.fromEntries(Object.entries(S).map(([k, v]) => [k, p(v)])) as Record<keyof typeof S, string>;
  return { ...out, quickItems: quickByLocale[i] ?? quickByLocale[1]! };
}
