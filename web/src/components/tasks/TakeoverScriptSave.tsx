import { useState } from 'react';
import { apiPost } from '../../api/client.ts';
import { getTakeoverScript, type TakeoverScript } from '../../api/takeover.ts';
import { useI18n } from '../../i18n/I18nProvider.tsx';
import { loc5, pick5, type L5 } from '../../i18n/locale5.ts';

/**
 * 【AI 學習 B】把接管模式錄到的手動操作存成測試案例。
 *
 * 示範一次 → 之後每次自動跑。後端已經把操作序列轉成 YAML(takeoverScriptToYaml),
 * 這裡只負責讓使用者看過、命名、存檔 —— 刻意先讓他看到內容再存,因為錄製出來的步驟
 * 是座標式的,十之八九需要人改寫成元件描述才耐改版。
 */

const T = {
  title: ['把這次的手動操作存成測試案例', 'Save your manual steps as a test case', '把这次的手动操作存成测试案例', '手動操作をテストケースとして保存', '수동 조작을 테스트 케이스로 저장'] as L5,
  load: ['讀取錄到的操作', 'Load recorded steps', '读取录到的操作', '記録した操作を読み込む', '기록된 조작 불러오기'] as L5,
  loading: ['讀取中…', 'Loading…', '读取中…', '読み込み中…', '불러오는 중…'] as L5,
  none: ['這次測試沒有接管操作紀錄。先在即時畫面按手掌鈕接管並操作幾步。', 'No takeover steps recorded in this run. Take over on the live screen and do a few steps first.', '这次测试没有接管操作记录。先在实时画面按手掌钮接管并操作几步。', 'このテストには引き継ぎ操作の記録がありません。まずライブ画面で引き継いで操作してください。', '이 실행에는 인수 조작 기록이 없습니다. 먼저 라이브 화면에서 인수하여 조작하세요.'] as L5,
  nameLabel: ['案例名稱', 'Case name', '案例名称', 'ケース名', '케이스 이름'] as L5,
  countLabel: ['錄到 {n} 個操作', '{n} steps recorded', '录到 {n} 个操作', '{n} 件の操作を記録', '{n}개 조작 기록'] as L5,
  save: ['存成測試案例', 'Save as test case', '存成测试案例', 'テストケースとして保存', '테스트 케이스로 저장'] as L5,
  saving: ['儲存中…', 'Saving…', '储存中…', '保存中…', '저장 중…'] as L5,
  saved: ['已建立測試案例', 'Test case created', '已建立测试案例', 'テストケースを作成しました', '테스트 케이스를 만들었습니다'] as L5,
  failed: ['操作失敗,請再試一次', 'Something went wrong — try again', '操作失败,请再试一次', '失敗しました。もう一度お試しください', '실패했습니다. 다시 시도하세요'] as L5,
  noApp: ['這個任務沒有關聯的應用,無法建立案例', 'This task has no linked app, so a case cannot be created', '这个任务没有关联的应用,无法建立案例', 'このタスクにアプリが紐付いていないため作成できません', '이 작업에 연결된 앱이 없어 생성할 수 없습니다'] as L5,
  hint: [
    '錄到的步驟是「畫面百分比座標」,版面改動後可能失效。建議存檔後打開案例,把步驟改寫成以元件描述為主(例如「點擊『登入』按鈕」),會更耐改版。',
    'Recorded steps use screen-percentage coordinates and may break after layout changes. After saving, open the case and rewrite the steps to describe elements (e.g. "click the Login button") so they survive redesigns.',
    '录到的步骤是「画面百分比坐标」,版面改动后可能失效。建议存档后打开案例,把步骤改写成以元件描述为主,会更耐改版。',
    '記録された手順は画面の割合座標なので、レイアウト変更で失敗する可能性があります。保存後にケースを開き、要素の説明に書き換えることをおすすめします。',
    '기록된 단계는 화면 비율 좌표이므로 레이아웃 변경 시 실패할 수 있습니다. 저장 후 케이스를 열어 요소 설명으로 바꿔 쓰는 것을 권장합니다.',
  ] as L5,
} as const;

export function TakeoverScriptSave({ jobId, appId }: { jobId: string; appId?: string }) {
  const { locale } = useI18n();
  const L = loc5(locale);
  const tx = (k: keyof typeof T) => pick5(T[k], L);

  const [script, setScript] = useState<TakeoverScript | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [empty, setEmpty] = useState(false);
  const [done, setDone] = useState(false);
  const [failed, setFailed] = useState(false);

  async function load() {
    setBusy(true); setFailed(false); setEmpty(false);
    try {
      const s = await getTakeoverScript(jobId);
      setScript(s);
      setName(s.suggestedName);
    } catch (e) {
      // 後端在「沒有錄到操作」時回 404 —— 這是正常狀況,不該顯示成錯誤。
      if ((e as { status?: number })?.status === 404) setEmpty(true);
      else setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!script || !appId || !name.trim()) return;
    setBusy(true); setFailed(false);
    try {
      await apiPost('/cases', { app: appId, name: name.trim(), yaml: script.yaml });
      setDone(true);
    } catch { setFailed(true); } finally { setBusy(false); }
  }

  return (
    <section className="dstage__panel" aria-labelledby="tkscript-title">
      <h3 id="tkscript-title" className="detail__panel-title">{tx('title')}</h3>

      {!script && !empty && (
        <button type="button" className="btn" onClick={() => void load()} disabled={busy}>
          {busy ? tx('loading') : tx('load')}
        </button>
      )}

      {empty && <p className="devlogs__muted">{tx('none')}</p>}

      {script && (
        <>
          <p className="devlogs__muted">{tx('countLabel').replace('{n}', String(script.actions.length))}</p>
          <label className="field">
            <span className="field__label">{tx('nameLabel')}</span>
            <input className="field__input" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </label>
          {/* 先讓使用者看過再存:錄製出來的步驟多半需要改寫成元件描述。 */}
          <pre className="tkscript__yaml">{script.yaml}</pre>
          <p className="devlogs__muted">{tx('hint')}</p>
          {!done && (
            <button type="button" className="btn btn--primary" onClick={() => void save()} disabled={busy || !appId || !name.trim()}>
              {busy ? tx('saving') : tx('save')}
            </button>
          )}
          {!appId && <p className="devlogs__muted">{tx('noApp')}</p>}
          {done && <p role="status">{tx('saved')}</p>}
        </>
      )}

      {failed && <p role="alert">{tx('failed')}</p>}
    </section>
  );
}
