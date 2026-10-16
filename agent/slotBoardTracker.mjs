/**
 * 純灰階拉霸盤面擷取器：只比較相鄰 ROI 畫面，不依賴計時器或影像套件。
 */
export const DEFAULT_BOARD_TRACKER = Object.freeze({
  enterDelta: 12,
  exitDelta: 3,
  enterFrames: 2,
  stableFrames: 3,
  minBusyMs: 300,
  refractoryMs: 500,
});

const STATES = Object.freeze({
  WAITING: 'WAITING',
  SPINNING: 'SPINNING',
  SETTLING: 'SETTLING',
  STABLE: 'STABLE',
});

function finiteNumber(value, name, min = 0) {
  if (!Number.isFinite(value) || value < min) throw new RangeError(`${name} must be a finite number >= ${min}`);
  return value;
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function meanAbsoluteDelta(a, b) {
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
  return total / a.length;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

/**
 * 建立盤面追蹤器。push 每次只回一個事件或 null；內部保留灰階副本，避免呼叫端修改。
 */
export function createSlotBoardTracker(opts = {}) {
  const o = { ...DEFAULT_BOARD_TRACKER, ...opts };
  finiteNumber(o.enterDelta, 'enterDelta');
  finiteNumber(o.exitDelta, 'exitDelta');
  positiveInteger(o.enterFrames, 'enterFrames');
  positiveInteger(o.stableFrames, 'stableFrames');
  finiteNumber(o.minBusyMs, 'minBusyMs');
  finiteNumber(o.refractoryMs, 'refractoryMs');
  if (o.exitDelta >= o.enterDelta) throw new RangeError('exitDelta must be less than enterDelta');

  let currentState;
  let currentSequence;
  let previous;
  let expectedLength;
  let lastTime;
  let enterCount;
  let enterStartedAt;
  let startedAt;
  let settlingAt;
  let stableCount;
  let stableCandidates;
  let peakDelta;
  let stableCapturedAt;

  function clearSpinData() {
    enterCount = 0;
    enterStartedAt = null;
    startedAt = null;
    settlingAt = null;
    stableCount = 0;
    stableCandidates = [];
    peakDelta = 0;
  }

  function reset({ keepSequence = false } = {}) {
    currentState = STATES.WAITING;
    if (!keepSequence) currentSequence = 0;
    previous = null;
    expectedLength = null;
    lastTime = null;
    stableCapturedAt = -Infinity;
    clearSpinData();
  }

  function validateSample(sample) {
    if (!sample || !(sample.gray instanceof Uint8Array)) throw new TypeError('frame.gray must be a Uint8Array');
    if (sample.gray.length === 0) throw new RangeError('frame.gray must not be empty');
    finiteNumber(sample.t, 'frame.t');
    if (lastTime !== null && sample.t < lastTime) throw new RangeError('frame.t must be monotonic');
    if (expectedLength !== null && sample.gray.length !== expectedLength) throw new RangeError('frame.gray length must remain fixed');
  }

  function beginSpin(t, delta) {
    currentState = STATES.SPINNING;
    currentSequence += 1;
    startedAt = enterStartedAt;
    peakDelta = delta;
    stableCount = 0;
    stableCandidates = [];
    settlingAt = null;
    enterCount = 0;
    enterStartedAt = null;
    return {
      type: 'spin_start',
      sequence: currentSequence,
      startedAt,
      detectedAt: t,
      metrics: { delta, enterDelta: o.enterDelta, enterFrames: o.enterFrames },
    };
  }

  function recordStableCandidate(sample, delta) {
    if (stableCount === 0) settlingAt = sample.t;
    stableCount += 1;
    stableCandidates.push({ delta, t: sample.t, frame: sample.frame });
  }

  function clearStableRun() {
    stableCount = 0;
    stableCandidates = [];
    settlingAt = null;
  }

  function finishSpin(sample, delta) {
    // 差異最低者最接近真正靜止盤面；同差異時取較晚畫面，結果仍完全決定性。
    let best = stableCandidates[0];
    for (const candidate of stableCandidates) {
      if (candidate.delta < best.delta || (candidate.delta === best.delta && candidate.t > best.t)) best = candidate;
    }
    const busyMs = sample.t - startedAt;
    const stableMs = sample.t - settlingAt;
    const motionConfidence = clamp01(peakDelta / Math.max(o.enterDelta * 2, 1));
    const stillConfidence = clamp01(1 - best.delta / Math.max(o.exitDelta, 1));
    const confidence = Math.round(((motionConfidence + stillConfidence) / 2) * 1000) / 1000;
    currentState = STATES.STABLE;
    stableCapturedAt = sample.t;
    const event = {
      type: 'stable_board',
      sequence: currentSequence,
      startedAt,
      capturedAt: best.t,
      busyMs,
      stableMs,
      confidence,
      frame: best.frame,
      metrics: {
        delta,
        bestDelta: best.delta,
        peakDelta,
        candidateCount: stableCandidates.length,
        stableFrames: stableCount,
        enterDelta: o.enterDelta,
        exitDelta: o.exitDelta,
      },
    };
    // 完成後清掉該局候選，永久靜止時不可能再次送出。
    clearSpinData();
    return event;
  }

  function observeBusyEntry(sample, delta) {
    if (delta >= o.enterDelta) {
      if (enterCount === 0) enterStartedAt = sample.t;
      enterCount += 1;
      if (enterCount >= o.enterFrames) return beginSpin(sample.t, delta);
    } else {
      enterCount = 0;
      enterStartedAt = null;
    }
    return null;
  }

  reset();
  return {
    get state() { return currentState; },
    get sequence() { return currentSequence; },
    reset,
    push(sample) {
      validateSample(sample);
      const gray = sample.gray.slice();
      if (previous === null) {
        previous = gray;
        expectedLength = gray.length;
        lastTime = sample.t;
        return null;
      }

      const delta = meanAbsoluteDelta(gray, previous);
      previous = gray;
      lastTime = sample.t;

      if (currentState === STATES.WAITING) return observeBusyEntry(sample, delta);

      if (currentState === STATES.STABLE) {
        if (sample.t - stableCapturedAt < o.refractoryMs) {
          enterCount = 0;
          enterStartedAt = null;
          return null;
        }
        return observeBusyEntry(sample, delta);
      }

      peakDelta = Math.max(peakDelta, delta);
      if (currentState === STATES.SPINNING) {
        if (delta <= o.exitDelta) {
          currentState = STATES.SETTLING;
          recordStableCandidate(sample, delta);
        }
        return null;
      }

      // SETTLING 的中間帶不算穩定也不算重新高速旋轉，這就是遲滯區。
      if (delta >= o.enterDelta) {
        currentState = STATES.SPINNING;
        clearStableRun();
        return null;
      }
      if (delta > o.exitDelta) {
        clearStableRun();
        return null;
      }

      recordStableCandidate(sample, delta);
      if (stableCount >= o.stableFrames && sample.t - startedAt >= o.minBusyMs) return finishSpin(sample, delta);
      return null;
    },
  };
}

/**
 * 以標準化 ROI 擷取固定大小灰階網格；使用輸出像素中心的最近鄰取樣。
 * 幾何或輸入不合法時回 null。
 */
export function roiGrid(gray, width, height, roi, outW = 64, outH = 36) {
  if (!(gray instanceof Uint8Array) || !Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) return null;
  if (gray.length !== width * height || !Number.isInteger(outW) || outW < 1 || !Number.isInteger(outH) || outH < 1 || !roi) return null;
  const values = [roi.x, roi.y, roi.w, roi.h];
  if (!values.every(Number.isFinite) || roi.x < 0 || roi.y < 0 || roi.w <= 0 || roi.h <= 0 || roi.x + roi.w > 1 || roi.y + roi.h > 1) return null;

  const out = new Uint8Array(outW * outH);
  for (let oy = 0; oy < outH; oy++) {
    const sourceY = Math.min(height - 1, Math.floor((roi.y + ((oy + 0.5) / outH) * roi.h) * height));
    for (let ox = 0; ox < outW; ox++) {
      const sourceX = Math.min(width - 1, Math.floor((roi.x + ((ox + 0.5) / outW) * roi.w) * width));
      out[oy * outW + ox] = gray[sourceY * width + sourceX];
    }
  }
  return out;
}

/**
 * 平均局部水平/垂直梯度；數值越高通常代表邊緣越清楚。
 */
export function frameSharpness(gray, width, height) {
  if (!(gray instanceof Uint8Array) || !Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1 || gray.length !== width * height) return 0;
  let total = 0;
  let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (x + 1 < width) { total += Math.abs(gray[i] - gray[i + 1]); count += 1; }
      if (y + 1 < height) { total += Math.abs(gray[i] - gray[i + width]); count += 1; }
    }
  }
  return count === 0 ? 0 : total / count;
}
