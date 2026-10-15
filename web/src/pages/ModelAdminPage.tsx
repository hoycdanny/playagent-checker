import { useCallback, useEffect, useMemo, useState, Fragment } from 'react';
import { apiGet, apiPut } from '../api/client.ts';
import { useAuth } from '../auth/AuthProvider.tsx';
import { useI18n } from '../i18n/I18nProvider.tsx';
import './ListPage.css';
import './ModelAdminPage.css';

type Seat = 'agent' | 'vlm' | 'subagent' | 'draft';
const SEATS: Seat[] = ['agent', 'vlm', 'subagent', 'draft'];
type SortKey = 'name' | 'price' | Seat;

interface ModelRow {
  modelId: string;
  displayName: string;
  provider: string;
  channel: string;
  coordSystem: string;
  image: boolean;
  text: boolean;
  onDemand: boolean;
  pricing: { inputPerM: number; outputPerM: number; estimated?: boolean };
  seats: Seat[];
}
interface UnpricedRow {
  modelId: string;
  displayName: string;
  provider: string;
  image: boolean;
}
interface ScanResponse {
  models: ModelRow[];
  unpriced: UnpricedRow[];
  config: { updatedAt: string; updatedBy: string } | null;
}

/** 每個座位允許勾選的前提:vlm 需看圖,其餘需文字輸出。 */
function seatAllowed(seat: Seat, m: { image: boolean; text: boolean }): boolean {
  return seat === 'vlm' ? m.image : m.text;
}

