import { useEffect, useRef, useState } from 'react';
import { apiGet, apiPost, uploadToS3, type ListResponse, type UploadTarget } from '../../api/client.ts';
import { sortByRecommend, starLabel } from '../modelRecommend.ts';
import {
  type AcceptanceItemDraft,
  type DraftSpec,
  emptyAcceptanceItem,
  findVagueness,
  pickDraftModelDefault,
  sampleAcceptanceItems,
} from './acceptanceSpec.ts';
import './AcceptanceEditor.css';

interface ModelEntry {
  modelId: string;
  displayName: string;
  unavailable?: string;
  pricing?: { inputPerM: number; outputPerM: number; estimated?: boolean };
}

/** 上傳截圖大小上限(5MB)。 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

type Lang = 'zh' | 'en';

// 本地雙語字串(與同目錄的 ExcelImport 一致,避免為此編輯器大量擴充中央 i18n 目錄)。
const T = {
  intro: [
    '像填寫測試案例表一樣,一列一個測試項目。AI 會逐列對照「預期結果」判定,全部判完就停 —— 不會只憑一段文字一直測下去。',
    'Fill it like a test-case sheet: one row per item. The AI judges each row against its expected result and stops once all are done — no more endless testing from a vague paragraph.',
  ],
  model: ['產生腳本的模型', 'Drafting model'],
  note: ['備註(Markdown,可收合)', 'Notes (Markdown, collapsible)'],
  noteHint: ['補充背景、前置條件、注意事項…(支援 Markdown)', 'Background, preconditions, caveats… (Markdown)'],
  tableTitle: ['測試項目', 'Test items'],
  colNo: ['#', '#'],
  colCategory: ['類別', 'Category'],
  colModule: ['項目', 'Item'],
  colPurpose: ['測試目的', 'Purpose'],
  colSteps: ['步驟', 'Steps'],
  colExpected: ['預期結果', 'Expected result'],
  colImage: ['截圖', 'Screenshot'],
  categoryHint: ['中央畫面區', 'Lobby'],
  moduleHint: ['神秘商人', 'Mystery merchant'],
  purposeHint: ['X 鈕關閉', 'Close with X'],
  stepsHint: ['1. …\n2. …', '1. …\n2. …'],
  expectedHint: ['1. …\n2. …', '1. …\n2. …'],
  upload: ['上傳', 'Upload'],
  uploading: ['上傳中…', 'Uploading…'],
  replace: ['更換', 'Replace'],
  removeImage: ['移除截圖', 'Remove'],
  imageTip: ['上傳與此項相關的畫面,幫助 AI 理解要測什麼', 'Upload a related screenshot to help the AI understand this item'],
  addRow: ['新增一列', 'Add row'],
  sample: ['帶入範例', 'Insert example'],
  removeRow: ['刪除此列', 'Delete row'],
  tooLarge: ['截圖過大(上限 5MB)', 'Image too large (max 5MB)'],
  uploadError: ['截圖上傳失敗,請再試一次', 'Upload failed, please retry'],
  warnTitle: ['可以更精準:', 'Could be more precise:'],
  warnNoItems: [
    '尚未填寫任何測試項目;可先按「帶入範例」看看格式,或「新增一列」開始填。',
    'No test items yet; try “Insert example” to see the format, or “Add row” to start.',
  ],
  warnMissing: ['缺少 測試目的 / 步驟 / 預期結果', 'is missing purpose / steps / expected result'],
  warnVague: [
    '的預期結果較模糊(如「正常」「正確」),建議寫成可明確判定的描述,或上傳截圖',
    'has a vague expected result (e.g. “normal”); make it checkable or attach a screenshot',
  ],
  row: ['第', 'Row'],
  rowSuffix: ['列', ''],
} as const;

interface Props {
  lang: Lang;
  value: DraftSpec;
  onChange: (next: DraftSpec) => void;
}

/**
 * 結構化測試項目編輯器 —— 刻意做成大家熟悉的「測試案例表」:一列一項,
 * 欄位 類別 / 項目 / 測試目的 / 步驟 / 預期結果 / 截圖。另含模型選擇、可收合備註、精準度提示。
 * 自成一體(自行抓 /models?seat=agent、自行處理截圖上傳),父元件只需保存 DraftSpec。
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
    onChange({ ...value, acceptance: items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)) });
  }
  function addItem() {
    onChange({ ...value, acceptance: [...items, emptyAcceptanceItem()] });
  }
  function insertSample() {
    onChange({ ...value, acceptance: [...items, ...sampleAcceptanceItems(lang)] });
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
      <p className="acc__intro">{tx('intro')}</p>

      {/* 進階設定:模型 + 備註(次要,放在表格上方一行,保持精簡) */}
      <div className="acc__meta">
        <label className="acc__model">
          <span className="acc__meta-label">{tx('model')}</span>
          <select value={value.model} onChange={(e) => onChange({ ...value, model: e.target.value })}>
            {models.length === 0 && <option value="">—</option>}
            {models.map((m) => (
              <option key={m.modelId} value={m.modelId} disabled={!!m.unavailable} title={m.unavailable ?? ''}>
                {starLabel('agent', m.modelId, modelOptionLabel(m))}
              </option>
            ))}
          </select>
        </label>
      </div>
      <details className="acc__note">
        <summary>{tx('note')}</summary>
        <textarea
          rows={4}
          value={value.note}
          placeholder={tx('noteHint')}
          onChange={(e) => onChange({ ...value, note: e.target.value })}
        />
      </details>

      {/* 測試項目表(主角) */}
      <div className="acc__table-head">
        <span className="acc__meta-label">{tx('tableTitle')}</span>
        <span className="acc__table-actions">
          <button type="button" className="acc__btn acc__btn--ghost" onClick={insertSample}>
            {tx('sample')}
          </button>
          <button type="button" className="acc__btn" onClick={addItem}>
            + {tx('addRow')}
          </button>
        </span>
      </div>

      {items.length > 0 && (
        <div className="acc__table-wrap">
          <table className="acc__table">
            <thead>
              <tr>
                <th className="acc__c-no">{tx('colNo')}</th>
                <th className="acc__c-cat">{tx('colCategory')}</th>
                <th className="acc__c-mod">{tx('colModule')}</th>
                <th className="acc__c-pur">{tx('colPurpose')}</th>
                <th className="acc__c-step">{tx('colSteps')}</th>
                <th className="acc__c-exp">{tx('colExpected')}</th>
                <th className="acc__c-img">{tx('colImage')}</th>
                <th className="acc__c-del" aria-label="" />
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={i}>
                  <td className="acc__c-no">{i + 1}</td>
                  <td className="acc__c-cat">
                    <input value={it.category} placeholder={tx('categoryHint')} onChange={(e) => setItem(i, { category: e.target.value })} />
                  </td>
                  <td className="acc__c-mod">
                    <input value={it.module} placeholder={tx('moduleHint')} onChange={(e) => setItem(i, { module: e.target.value })} />
                  </td>
                  <td className="acc__c-pur">
                    <input value={it.purpose} placeholder={tx('purposeHint')} onChange={(e) => setItem(i, { purpose: e.target.value })} />
                  </td>
                  <td className="acc__c-step">
                    <textarea rows={3} value={it.steps} placeholder={tx('stepsHint')} onChange={(e) => setItem(i, { steps: e.target.value })} />
                  </td>
                  <td className="acc__c-exp">
                    <textarea rows={3} value={it.expected} placeholder={tx('expectedHint')} onChange={(e) => setItem(i, { expected: e.target.value })} />
                  </td>
                  <td className="acc__c-img">
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
                    {it.expectedImagePreview ? (
                      <div className="acc__img-cell">
                        <img className="acc__thumb" src={it.expectedImagePreview} alt={it.expectedImageName ?? ''} />
                        <div className="acc__img-cell-actions">
                          <button type="button" className="acc__link" disabled={uploading.has(i)} onClick={() => fileInputs.current[i]?.click()}>
                            {uploading.has(i) ? tx('uploading') : tx('replace')}
                          </button>
                          <button
                            type="button"
                            className="acc__link acc__link--danger"
                            onClick={() => setItem(i, { expectedImage: undefined, expectedImagePreview: undefined, expectedImageName: undefined })}
                          >
                            {tx('removeImage')}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="acc__btn acc__btn--ghost acc__btn--sm"
                        title={tx('imageTip')}
                        disabled={uploading.has(i)}
                        onClick={() => fileInputs.current[i]?.click()}
                      >
                        {uploading.has(i) ? tx('uploading') : `+ ${tx('upload')}`}
                      </button>
                    )}
                  </td>
                  <td className="acc__c-del">
                    <button type="button" className="acc__row-del" title={tx('removeRow')} aria-label={tx('removeRow')} onClick={() => removeItem(i)}>
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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
                    ? `${tx('row')} ${f.index} ${tx('rowSuffix')} ${tx('warnMissing')}`
                    : `${tx('row')} ${f.index} ${tx('rowSuffix')} ${tx('warnVague')}`}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
