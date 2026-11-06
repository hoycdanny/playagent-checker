/** 型別宣告:agent/gestures.mjs。 */
export interface Pt { x: number; y: number }

/** path:按住第一個點之後要依序經過的點(loops 會把整條路徑重複,每圈先回起點)。 */
export function pathSequence(points: Pt[] | null | undefined, loops?: number): Pt[];

/** circle:按住圓心之後要依序經過的點(先推到圓周,再沿圓周轉 laps 圈)。 */
export function circleSequence(
  cx: number,
  cy: number,
  r: number,
  laps?: number,
  opt?: { segs?: number; clockwise?: boolean; start?: number },
): Pt[];