export default function ModelAdminPage() {
  const { locale } = useI18n();
  const { isAdmin } = useAuth();
  const T = text(locale);

  const [models, setModels] = useState<ModelRow[]>([]);
  const [unpriced, setUnpriced] = useState<UnpricedRow[]>([]);
  const [config, setConfig] = useState<ScanResponse['config']>(null);
  const [sel, setSel] = useState<Record<string, Partial<Record<Seat, boolean>>>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [onlyChecked, setOnlyChecked] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 });
  const [expanded, setExpanded] = useState<Set<string>>(new Set()); // 預設全部收合

  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const r = await apiGet<ScanResponse>('/model-admin');
      setModels(r.models);
      setUnpriced(r.unpriced);
      setConfig(r.config);
      const next: Record<string, Partial<Record<Seat, boolean>>> = {};
      for (const m of r.models) {
        if (m.seats.length) next[m.modelId] = Object.fromEntries(m.seats.map((s) => [s, true]));
      }
      setSel(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAdmin) void load();
  }, [isAdmin, load]);

  const toggle = (modelId: string, seat: Seat) =>
    setSel((prev) => {
      const row = { ...(prev[modelId] ?? {}) };
      row[seat] = !row[seat];
      return { ...prev, [modelId]: row };
    });

  const counts = useMemo(() => {
    const c: Record<Seat, number> = { agent: 0, vlm: 0, subagent: 0, draft: 0 };
    for (const row of Object.values(sel)) for (const s of SEATS) if (row[s]) c[s]++;
    return c;
  }, [sel]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return models.filter((m) => {
      if (onlyChecked && !SEATS.some((s) => sel[m.modelId]?.[s])) return false;
      if (!q) return true;
      return (
        m.displayName.toLowerCase().includes(q) ||
        m.modelId.toLowerCase().includes(q) ||
        m.provider.toLowerCase().includes(q)
      );
    });
  }, [models, filter, onlyChecked, sel]);

  const sorted = useMemo(() => {
    const arr = [...shown];
    const { key, dir } = sort;
    arr.sort((a, b) => {
      let r = 0;
      if (key === 'name') r = a.displayName.localeCompare(b.displayName) || a.provider.localeCompare(b.provider);
      else if (key === 'price') r = a.pricing.inputPerM - b.pricing.inputPerM;
      else r = (sel[b.modelId]?.[key] ? 1 : 0) - (sel[a.modelId]?.[key] ? 1 : 0);
      return r * dir;
    });
    return arr;
  }, [shown, sort, sel]);
  const toggleSort = (key: SortKey) =>
    setSort((p) => (p.key === key ? { key, dir: (p.dir === 1 ? -1 : 1) as 1 | -1 } : { key, dir: 1 }));
  const mark = (key: SortKey) => (sort.key === key ? (sort.dir === 1 ? ' ▲' : ' ▼') : '');

  // 依廠家分組(組內維持目前排序;組依廠家名排序)。
  const groups = useMemo(() => {
    const map = new Map<string, ModelRow[]>();
    for (const m of sorted) {
      const arr = map.get(m.provider) ?? [];
      arr.push(m);
      map.set(m.provider, arr);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [sorted]);
  // 搜尋時一律展開(讓結果看得到);否則依使用者的展開狀態。預設全收合。
  const searching = filter.trim().length > 0;
  const isOpen = (prov: string) => searching || expanded.has(prov);
  const toggleProvider = (prov: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(prov)) next.delete(prov); else next.add(prov);
      return next;
    });
  const expandAll = () => setExpanded(new Set(groups.map((g) => g[0])));
  const collapseAll = () => setExpanded(new Set());
  const groupSummary = (rows: ModelRow[]) => {
    const img = rows.some((r) => r.image);
    const txt = rows.some((r) => r.text);
    const ins = rows.map((r) => r.pricing.inputPerM);
    const outs = rows.map((r) => r.pricing.outputPerM);
    const rng = (a: number[]) => {
      const lo = Math.min(...a), hi = Math.max(...a);
      return lo === hi ? `$${lo.toFixed(2)}` : `$${lo.toFixed(2)}–$${hi.toFixed(2)}`;
    };
    const picked = rows.filter((r) => SEATS.some((s) => sel[r.modelId]?.[s])).length;
    return { img, txt, price: `${rng(ins)} / ${rng(outs)}`, picked };
  };

  async function onSave() {
    setError(null);
    setNotice(null);
    setSaving(true);
    try {
      const selections: Record<string, Seat[]> = {};
      for (const [modelId, row] of Object.entries(sel)) {
        const seats = SEATS.filter((s) => row[s]);
        if (seats.length) selections[modelId] = seats;
      }
      const r = await apiPut<{ ok: boolean; count: number }>('/model-admin', { selections });
      setNotice(T.saved.replace('{n}', String(r.count)));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (!isAdmin) {
    return (
      <section className="listpage listpage--wide">
        <header className="listpage__header"><h1 className="listpage__title">{T.title}</h1></header>
        <div className="listpage__empty"><p>{T.adminOnly}</p></div>
      </section>
    );
  }

  const price = (m: ModelRow) =>
    `$${m.pricing.inputPerM.toFixed(2)} / $${m.pricing.outputPerM.toFixed(2)}${m.pricing.estimated ? '*' : ''}`;

  return (
    <section className="listpage listpage--wide">
      <header className="listpage__header">
        <h1 className="listpage__title">{T.title}</h1>
        <div className="modeladmin__head-actions">
          <button type="button" className="modeladmin__refresh" onClick={() => void load()} disabled={loading || saving}>
            {T.refresh}
          </button>
          <button type="button" className="modeladmin__save" onClick={() => void onSave()} disabled={loading || saving}>
            {saving ? T.saving : T.save}
          </button>
        </div>
      </header>

      <p className="modeladmin__intro">{T.intro}</p>
      {config && <p className="modeladmin__muted">{T.lastSaved.replace('{who}', config.updatedBy).replace('{when}', new Date(config.updatedAt).toLocaleString())}</p>}

      {error && <p className="modeladmin__error" role="alert">{error}</p>}
      {notice && <p className="modeladmin__ok" role="status">{notice}</p>}

      <div className="modeladmin__toolbar">
        <input
          className="modeladmin__search"
          value={filter}
          placeholder={T.searchPlaceholder}
          onChange={(e) => setFilter(e.target.value)}
          aria-label={T.searchPlaceholder}
        />
        <label className="modeladmin__only">
          <input type="checkbox" checked={onlyChecked} onChange={(e) => setOnlyChecked(e.target.checked)} />
          {T.onlyChecked}
        </label>
        <button type="button" className="modeladmin__ghost" onClick={expandAll}>{T.expandAll}</button>
        <button type="button" className="modeladmin__ghost" onClick={collapseAll}>{T.collapseAll}</button>
        <span className="modeladmin__counts">
          {T.colAgent}: {counts.agent} · {T.colVlm}: {counts.vlm} · {T.colSub}: {counts.subagent} · {T.colDraft}: {counts.draft}
        </span>
      </div>

      {loading ? (
        <p className="modeladmin__muted">{T.loading}</p>
      ) : (
        <div className="modeladmin__tablewrap">
          <table className="modeladmin__table">
            <thead>
              <tr>
                <th className="modeladmin__sortable" onClick={() => toggleSort('name')}>{T.thModel}{mark('name')}</th>
                <th>{T.thCaps}</th>
                <th className="modeladmin__sortable" onClick={() => toggleSort('price')}>{T.thPrice}{mark('price')}</th>
                <th className="modeladmin__c modeladmin__sortable" onClick={() => toggleSort('agent')}>{T.colAgent}{mark('agent')}</th>
                <th className="modeladmin__c modeladmin__sortable" onClick={() => toggleSort('vlm')}>{T.colVlm}{mark('vlm')}</th>
                <th className="modeladmin__c modeladmin__sortable" onClick={() => toggleSort('subagent')}>{T.colSub}{mark('subagent')}</th>
                <th className="modeladmin__c modeladmin__sortable" onClick={() => toggleSort('draft')}>{T.colDraft}{mark('draft')}</th>
              </tr>
            </thead>
            <tbody>
              {groups.map(([prov, rows]) => {
                const g = groupSummary(rows);
                const open = isOpen(prov);
                return (
                  <Fragment key={prov}>
                    <tr className="modeladmin__grouprow" onClick={() => toggleProvider(prov)}>
                      <td colSpan={7}>
                        <span className="modeladmin__caret">{open ? '▼' : '▶'}</span>
                        <strong>{prov}</strong> <span className="modeladmin__muted">({rows.length})</span>
                        {g.img && <span className="modeladmin__tag modeladmin__tag--img">{T.capImage}</span>}
                        {g.txt && <span className="modeladmin__tag">{T.capText}</span>}
                        <span className="modeladmin__grange">{g.price}</span>
                        {g.picked > 0 && <span className="modeladmin__picked">✓{g.picked}</span>}
                      </td>
                    </tr>
                    {open && rows.map((m) => (
                      <tr key={m.modelId}>
                        <td>
                          <div className="modeladmin__name modeladmin__indent">{m.displayName}</div>
                          <div className="modeladmin__id">{m.provider} · <code>{m.modelId}</code></div>
                        </td>
                        <td>
                          {m.image && <span className="modeladmin__tag modeladmin__tag--img">{T.capImage}</span>}
                          {m.text && <span className="modeladmin__tag">{T.capText}</span>}
                          <span className="modeladmin__tag modeladmin__tag--muted">{m.coordSystem === 'pixel' ? T.coordPixel : T.coordNorm}</span>
                        </td>
                        <td className="modeladmin__price">{price(m)}</td>
                        {SEATS.map((s) => (
                          <td key={s} className="modeladmin__c">
                            <input
                              type="checkbox"
                              checked={Boolean(sel[m.modelId]?.[s])}
                              disabled={!seatAllowed(s, m)}
                              onChange={() => toggle(m.modelId, s)}
                              aria-label={`${m.displayName} ${s}`}
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
              {groups.length === 0 && (
                <tr><td colSpan={7} className="modeladmin__muted">{T.noMatch}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* 掃描到但查無單價 → 已隱藏(不可選)。列出讓管理者知道有哪些新模型待定價。 */}
      {unpriced.length > 0 && (
        <details className="modeladmin__unpriced">
          <summary>{T.unpricedTitle.replace('{n}', String(unpriced.length))}</summary>
          <p className="modeladmin__muted">{T.unpricedNote}</p>
          <ul>
            {unpriced.map((u) => (
              <li key={u.modelId}>
                {u.displayName} <span className="modeladmin__muted">({u.provider})</span> <code>{u.modelId}</code>
                {u.image && <span className="modeladmin__tag modeladmin__tag--img">{T.capImage}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/** [繁中, English, 简中, 日本語, 한국어] */
type L5 = readonly [string, string, string, string, string];
const IDX: Record<string, number> = { 'zh-Hant': 0, en: 1, 'zh-Hans': 2, ja: 3, ko: 4 };
const pick = (t: L5, i: number) => t[i] ?? t[1];

function text(locale: string) {
  const i = IDX[locale] ?? 1;
  const S = {
    title: ['模型管理', 'Model admin', '模型管理', 'モデル管理', '모델 관리'] as L5,
    adminOnly: ['這頁只有管理員能看。', 'Admins only.', '这页只有管理员能看。', '管理者のみ利用できます。', '관리자만 사용할 수 있습니다.'] as L5,
    intro: [
      '掃描帳號當前可用的 Bedrock 模型,勾選哪些要出現在各下拉。只列出查得到官方單價的模型(查無價的已隱藏,見下方)。勾選後按「儲存」。',
      'Scan the Bedrock models available to this account and pick which appear in each dropdown. Only models with an official price are listed (unpriced ones are hidden, see below). Click Save when done.',
      '扫描账号当前可用的 Bedrock 模型,勾选哪些要出现在各下拉。只列出查得到官方单价的模型(查无价的已隐藏,见下方)。勾选后按「保存」。',
      'アカウントで利用可能な Bedrock モデルをスキャンし、各ドロップダウンに表示するものを選びます。公式価格があるモデルのみ表示(価格不明は非表示、下記参照)。選択後「保存」を押してください。',
      '계정에서 사용 가능한 Bedrock 모델을 스캔하여 각 드롭다운에 표시할 항목을 선택합니다. 공식 가격이 있는 모델만 표시됩니다(가격 없는 항목은 숨김, 아래 참조). 선택 후 저장하세요.',
    ] as L5,
    lastSaved: ['上次儲存:{when} · {who}', 'Last saved: {when} · {who}', '上次保存:{when} · {who}', '前回の保存:{when} · {who}', '마지막 저장: {when} · {who}'] as L5,
    refresh: ['重新掃描', 'Rescan', '重新扫描', '再スキャン', '다시 스캔'] as L5,
    save: ['儲存', 'Save', '保存', '保存', '저장'] as L5,
    saving: ['儲存中…', 'Saving…', '保存中…', '保存中…', '저장 중…'] as L5,
    saved: ['已儲存({n} 個模型已啟用)。', 'Saved ({n} models enabled).', '已保存({n} 个模型已启用)。', '保存しました({n} モデルを有効化)。', '저장됨({n}개 모델 활성화).'] as L5,
    loading: ['掃描中…', 'Scanning…', '扫描中…', 'スキャン中…', '스캔 중…'] as L5,
    searchPlaceholder: ['搜尋模型 / 供應商 / id', 'Search model / provider / id', '搜索模型 / 供应商 / id', 'モデル / プロバイダー / id を検索', '모델 / 공급자 / id 검색'] as L5,
    onlyChecked: ['只顯示已勾選', 'Only checked', '只显示已勾选', '選択済みのみ', '선택된 항목만'] as L5,
    expandAll: ['全部展開', 'Expand all', '全部展开', 'すべて展開', '모두 펼치기'] as L5,
    collapseAll: ['全部收合', 'Collapse all', '全部收合', 'すべて折りたたむ', '모두 접기'] as L5,
    noMatch: ['沒有符合的模型。', 'No matching models.', '没有符合的模型。', '一致するモデルがありません。', '일치하는 모델이 없습니다.'] as L5,
    thModel: ['模型', 'Model', '模型', 'モデル', '모델'] as L5,
    thCaps: ['能力', 'Capabilities', '能力', '機能', '기능'] as L5,
    thPrice: ['單價(進/出 每百萬)', 'Price (in/out per M)', '单价(进/出 每百万)', '価格(入/出 100万あたり)', '가격(입력/출력 100만당)'] as L5,
    colAgent: ['控制遊戲', 'Game control', '控制游戏', 'ゲーム操作', '게임 제어'] as L5,
    colVlm: ['分析畫面', 'Screen analysis', '分析画面', '画面分析', '화면 분석'] as L5,
    colSub: ['子代理', 'Subagent', '子代理', 'サブエージェント', '서브에이전트'] as L5,
    colDraft: ['測試腳本', 'Test script', '测试脚本', 'テストスクリプト', '테스트 스크립트'] as L5,
    capImage: ['看圖', 'Vision', '看图', '画像', '비전'] as L5,
    capText: ['文字', 'Text', '文字', 'テキスト', '텍스트'] as L5,
    coordPixel: ['像素座標', 'pixel coords', '像素座标', 'ピクセル座標', '픽셀 좌표'] as L5,
    coordNorm: ['千分制座標', '0–1000 coords', '千分制座标', '0〜1000 座標', '0–1000 좌표'] as L5,
    unpricedTitle: ['偵測到 {n} 個尚未定價的模型(已隱藏)', '{n} detected models without a price (hidden)', '检测到 {n} 个尚未定价的模型(已隐藏)', '価格未設定のモデル {n} 件を検出(非表示)', '가격 없는 모델 {n}개 감지됨(숨김)'] as L5,
    unpricedNote: [
      '這些模型掃描得到但單價表還沒有,為了讓花費與預算準確,暫時不開放勾選。把官方單價補進 pricing 表後就會自動出現在上方清單。',
      'These models were scanned but are not in the price table yet. To keep cost and budget accurate, they are not selectable. Add their official price to the pricing table and they appear in the list above.',
      '这些模型扫描得到但单价表还没有,为了让花费与预算准确,暂时不开放勾选。把官方单价补进 pricing 表后就会自动出现在上方清单。',
      'これらはスキャンされましたが価格表に未登録です。コストと予算を正確に保つため選択できません。公式価格を価格表に追加すると上の一覧に表示されます。',
      '스캔되었지만 가격표에 없는 모델입니다. 비용과 예산 정확성을 위해 선택할 수 없습니다. 공식 가격을 가격표에 추가하면 위 목록에 표시됩니다.',
    ] as L5,
  };
  return {
    title: pick(S.title, i), adminOnly: pick(S.adminOnly, i), intro: pick(S.intro, i),
    lastSaved: pick(S.lastSaved, i), refresh: pick(S.refresh, i), save: pick(S.save, i),
    saving: pick(S.saving, i), saved: pick(S.saved, i), loading: pick(S.loading, i),
    searchPlaceholder: pick(S.searchPlaceholder, i), onlyChecked: pick(S.onlyChecked, i), noMatch: pick(S.noMatch, i),
    expandAll: pick(S.expandAll, i), collapseAll: pick(S.collapseAll, i),
    thModel: pick(S.thModel, i), thCaps: pick(S.thCaps, i), thPrice: pick(S.thPrice, i),
    colAgent: pick(S.colAgent, i), colVlm: pick(S.colVlm, i), colSub: pick(S.colSub, i), colDraft: pick(S.colDraft, i),
    capImage: pick(S.capImage, i), capText: pick(S.capText, i), coordPixel: pick(S.coordPixel, i), coordNorm: pick(S.coordNorm, i),
    unpricedTitle: pick(S.unpricedTitle, i), unpricedNote: pick(S.unpricedNote, i),
  };
}
