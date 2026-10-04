/**
 * 證據協議(Device Farm / Web runner 共用)。
 *
 * engine 依「類型知識庫(GenreProfile)+ KB 報告規格」組出 context.json.evidence:
 *   { profiles, modules:[{id,label}], mechanics:[{id,label}], observe:[{key,hint,type}] }
 * runner 把它轉成 prompt 段落,要求 AI 每步回報 Expected / 上一步 Assertion / 信心 /
 * 模組與機制標註 / 畫面觀測值 / 看得到的遊戲缺陷。
 *
 * 原則:AI 只負責「觀察與標註」;成功率、Crash、RTP、覆蓋率、放行判定全部由報告引擎
 * (infra/lambda/api/report)以程式計算。看不到的值一律省略,不准猜。
 */

/** 依證據協議產生 prompt 段落。 */
export function evidencePromptSection(ev, { subject = '遊戲' } = {}) {
  const modules = Array.isArray(ev?.modules) ? ev.modules : [];
  const mechanics = Array.isArray(ev?.mechanics) ? ev.mechanics : [];
  const observe = Array.isArray(ev?.observe) ? ev.observe : [];
  const list = (arr) => arr.map((m) => `${m.id}=${m.label}`).join('、');
  return (
    `\n\n【測試證據回報|每步都要,務必簡短】在同一個 JSON 另外加這些欄位:` +
    `"expect":"這個動作預期造成的畫面結果(20 字內)";` +
    `"prev":"pass|fail|unclear"(上一步的 expect 在這張新畫面是否達成;第一步省略);` +
    `"conf":0~1(你對本步畫面判斷與座標的信心);` +
    `"target":"本步要操作的元件上的文字或簡稱(如 PLAY、Spin、返回、設定齒輪;wait 時省略)";` +
    (modules.length ? `"module":"目前畫面所屬模組 id,從這些選:${list(modules)}";` : '') +
    (mechanics.length ? `"mechanic":"本步在測的機制 id(沒有就省略),從這些選:${list(mechanics)}";` : '') +
    (observe.length
      ? `"obs":{只填畫面上「清楚看得到」的值,看不到就省略該 key,絕對不要猜:${observe
          .map((o) => `${o.key}(${o.hint}${o.type === 'boolean' ? ',true/false' : o.type === 'number' ? ',純數字' : ''})`)
          .join('、')}};`
      : '') +
    `"issue":{"cat":"crash|functional|gameplay|graphics|animation|audio|ui|ux|performance|network|localization|compatibility|physics|save_data|economy","sev":"critical|high|medium|low","title":"30 字內","box":[x1,y1,x2,y2]}` +
    `——只有在畫面上明確看到「${subject}本身」的缺陷時才填(如文字溢出/截斷、UI 重疊或被裁切、貼圖缺失/破圖、黑畫面、錯誤訊息、數值明顯算錯、按了正確按鈕卻沒反應);` +
    `你自己點錯位置、載入中、正常的公告/活動彈窗都【不是】缺陷,不要填 issue。`
  );
}

/**
 * 從模型決策中取出證據欄位並做型別/長度清洗(模型可能回字串數字、過長文字)。
 * runner 覆寫了動作時(aiAction !== cmd.action 或有 override),expect 不再對應實際動作,不保留。
 */
export function evidenceFields(cmd, aiAction) {
  const out = {};
  const str = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : undefined);
  const expect = str(cmd.expect, 120);
  if (expect && aiAction === cmd.action && !cmd.override) out.expect = expect;
  const prev = typeof cmd.prev === 'string' ? cmd.prev.toLowerCase() : cmd.prev;
  if (prev === 'pass' || prev === 'fail' || prev === 'unclear') out.prevResult = prev;
  else if (prev === true) out.prevResult = 'pass';
  else if (prev === false) out.prevResult = 'fail';
  const conf = Number(cmd.conf);
  if (cmd.conf !== undefined && cmd.conf !== null && Number.isFinite(conf)) out.conf = Math.max(0, Math.min(1, conf > 1 ? conf / 100 : conf));
  const module = str(cmd.module, 40);
  if (module) out.module = module;
  const target = str(cmd.target, 40);
  if (target && !cmd.override) out.target = target;
  const mechanic = str(cmd.mechanic, 40);
  if (mechanic) out.mechanic = mechanic;
  if (cmd.obs && typeof cmd.obs === 'object' && !Array.isArray(cmd.obs)) {
    const obs = {};
    for (const [k, v] of Object.entries(cmd.obs)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(k) || v === null || v === undefined || v === '') continue;
      if (typeof v === 'boolean') obs[k] = v;
      else if (typeof v === 'number' && Number.isFinite(v)) obs[k] = v;
      else if (typeof v === 'string') {
        const n = Number(v.replace(/[,%\s]/g, ''));
        obs[k] = Number.isFinite(n) && /^[\d,.\s-]+%?$/.test(v) ? n : v.slice(0, 40);
      }
    }
    if (Object.keys(obs).length) out.obs = obs;
  }
  if (cmd.issue && typeof cmd.issue === 'object' && str(cmd.issue.title, 120)) {
    const issue = { cat: str(cmd.issue.cat, 20), sev: str(cmd.issue.sev, 10), title: str(cmd.issue.title, 120) };
    if (Array.isArray(cmd.issue.box) && cmd.issue.box.length === 4 && cmd.issue.box.every((n) => Number.isFinite(Number(n)))) {
      issue.box = cmd.issue.box.map((n) => Math.round(Number(n)));
    }
    out.issue = issue;
  }
  return out;
}
