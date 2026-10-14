import { useEffect, useRef, useState } from 'react';
import { apiGet, apiPost, uploadToS3, type ListResponse, type UploadTarget } from '../../api/client.ts';
import { sortByRecommend, starLabel } from '../modelRecommend.ts';
import {
  type AcceptanceItemDraft,
  type DraftSpec,
  emptyAcceptanceItem,
  findVagueness,
  pickDraftModelDefault,
} from './acceptanceSpec.ts';
import './AcceptanceEditor.css';

interface ModelEntry {
  modelId: string;
  displayName: string;
  unavailable?: string;
  pricing?: { inputPerM: number; outputPerM: number; estimated?: boolean };
}

/** 上傳預期畫面大小上限(5MB)。 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

type Lang = 'zh' | 'en';

// 本地雙語字串(與同目錄的 ExcelImport 一致,避免為此編輯器大量擴充中央 i18n 目錄)。
const T = {
  model: ['產生腳本的模型', 'Model for drafting'],
  modelHint: ['挑選用來產生測試腳本的 AI 模型。', 'Pick the AI model that drafts the test script.'],
  acceptance: ['驗收標準(每項逐一判定)', 'Acceptance criteria (judged item by item)'],
  acceptanceHint: [
    '逐項填寫,AI 會逐條對照判定,全部判完即停止 —— 避免只給文字描述導致 AI 一直測下去。',
    'Fill each item in; the AI judges them one by one and stops once all are decided — so it will not keep testing forever.',
  ],
  purpose: ['測試目的', 'Purpose'],
  purposeHint: ['這一項要驗證什麼', 'What this item verifies'],
  steps: ['測試步驟(一行一步)', 'Steps (one per line)'],
  stepsHint: ['1. 點擊活動按鈕\n2. 於彈窗點 X 關閉', '1. Tap the event button\n2. Close the popup with X'],
  expected: ['預期結果', 'Expected result'],
  expectedHint: ['可明確判定的結果,例:彈出活動視窗且可用 X 關閉', 'A checkable result, e.g. a popup appears and closes via X'],
  expectedImage: ['預期畫面(選填)', 'Expected screenshot (optional)'],
  upload: ['上傳圖片', 'Upload image'],
  uploading: ['上傳中…', 'Uploading…'],
  replace: ['更換', 'Replace'],
  removeImage: ['移除圖片', 'Remove image'],
  addItem: ['新增驗收項目', 'Add acceptance item'],
  remove: ['移除', 'Remove'],
  item: ['項目', 'Item'],
  tooLarge: ['圖片過大(上限 5MB)', 'Image too large (max 5MB)'],
  uploadError: ['圖片上傳失敗,請再試一次', 'Image upload failed, please retry'],
  note: ['備註(Markdown,可收合)', 'Notes (Markdown, collapsible)'],
  noteHint: ['補充背景、前置條件、注意事項…(支援 Markdown)', 'Background, preconditions, caveats… (Markdown)'],
  warnTitle: ['驗收標準可以更精準:', 'Acceptance criteria could be more precise:'],
  warnNoItems: [
    '尚未填寫任何驗收項目;AI 可能漫無目的地一直測。建議至少新增一項明確的驗收標準。',
    'No acceptance items yet; the AI may test aimlessly. Add at least one clear criterion.',
  ],
  warnMissing: ['缺少測試目的 / 步驟 / 預期結果', 'is missing purpose / steps / expected result'],
  warnVague: [
    '的預期結果較模糊(如「正常」「正確」),建議改成可明確判定的描述,或附上預期畫面',
    'has a vague expected result (e.g. “normal”, “correct”); make it checkable or attach an expected screenshot',
  ],
} as const;

interface Props {
  lang: Lang;
  value: DraftSpec;
  onChange: (next: DraftSpec) => void;
}

/**
 * 結構化驗收標準編輯器:模型選擇 + 可收合 Markdown 備註 + 逐項(目的/步驟/預期/預期畫面)+ 精準度提示。
 * 自成一體(自行抓 /models?seat=agent、自行處理圖片上傳),父元件只需保存 DraftSpec。
 */
