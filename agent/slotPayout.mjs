// 純函式老虎機機台設定、盤面正規化與 All-Ways 派彩基礎。

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

// VLM 標籤可能混有大小寫、全形字元、空白或標點，統一後才比對別名。
function normalizedLabel(value) {
  return typeof value === 'string'
    ? value.normalize('NFKC').trim().toLocaleLowerCase('en-US').replace(/[\s_-]+/gu, '').replace(/[^\p{L}\p{N}]/gu, '')
    : '';
}

function symbolIndex(profile) {
  const aliases = new Map();
  for (const symbol of profile.symbols || []) {
    aliases.set(normalizedLabel(symbol.id), symbol.id);
    for (const alias of symbol.aliases || []) aliases.set(normalizedLabel(alias), symbol.id);
  }
  return aliases;
}

/** 驗證機台設定；一次回報所有可發現的欄位問題。 */
export function validateMachineProfile(profile) {
  const errors = [];
  if (!isObject(profile)) return { ok: false, errors: ['profile 必須是物件'] };

  for (const field of ['schemaVersion', 'machineId', 'appId', 'appVersion']) {
    if (!isNonEmptyString(profile[field])) errors.push(`${field} 必須是非空字串`);
  }

  if (!isObject(profile.layout)) errors.push('layout 必須是物件');
  else {
    if (!Number.isInteger(profile.layout.reels) || profile.layout.reels <= 0) errors.push('layout.reels 必須是正整數');
    if (typeof profile.layout.variableRows !== 'boolean') errors.push('layout.variableRows 必須是布林值');
    if (profile.layout.ways !== true && profile.layout.ways !== 'all-ways') errors.push("layout.ways 必須是 true 或 'all-ways'");
  }

  const ids = new Set();
  const labels = new Map();
  if (!Array.isArray(profile.symbols)) errors.push('symbols 必須是陣列');
  else for (const [index, symbol] of profile.symbols.entries()) {
    if (!isObject(symbol) || !isNonEmptyString(symbol.id)) {
      errors.push(`symbols[${index}].id 必須是非空字串`);
      continue;
    }
    if (ids.has(symbol.id)) errors.push(`symbols 含重複 id: ${symbol.id}`);
    ids.add(symbol.id);
    if (symbol.aliases !== undefined && (!Array.isArray(symbol.aliases) || symbol.aliases.some((alias) => !isNonEmptyString(alias)))) {
      errors.push(`symbols[${index}].aliases 必須是非空字串陣列`);
    }
    for (const label of [symbol.id, ...(Array.isArray(symbol.aliases) ? symbol.aliases : [])]) {
      const normalized = normalizedLabel(label);
      const owner = labels.get(normalized);
      if (!normalized) errors.push(`symbols[${index}] 含無法正規化的 id/alias`);
      else if (owner && owner !== symbol.id) errors.push(`symbol id/alias 衝突: ${label}`);
      else labels.set(normalized, symbol.id);
    }
    if (symbol.wild !== undefined && typeof symbol.wild !== 'boolean') errors.push(`symbols[${index}].wild 必須是布林值`);
    if (symbol.scatter !== undefined && typeof symbol.scatter !== 'boolean') errors.push(`symbols[${index}].scatter 必須是布林值`);
  }

  const payKeys = new Set();
  if (!Array.isArray(profile.paytable)) errors.push('paytable 必須是陣列');
  else for (const [index, pay] of profile.paytable.entries()) {
    if (!isObject(pay)) {
      errors.push(`paytable[${index}] 必須是物件`);
      continue;
    }
    if (!isNonEmptyString(pay.symbol) || !ids.has(pay.symbol)) errors.push(`paytable[${index}].symbol 必須引用已知符號`);
    if (!Number.isInteger(pay.count) || pay.count <= 0) errors.push(`paytable[${index}].count 必須是正整數`);
    if (typeof pay.multiplier !== 'number' || !Number.isFinite(pay.multiplier) || pay.multiplier < 0) errors.push(`paytable[${index}].multiplier 必須是非負有限數`);
    const key = `${pay.symbol}\u0000${pay.count}`;
    if (payKeys.has(key)) errors.push(`paytable 含重複 symbol/count: ${pay.symbol}/${pay.count}`);
    payKeys.add(key);
  }

  if (!isObject(profile.rules)) errors.push('rules 必須是物件');
  else {
    if (profile.rules.consecutiveFromLeft !== true) errors.push('rules.consecutiveFromLeft 必須是 true');
    if (profile.rules.wildSubstitutes !== true) errors.push('rules.wildSubstitutes 必須是 true');
    if (profile.rules.scatterAnywhere !== undefined && profile.rules.scatterAnywhere !== true) errors.push('rules.scatterAnywhere 若提供必須是 true');
    if (!['total', 'perWay'].includes(profile.rules.betBasis)) errors.push("rules.betBasis 必須是 'total' 或 'perWay'");
    if (profile.rules.totalWays !== undefined && (!Number.isInteger(profile.rules.totalWays) || profile.rules.totalWays <= 0)) errors.push('rules.totalWays 必須是正整數');
  }

  if (!isObject(profile.provenance)) errors.push('provenance 必須是物件');
  else {
    if (!Array.isArray(profile.provenance.sourceScreenshots) || profile.provenance.sourceScreenshots.some((item) => !isNonEmptyString(item))) errors.push('provenance.sourceScreenshots 必須是非空字串陣列');
    if (profile.provenance.approvedBy !== undefined && !isNonEmptyString(profile.provenance.approvedBy)) errors.push('provenance.approvedBy 必須是非空字串');
    if (profile.provenance.approvedAt !== undefined && !isNonEmptyString(profile.provenance.approvedAt)) errors.push('provenance.approvedAt 必須是非空字串');
  }

  return { ok: errors.length === 0, errors };
}

