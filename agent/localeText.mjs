/**
 * 產生文字的語系支援(runner 共用)。
 *
 * - languageDirective(locale):附加在 prompt 尾端的語言指示。zh-Hant / 未設定 / 未知語系回空字串,
 *   讓既有任務的 prompt 與改版前逐位元相同。
 * - runnerText(locale, key, params):runner 自己寫進 step.thinking 的固定句子。zh-Hant 回傳與舊程式
 *   完全相同的字串;報告引擎比對用的機器前綴([記憶腳本]、[SPIN 迴圈]、無法解析回應、模型呼叫失敗、
 *   [戰鬥強制走位]、[走位被擋改向])在所有語系都留在最前面,只翻譯其後的文字。
 */

/** 非 zh-Hant 語系的名稱(原生名 + 英文名,讓模型不會誤判)。 */
export const LOCALE_LANGUAGE = {
  en: 'English',
  'zh-Hans': '简体中文 (Simplified Chinese)',
  ja: '日本語 (Japanese)',
  ko: '한국어 (Korean)',
};

export function languageDirective(locale) {
  const name = typeof locale === 'string' && Object.hasOwn(LOCALE_LANGUAGE, locale) ? LOCALE_LANGUAGE[locale] : '';
  if (!name) return '';
  return (
    `\n\n[Output language] Write every free-text value you produce (thinking, screen, memo, seen, goal, strategy, note, reason, summary, issue title) in ${name}. ` +
    `Keep JSON keys, action names, element ids, enum values and any text quoted from the screen unchanged.`
  );
}

const T = (zhHant, en, zhHans, ja, ko) => ({ 'zh-Hant': zhHant, en, 'zh-Hans': zhHans, ja, ko });

