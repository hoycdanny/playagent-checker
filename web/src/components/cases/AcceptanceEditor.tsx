import { useEffect, useRef, useState } from 'react';
import { apiGet, apiPost, uploadToS3, type ListResponse, type UploadTarget } from '../../api/client.ts';
import { recommendStyle, sortByRecommend, starLabel } from '../modelRecommend.ts';
import {
  type AcceptanceItemDraft,
  type DraftSpec,
  emptyAcceptanceItem,
  findVagueness,
  pickDraftModelDefault,
  sampleAcceptanceItems,
} from './acceptanceSpec.ts';
import { pick5 } from '../../i18n/locale5.ts';
import type { RLang } from '../report/reportText.ts';
import './AcceptanceEditor.css';
import { formatPerM } from '../modelPrice.ts';

interface ModelEntry {
  modelId: string;
  displayName: string;
  unavailable?: string;
  pricing?: { inputPerM: number; outputPerM: number; estimated?: boolean };
  recommended?: boolean;
}

/** 上傳截圖大小上限(5MB)。 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;


// 本地雙語字串(與同目錄的 ExcelImport 一致,避免為此編輯器大量擴充中央 i18n 目錄)。
const T = {
  intro: [
    '像填寫測試案例表一樣,一列一個測試項目。AI 會逐列對照「預期結果」判定,全部判完就停 —— 不會只憑一段文字一直測下去。',
    'Fill it like a test-case sheet: one row per item. The AI judges each row against its expected result and stops once all are done — no more endless testing from a vague paragraph.', '像填写测试用例表一样,一列一个测试项目。AI 会逐列对照「预期结果」判定,全部判完就停 —— 不会只凭一段文本一直测下去。', 'テストケース表のように、1 行に 1 つのテスト項目を記入します。AI は行ごとに「期待結果」と照らして判定し、すべて判定し終えたら停止します。一段落の文章だけでテストし続けることはありません。', '테스트 케이스 표처럼 한 행에 테스트 항목 하나를 적습니다. AI는 행마다 \'기대 결과\'와 대조해 판정하고, 모두 판정하면 멈춥니다. 문장 한 단락만 보고 계속 테스트하지 않습니다.',
  ],
  model: ['產生腳本的模型', 'Drafting model', '产生脚本的模型', 'スクリプト生成モデル', '스크립트 생성 모델'],
  note: ['備註(Markdown,可收合)', 'Notes (Markdown, collapsible)', '备注(Markdown,可收合)', '備考(Markdown、折りたたみ可)', '비고(Markdown, 접기 가능)'],
  noteHint: ['補充背景、前置條件、注意事項…(支援 Markdown)', 'Background, preconditions, caveats… (Markdown)', '补充背景、前置条件、注意事项…(支持 Markdown)', '背景、前提条件、注意事項を補足…(Markdown 対応)', '배경, 사전 조건, 주의 사항 보충… (Markdown 지원)'],
  tableTitle: ['測試項目', 'Test items', '测试项目', 'テスト項目', '테스트 항목'],
  colNo: ['#', '#', '#', '#', '#'],
  colCategory: ['類別', 'Category', '类别', '分類', '분류'],
  colModule: ['項目', 'Item', '项目', '項目', '항목'],
  colPurpose: ['測試目的', 'Purpose', '测试目的', 'テスト目的', '테스트 목적'],
  colSteps: ['步驟', 'Steps', '步骤', 'ステップ', '단계'],
  colExpected: ['預期結果', 'Expected result', '预期结果', '期待結果', '기대 결과'],
  colImage: ['截圖', 'Screenshot', '截图', 'スクリーンショット', '스크린샷'],
  categoryHint: ['中央畫面區', 'Lobby', '中央画面区', '中央の画面エリア', '중앙 화면 영역'],
  moduleHint: ['神秘商人', 'Mystery merchant', '神秘商人', 'ミステリー商人', '미스터리 상인'],
  purposeHint: ['X 鈕關閉', 'Close with X', 'X 按钮关闭', 'X ボタンで閉じる', 'X 버튼으로 닫기'],
  stepsHint: ['1. …\n2. …', '1. …\n2. …', '1. …\n2. …', '1. …\n2. …', '1. …\n2. …'],
  expectedHint: ['1. …\n2. …', '1. …\n2. …', '1. …\n2. …', '1. …\n2. …', '1. …\n2. …'],
  upload: ['上傳', 'Upload', '上传', 'アップロード', '업로드'],
  uploading: ['上傳中…', 'Uploading…', '上传中…', 'アップロード中…', '업로드하는 중…'],
  replace: ['更換', 'Replace', '更换', '置き換え', '바꾸기'],
  removeImage: ['移除截圖', 'Remove', '移除截图', 'スクリーンショットを削除', '스크린샷 삭제'],
  imageTip: ['上傳與此項相關的畫面,幫助 AI 理解要測什麼', 'Upload a related screenshot to help the AI understand this item', '上传与此项相关的画面,帮助 AI 理解要测什么', 'この項目に関連する画面をアップロードすると、AI がテスト内容を理解しやすくなります', '이 항목과 관련된 화면을 업로드하면 AI가 테스트할 내용을 이해하는 데 도움이 됩니다'],
  addRow: ['新增一列', 'Add row', '添加一列', '行を追加', '행 추가'],
  sample: ['帶入範例', 'Insert example', '带入范例', '例を挿入', '예시 넣기'],
  removeRow: ['刪除此列', 'Delete row', '删除此列', 'この行を削除', '이 행 삭제'],
  tooLarge: ['截圖過大(上限 5MB)', 'Image too large (max 5MB)', '截图过大(上限 5MB)', 'スクリーンショットが大きすぎます(上限 5MB)', '스크린샷이 너무 큽니다(최대 5MB)'],
  uploadError: ['截圖上傳失敗,請再試一次', 'Upload failed, please retry', '截图上传失败,请再试一次', 'スクリーンショットのアップロードに失敗しました。もう一度お試しください', '스크린샷 업로드에 실패했습니다. 다시 시도해 주세요'],
  warnTitle: ['可以更精準:', 'Could be more precise:', '可以更精准:', 'より正確にできます:', '더 정확하게 쓸 수 있습니다:'],
  warnNoItems: [
    '尚未填寫任何測試項目;可先按「帶入範例」看看格式,或「新增一列」開始填。',
    'No test items yet; try “Insert example” to see the format, or “Add row” to start.', '尚未填写任何测试项目;可先按「带入范例」看看格式,或「添加一列」开始填。', 'テスト項目がまだ入力されていません。まず「例を挿入」で形式を確認するか、「行を追加」で入力を始めてください。', '아직 입력된 테스트 항목이 없습니다. 먼저 \'예시 넣기\'로 형식을 확인하거나 \'행 추가\'로 입력을 시작하세요.',
  ],
  warnMissing: ['缺少 測試目的 / 步驟 / 預期結果', 'is missing purpose / steps / expected result', '缺少 测试目的 / 步骤 / 预期结果', 'テスト目的 / ステップ / 期待結果 が不足しています', '테스트 목적 / 단계 / 기대 결과가 빠져 있습니다'],
  warnVague: [
    '的預期結果較模糊(如「正常」「正確」),建議寫成可明確判定的描述,或上傳截圖',
    'has a vague expected result (e.g. “normal”); make it checkable or attach a screenshot', '的预期结果较模糊(如「正常」「正确」),建议写成可明确判定的描述,或上传截图', 'の期待結果が曖昧です(例:「正常」「正しい」)。明確に判定できる記述にするか、スクリーンショットを添付してください', '의 기대 결과가 모호합니다(예: \'정상\', \'올바름\'). 명확하게 판정할 수 있는 서술로 쓰거나 스크린샷을 첨부하세요',
  ],
  rowN: ['第 {n} 列', 'Row {n}', '第 {n} 列', '{n} 行目', '{n}행'],
} as const;

interface Props {
  lang: RLang;
  value: DraftSpec;
  onChange: (next: DraftSpec) => void;
}

/**
 * 結構化測試項目編輯器 —— 刻意做成大家熟悉的「測試案例表」:一列一項,
 * 欄位 類別 / 項目 / 測試目的 / 步驟 / 預期結果 / 截圖。另含模型選擇、可收合備註、精準度提示。
 * 自成一體(自行抓 /models?seat=agent、自行處理截圖上傳),父元件只需保存 DraftSpec。
 */