/** 將 alias 轉成正式 symbol id，並驗證 reel 數與未知符號。 */
export function normalizeBoard(board, profile) {
  const profileResult = validateMachineProfile(profile);
  if (!profileResult.ok) return { ok: false, board: null, errors: profileResult.errors.map((error) => `profile: ${error}`) };
  const errors = [];
  if (!Array.isArray(board)) return { ok: false, board: null, errors: ['board 必須是 reel 陣列'] };
  if (board.length !== profile.layout.reels) errors.push(`board reel 數必須是 ${profile.layout.reels}`);
  const aliases = symbolIndex(profile);
  const normalizedBoard = board.map((reel, reelIndex) => {
    if (!Array.isArray(reel) || reel.length === 0) {
      errors.push(`board[${reelIndex}] 必須是非空符號陣列`);
      return [];
    }
    return reel.map((raw, rowIndex) => {
      const id = aliases.get(normalizedLabel(raw));
      if (!id) errors.push(`未知符號 board[${reelIndex}][${rowIndex}]: ${String(raw)}`);
      return id ?? null;
    });
  });
  return { ok: errors.length === 0, board: errors.length === 0 ? normalizedBoard : null, errors };
}

// 用十進位字串轉成分數，避免浮點誤差被誤當成「可整數派彩」。
function numberFraction(value) {
  const match = String(value).match(/^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);
  if (!match) return null;
  const sign = match[1] ? -1n : 1n;
  const fractionDigits = match[3] || '';
  const exponent = Number(match[4] || 0) - fractionDigits.length;
  let numerator = sign * BigInt(match[2] + fractionDigits);
  let denominator = 1n;
  if (exponent >= 0) numerator *= 10n ** BigInt(exponent);
  else denominator = 10n ** BigInt(-exponent);
  return { numerator, denominator };
}

function integralPayout(multiplier, bet, ways, divisor = 1) {
  const multiplierFraction = numberFraction(multiplier);
  const betFraction = numberFraction(bet);
  if (!multiplierFraction || !betFraction) return null;
  const numerator = multiplierFraction.numerator * betFraction.numerator * BigInt(ways);
  const denominator = multiplierFraction.denominator * betFraction.denominator * BigInt(divisor);
  if (numerator % denominator !== 0n) return null;
  const result = numerator / denominator;
  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < BigInt(Number.MIN_SAFE_INTEGER)) return null;
  return Number(result);
}

/**
 * 計算 All-Ways 派彩。
 * 保守規則：全程只由 wild 組成的組合只交給 wild 自己的 paytable；若 wild 沒有 paytable，
 * 該組合不派彩，不會把同一組合重複算到每個一般符號。
 */