/** key → locale → (params) => string。 */
export const RUNNER_TEXT = {
  parseFail: T(
    () => '無法解析回應,等待後重試',
    () => '無法解析回應 | Could not parse the response; waiting and retrying',
    () => '無法解析回應 | 无法解析响应,等待后重试',
    () => '無法解析回應 | 応答を解析できません。待機して再試行します',
    () => '無法解析回應 | 응답을 해석할 수 없습니다. 대기 후 다시 시도합니다',
  ),
  parseFailJson: T(
    () => '無法解析回應 JSON,等待後重試',
    () => '無法解析回應 JSON | Could not parse the response JSON; waiting and retrying',
    () => '無法解析回應 JSON | 无法解析响应 JSON,等待后重试',
    () => '無法解析回應 JSON | 応答の JSON を解析できません。待機して再試行します',
    () => '無法解析回應 JSON | 응답 JSON을 해석할 수 없습니다. 대기 후 다시 시도합니다',
  ),
  modelFail: T(
    (p) => `模型呼叫失敗:${p.message}`,
    (p) => `模型呼叫失敗 | Model call failed: ${p.message}`,
    (p) => `模型呼叫失敗 | 模型调用失败:${p.message}`,
    (p) => `模型呼叫失敗 | モデル呼び出しに失敗: ${p.message}`,
    (p) => `模型呼叫失敗 | 모델 호출 실패: ${p.message}`,
  ),
  takeover: T(
    (p) => `測試人員接管:${p.kind}`,
    (p) => `Tester took over: ${p.kind}`,
    (p) => `测试人员接管:${p.kind}`,
    (p) => `テスト担当者が操作を引き継ぎました: ${p.kind}`,
    (p) => `테스터가 직접 조작: ${p.kind}`,
  ),
  memWait: T(
    (p) => `[記憶腳本] 等「${p.name}」載入(${p.n}/6)。`,
    (p) => `[記憶腳本] Waiting for "${p.name}" to load (${p.n}/6).`,
    (p) => `[記憶腳本] 等待「${p.name}」加载(${p.n}/6)。`,
    (p) => `[記憶腳本] 「${p.name}」の読み込みを待機中(${p.n}/6)。`,
    (p) => `[記憶腳本] "${p.name}" 로딩 대기 중(${p.n}/6).`,
  ),
  memStill: T(
    () => '[記憶腳本] 畫面還沒反應,再等一下。',
    () => '[記憶腳本] The screen has not reacted yet; waiting a bit more.',
    () => '[記憶腳本] 画面还没反应,再等一下。',
    () => '[記憶腳本] 画面がまだ反応しません。もう少し待ちます。',
    () => '[記憶腳本] 화면이 아직 반응하지 않습니다. 조금 더 기다립니다.',
  ),
  spinLoop: T(
    (p) => `[SPIN 迴圈] 第 ${p.round}/${p.of} 局:照記憶點「${p.target}」。`,
    (p) => `[SPIN 迴圈] Round ${p.round}/${p.of}: tapping the remembered spot "${p.target}".`,
    (p) => `[SPIN 迴圈] 第 ${p.round}/${p.of} 局:按记忆点「${p.target}」。`,
    (p) => `[SPIN 迴圈] 第 ${p.round}/${p.of} ラウンド: 記憶した「${p.target}」を押します。`,
    (p) => `[SPIN 迴圈] ${p.round}/${p.of}번째 판: 기억한 "${p.target}" 위치를 누릅니다.`,
  ),
  spinLoopNav: T(
    (p) => `[SPIN 迴圈] 第 ${p.round}/${p.of} 局:照記憶點「${p.target}」(導航腳本挑到的同一顆 SPIN)。`,
    (p) => `[SPIN 迴圈] Round ${p.round}/${p.of}: tapping the remembered spot "${p.target}" (the same SPIN the navigation script picked).`,
    (p) => `[SPIN 迴圈] 第 ${p.round}/${p.of} 局:按记忆点「${p.target}」(导航脚本选中的同一个 SPIN)。`,
    (p) => `[SPIN 迴圈] 第 ${p.round}/${p.of} ラウンド: 記憶した「${p.target}」を押します(ナビゲーションスクリプトが選んだ同じ SPIN)。`,
    (p) => `[SPIN 迴圈] ${p.round}/${p.of}번째 판: 기억한 "${p.target}" 위치를 누릅니다(내비게이션 스크립트가 고른 동일한 SPIN).`,
  ),
  memNav: T(
    (p) => `[記憶腳本] 認出「${p.name}」→ ${p.action}「${p.target}」前往「${p.to}」(${p.how};${p.trust})。`,
    (p) => `[記憶腳本] Recognized "${p.name}" -> ${p.action} "${p.target}" to reach "${p.to}" (${p.how}; ${p.trust}).`,
    (p) => `[記憶腳本] 识别出「${p.name}」→ ${p.action}「${p.target}」前往「${p.to}」(${p.how};${p.trust})。`,
    (p) => `[記憶腳本] 「${p.name}」を認識 → ${p.action}「${p.target}」で「${p.to}」へ移動(${p.how}; ${p.trust})。`,
    (p) => `[記憶腳本] "${p.name}" 인식 → ${p.action} "${p.target}" 로 "${p.to}" 이동(${p.how}; ${p.trust}).`,
  ),
  battleMove: T(
    (p) => `[戰鬥強制走位] 偵測到戰鬥畫面,角色必須持續移動躲怪。原動作(${p.action})改為 move dir=${p.dir} 走位。`,
    (p) => `[戰鬥強制走位] Battle screen detected; the character must keep moving to dodge. Original action (${p.action}) replaced with move dir=${p.dir}.`,
    (p) => `[戰鬥強制走位] 检测到战斗画面,角色必须持续移动躲避怪物。原动作(${p.action})改为 move dir=${p.dir} 走位。`,
    (p) => `[戰鬥強制走位] 戦闘画面を検出。キャラは動き続けて敵を避ける必要があります。元の操作(${p.action})を move dir=${p.dir} に変更。`,
    (p) => `[戰鬥強制走位] 전투 화면을 감지했습니다. 캐릭터는 계속 움직여 몬스터를 피해야 합니다. 원래 동작(${p.action})을 move dir=${p.dir} 로 변경.`,
  ),
  blockedMove: T(
    (p) => `[走位被擋改向] 上一步往 ${p.from} 背景沒有移動(被障礙物擋住),改往 ${p.to}。`,
    (p) => `[走位被擋改向] The background did not move when heading ${p.from} (blocked by an obstacle); turning to ${p.to}.`,
    (p) => `[走位被擋改向] 上一步往 ${p.from} 背景没有移动(被障碍物挡住),改往 ${p.to}。`,
    (p) => `[走位被擋改向] 前の ${p.from} 方向では背景が動きませんでした(障害物に阻まれた)。${p.to} へ向きを変えます。`,
    (p) => `[走位被擋改向] 이전에 ${p.from} 방향으로 갔지만 배경이 움직이지 않았습니다(장애물에 막힘). ${p.to} 방향으로 바꿉니다.`,
  ),
  factsChanged: T(
    (p) => `數值有變化(${p.keys})`,
    (p) => `Values changed (${p.keys})`,
    (p) => `数值有变化(${p.keys})`,
    (p) => `数値が変化しました(${p.keys})`,
    (p) => `수치가 변경되었습니다(${p.keys})`,
  ),
  stuckBand: T(
    (p) => `連續 ${p.n} 步畫面沒變,掃描中下段主按鈕帶 y=${p.pct}% 脫困`,
    (p) => `The screen has not changed for ${p.n} steps; scanning the lower-middle main-button band at y=${p.pct}% to get unstuck`,
    (p) => `连续 ${p.n} 步画面没变,扫描中下段主按钮带 y=${p.pct}% 脱困`,
    (p) => `${p.n} ステップ連続で画面が変わりません。下中段のメインボタン帯 y=${p.pct}% を試して抜け出します`,
    (p) => `${p.n}단계 연속으로 화면이 바뀌지 않았습니다. 중하단 주요 버튼 영역 y=${p.pct}% 를 시도해 빠져나옵니다`,
  ),
  stuckBack: T(
    (p) => `連續 ${p.n} 步畫面沒變,用 back 脫困`,
    (p) => `The screen has not changed for ${p.n} steps; pressing back to get unstuck`,
    (p) => `连续 ${p.n} 步画面没变,用 back 脱困`,
    (p) => `${p.n} ステップ連続で画面が変わりません。back で抜け出します`,
    (p) => `${p.n}단계 연속으로 화면이 바뀌지 않았습니다. back 으로 빠져나옵니다`,
  ),
  stuckCorner: T(
    (p) => `連續 ${p.n} 步畫面沒變,點右上角(關閉鈕常在此)脫困`,
    (p) => `The screen has not changed for ${p.n} steps; tapping the top-right corner (where close buttons usually are) to get unstuck`,
    (p) => `连续 ${p.n} 步画面没变,点右上角(关闭按钮常在此)脱困`,
    (p) => `${p.n} ステップ連続で画面が変わりません。右上(閉じるボタンがよくある位置)をタップして抜け出します`,
    (p) => `${p.n}단계 연속으로 화면이 바뀌지 않았습니다. 오른쪽 위(닫기 버튼이 흔한 위치)를 눌러 빠져나옵니다`,
  ),
};

/** runner 自己寫的 step 文字;未知語系或未設定走 zh-Hant(與舊字串相同)。 */
export function runnerText(locale, key, params = {}) {
  const entry = RUNNER_TEXT[key];
  if (!entry) return '';
  const loc = typeof locale === 'string' && Object.hasOwn(entry, locale) ? locale : 'zh-Hant';
  return entry[loc](params);
}