export function AcceptanceEditor({ lang, value, onChange }: Props) {
  const tx = (k: keyof typeof T) => pick5(T[k], lang);
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [uploading, setUploading] = useState<Set<number>>(new Set());
  const [imgError, setImgError] = useState<string | null>(null);
  const fileInputs = useRef<Array<HTMLInputElement | null>>([]);

  // 草擬模型清單:agent seat(具備足夠能力的文字/多模態模型),預設挑 Sonnet。
  useEffect(() => {
    apiGet<ListResponse<ModelEntry>>('/models?seat=draft')
      .then((r) => {
        const sorted = sortByRecommend('agent', r.items);
        setModels(sorted);
        if (!value.model) {
          onChange({ ...value, model: sorted.find((m) => m.recommended)?.modelId ?? pickDraftModelDefault(sorted.map((m) => m.modelId)) });
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
    const fmt = formatPerM;
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
              <option key={m.modelId} value={m.modelId} disabled={!!m.unavailable} title={m.unavailable ?? ''} style={recommendStyle(m)}>
                {starLabel('agent', m, modelOptionLabel(m))}
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
                    ? `${tx('rowN').replace('{n}', String(f.index))} ${tx('warnMissing')}`
                    : `${tx('rowN').replace('{n}', String(f.index))} ${tx('warnVague')}`}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