export function evaluateAllWays({ board, bet, profile }) {
  const errors = [];
  if (profile?.provenance?.approved === false) errors.push('機台 profile 尚未人工核准,不可自動判定派彩');
  if (profile?.rules?.betBasis === 'total' && !Number.isInteger(profile?.rules?.totalWays)) errors.push('total bet basis 必須由已核准規則提供 rules.totalWays');
  if (typeof bet !== 'number' || !Number.isFinite(bet) || bet < 0) errors.push('bet 必須是非負有限數');
  const normalized = normalizeBoard(board, profile);
  if (!normalized.ok) errors.push(...normalized.errors);
  if (errors.length > 0) return { ok: false, expectedPayout: null, wins: [], errors };

  const normalizedBoard = normalized.board;
  const wildIds = new Set(profile.symbols.filter((symbol) => symbol.wild).map((symbol) => symbol.id));
  const scatterIds = new Set(profile.symbols.filter((symbol) => symbol.scatter).map((symbol) => symbol.id));
  const paySymbols = [...new Set(profile.paytable.map((pay) => pay.symbol))];
  const wins = [];
  let expectedPayout = 0;
  const totalWays = profile.rules.totalWays ?? normalizedBoard.reduce((product, reel) => product * reel.length, 1);

  for (const symbolId of paySymbols) {
    if (scatterIds.has(symbolId)) continue;
    const isWildPay = wildIds.has(symbolId);
    const matchCounts = [];
    const wildCounts = [];
    for (const reel of normalizedBoard) {
      const matches = reel.filter((id) => id === symbolId || (!isWildPay && wildIds.has(id))).length;
      if (matches === 0) break;
      matchCounts.push(matches);
      wildCounts.push(reel.filter((id) => wildIds.has(id)).length);
    }
    const count = matchCounts.length;
    const pay = profile.paytable.find((entry) => entry.symbol === symbolId && entry.count === count);
    if (!pay) continue;
    const allMatches = matchCounts.reduce((product, amount) => product * amount, 1);
    const allWild = isWildPay ? 0 : wildCounts.reduce((product, amount) => product * amount, 1);
    const ways = allMatches - allWild;
    if (ways <= 0) continue;
    const divisor = profile.rules.betBasis === 'total' ? totalWays : 1;
    const payout = integralPayout(pay.multiplier, bet, ways, divisor);
    if (payout === null) {
      errors.push(`派彩不是精確整數: ways ${symbolId} x${count} (${ways} ways)`);
      continue;
    }
    wins.push({ type: 'ways', symbol: symbolId, count, ways, multiplier: pay.multiplier, payout });
    expectedPayout += payout;
  }

  if (profile.rules.scatterAnywhere) {
    for (const symbolId of paySymbols.filter((id) => scatterIds.has(id))) {
      const count = normalizedBoard.flat().filter((id) => id === symbolId).length;
      const pay = profile.paytable.find((entry) => entry.symbol === symbolId && entry.count === count);
      if (!pay) continue;
      // Scatter anywhere 明確不乘 ways，也不接受 wild 替代。
      const payout = integralPayout(pay.multiplier, bet, 1, 1);
      if (payout === null) {
        errors.push(`派彩不是精確整數: scatter ${symbolId} x${count}`);
        continue;
      }
      wins.push({ type: 'scatter', symbol: symbolId, count, ways: 1, multiplier: pay.multiplier, payout });
      expectedPayout += payout;
    }
  }

  if (errors.length > 0) return { ok: false, expectedPayout: null, wins, errors };
  return { ok: true, expectedPayout, wins, errors: [] };
}

/** 比對實際與預期派彩；delta 為 actual - expected。 */
export function comparePayout({ expected, actual, tolerance = 0 }) {
  const delta = actual - expected;
  return { pass: Number.isFinite(delta) && Number.isFinite(tolerance) && tolerance >= 0 && Math.abs(delta) <= tolerance, delta };
}

/**
 * 無 ML 相依的分類閘門：template 永遠優先；低信心 template 仍回傳但明確標記；
 * 低於門檻才允許正規化後的 VLM label。embedding 僅保留為未來介面，不在此基礎層推論。
 */
export function classifySymbol({ embedding: _embedding, templateScores, vlmLabel } = {}, profile, opts = {}) {
  const profileResult = validateMachineProfile(profile);
  if (!profileResult.ok) return { id: null, confidence: 0, basis: 'unresolved' };
  const autoThreshold = opts.templateAutoThreshold ?? 0.98;
  const lowThreshold = opts.templateLowThreshold ?? 0.90;
  const aliases = symbolIndex(profile);
  let best = null;
  const entries = templateScores instanceof Map
    ? [...templateScores.entries()]
    : isObject(templateScores) ? Object.entries(templateScores) : [];
  for (const [label, rawScore] of entries) {
    const id = aliases.get(normalizedLabel(label));
    const score = Number(rawScore);
    if (!id || !Number.isFinite(score) || score < 0 || score > 1) continue;
    if (!best || score > best.score || (score === best.score && id.localeCompare(best.id) < 0)) best = { id, score };
  }
  if (best && best.score >= autoThreshold) return { id: best.id, confidence: best.score, basis: 'template' };
  if (best && best.score >= lowThreshold) return { id: best.id, confidence: best.score, basis: 'template-low-confidence' };
  const vlmId = aliases.get(normalizedLabel(vlmLabel));
  if (vlmId) return { id: vlmId, confidence: opts.vlmConfidence ?? 0, basis: 'vlm-alias' };
  return { id: null, confidence: 0, basis: 'unresolved' };
}