export function AcceptanceEditor({ lang, value, onChange }: Props) {
  const tx = (k: keyof typeof T) => T[k][lang === 'zh' ? 0 : 1];
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [uploading, setUploading] = useState<Set<number>>(new Set());
  const [imgError, setImgError] = useState<string | null>(null);
  const fileInputs = useRef<Array<HTMLInputElement | null>>([]);

  // 草擬模型清單:agent seat(具備足夠能力的文字/多模態模型),預設挑 Sonnet。
  useEffect(() => {
    apiGet<ListResponse<ModelEntry>>('/models?seat=agent')
      .then((r) => {
        const sorted = sortByRecommend('agent', r.items);
        setModels(sorted);
        if (!value.model) {
          onChange({ ...value, model: pickDraftModelDefault(sorted.map((m) => m.modelId)) });
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const items = value.acceptance;
  const vague = findVagueness(items);

  function setItem(i: number, patch: Partial<AcceptanceItemDraft>) {
    const next = items.map((it, idx) => (idx === i ? { ...it, ...patch } : it));
    onChange({ ...value, acceptance: next });
  }
  function addItem() {
    onChange({ ...value, acceptance: [...items, emptyAcceptanceItem()] });
  }
  function removeItem(i: number) {
    onChange({ ...value, acceptance: items.filter((_, idx) => idx !== i) });
  }

  async function onPickImage(i: number, file: File) {
    setImgError(null);
    if (!file.type.startsWith('image/')) return;
    if (file.size > MAX_IMAGE_BYTES) {
      setImgError(tx('tooLarge'));
      return;
    }
    setUploading((prev) => new Set(prev).add(i));
    try {
      const target = await apiPost<UploadTarget>('/uploads', { kind: 'png' });
      await uploadToS3(target.url, file);
      setItem(i, {
        expectedImage: target.artifactId,
        expectedImagePreview: URL.createObjectURL(file),
        expectedImageName: file.name,
      });
    } catch {
      setImgError(tx('uploadError'));
    } finally {
      setUploading((prev) => {
        const n = new Set(prev);
        n.delete(i);
        return n;
      });
    }
  }

  function modelOptionLabel(m: ModelEntry): string {
    if (!m.pricing) return m.displayName;
    const { inputPerM, outputPerM, estimated } = m.pricing;
    if (inputPerM === 0 && outputPerM === 0) return m.displayName;
    const fmt = (n: number) => `$${n.toFixed(2)}`;
    return `${m.displayName} — ${fmt(inputPerM)}/${fmt(outputPerM)}${estimated ? '*' : ''}`;
  }

  return (
    <div className="acc">
      {/* 產生腳本的模型 */}
      <label className="acc__model">
        <span className="cases__label">{tx('model')}</span>
        <select
          value={value.model}
          onChange={(e) => onChange({ ...value, model: e.target.value })}
        >
          {models.length === 0 && <option value="">—</option>}
          {models.map((m) => (
            <option key={m.modelId} value={m.modelId} disabled={!!m.unavailable} title={m.unavailable ?? ''}>
              {starLabel('agent', m.modelId, modelOptionLabel(m))}
            </option>
          ))}
        </select>
        <small style={{ color: 'var(--text-muted,#6b7280)', fontSize: '0.75rem' }}>{tx('modelHint')}</small>
      </label>

      {/* 可收合 Markdown 備註 */}
      <details className="acc__note">
        <summary>{tx('note')}</summary>
        <textarea
          rows={4}
          value={value.note}
          placeholder={tx('noteHint')}
          onChange={(e) => onChange({ ...value, note: e.target.value })}
        />
      </details>

      {/* 結構化驗收標準表 */}
      <div className="acc__field">
        <span className="cases__label">{tx('acceptance')}</span>
        <small style={{ color: 'var(--text-muted,#6b7280)', fontSize: '0.75rem' }}>{tx('acceptanceHint')}</small>
      </div>

      <div className="acc__items">
        {items.map((it, i) => (
          <div className="acc__item" key={i}>
            <div className="acc__item-head">
              <span className="acc__item-no">{tx('item')} {i + 1}</span>
              <button type="button" className="acc__remove" onClick={() => removeItem(i)}>
                {tx('remove')}
              </button>
            </div>
            <label className="acc__field">
              <span>{tx('purpose')}</span>
              <input
                value={it.purpose}
                placeholder={tx('purposeHint')}
                onChange={(e) => setItem(i, { purpose: e.target.value })}
              />
            </label>
            <label className="acc__field">
              <span>{tx('steps')}</span>
              <textarea
                rows={3}
                value={it.steps}
                placeholder={tx('stepsHint')}
                onChange={(e) => setItem(i, { steps: e.target.value })}
              />
            </label>
            <label className="acc__field">
              <span>{tx('expected')}</span>
              <textarea
                rows={2}
                value={it.expected}
                placeholder={tx('expectedHint')}
                onChange={(e) => setItem(i, { expected: e.target.value })}
              />
            </label>
            <div className="acc__field">
              <span>{tx('expectedImage')}</span>
              <div className="acc__img-row">
                {it.expectedImagePreview && (
                  <img className="acc__thumb" src={it.expectedImagePreview} alt={it.expectedImageName ?? ''} />
                )}
                <input
                  ref={(el) => {
                    fileInputs.current[i] = el;
                  }}
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void onPickImage(i, f);
                    e.target.value = '';
                  }}
                />
                <button
                  type="button"
                  className="acc__img-btn"
                  disabled={uploading.has(i)}
                  onClick={() => fileInputs.current[i]?.click()}
                >
                  {uploading.has(i) ? tx('uploading') : it.expectedImage ? tx('replace') : tx('upload')}
                </button>
                {it.expectedImage && !uploading.has(i) && (
                  <button
                    type="button"
                    className="acc__remove"
                    onClick={() =>
                      setItem(i, { expectedImage: undefined, expectedImagePreview: undefined, expectedImageName: undefined })
                    }
                  >
                    {tx('removeImage')}
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <button type="button" className="acc__add" onClick={addItem}>
        + {tx('addItem')}
      </button>

      {imgError && (
        <p className="cases__error" role="alert">
          {imgError}
        </p>
      )}

      {vague.length > 0 && (
        <div className="acc__warn" role="status">
          <strong>{tx('warnTitle')}</strong>
          <ul>
            {vague.map((f, k) => (
              <li key={k}>
                {f.kind === 'no-items'
                  ? tx('warnNoItems')
                  : f.kind === 'missing'
                    ? `${tx('item')} ${f.index} ${tx('warnMissing')}`
                    : `${tx('item')} ${f.index} ${tx('warnVague')}`}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
