// 9 気筒星型エンジンのモデル。すべてクランク角（と MAP / 回転数）の純粋関数。
// 座標系: エンジン正面から見て x 右、y 上。シリンダー i の軸は (sin αi, cos αi)。
// 3D、チャート、数値表示はすべてこのモジュールだけを読む。

const IN = 0.0254;
const DEG = Math.PI / 180;

const BASE = {
  cylinders: 9,
  // 公開値（R-1820 系）: ボア 6.125 in、ストローク 6.875 in
  bore: 6.125 * IN,
  stroke: 6.875 * IN,
  // 概算値: 圧縮比 6.45:1
  compressionRatio: 6.45,
  // 推定値（公開資料なし）: マスターロッド長、ナックルピン半径、バルブリフト、減速比
  masterRod: 0.3556,
  knuckleRadius: 0.07,
  valveLiftMax: 0.0127,
  propReduction: 16 / 11,
  polytropic: 1.32,
  combustionRatio: 3.6,
  burnStartDeg: -15,
  burnDurationDeg: 55,
};

const r = BASE.stroke / 2;
const L = BASE.masterRod;
const A = (Math.PI / 4) * BASE.bore * BASE.bore;
const clearance = BASE.stroke / (BASE.compressionRatio - 1);
const headDist = r + L + clearance;

export function displacementLitres() {
  return BASE.cylinders * A * BASE.stroke * 1000;
}

export function cylinderAxisAngle(i) {
  return i * (2 * Math.PI / BASE.cylinders);
}

export function firingOrder() {
  return [1, 3, 5, 7, 9, 2, 4, 6, 8];
}

// 4 サイクル中（0〜720°）の点火（圧縮 TDC）角。奇数番が 1 回転目、偶数番が 2 回転目。
export function firingAngleDeg(i) {
  return i * 40 + (i % 2 === 1 ? 360 : 0);
}

function solvePose(theta, linkRod) {
  const crankPin = { x: r * Math.sin(theta), y: r * Math.cos(theta) };
  const s0 = crankPin.y + Math.sqrt(L * L - crankPin.x * crankPin.x);
  const phi = Math.atan2(-crankPin.x, s0 - crankPin.y);
  const knuckles = [];
  const pinDist = [s0];
  knuckles.push({ x: 0, y: s0 });
  for (let i = 1; i < BASE.cylinders; i++) {
    const a = cylinderAxisAngle(i);
    const k = {
      x: crankPin.x + BASE.knuckleRadius * Math.sin(phi + a),
      y: crankPin.y + BASE.knuckleRadius * Math.cos(phi + a),
    };
    const ux = Math.sin(a);
    const uy = Math.cos(a);
    const ku = k.x * ux + k.y * uy;
    const kk = k.x * k.x + k.y * k.y;
    knuckles.push(k);
    pinDist.push(ku + Math.sqrt(linkRod * linkRod - kk + ku * ku));
  }
  return { theta, crankPin, masterAngle: phi, knuckles, pinDist };
}

// リンクロッド長は、リンク側 8 気筒の TDC 平均がマスター側の TDC（r+L）と一致する長さにとる。
function solveLinkRod() {
  const meanTdc = (l) => {
    let sum = 0;
    const max = new Array(BASE.cylinders).fill(-Infinity);
    for (let k = 0; k < 720; k++) {
      const p = solvePose(k * 0.5 * DEG, l);
      for (let i = 1; i < BASE.cylinders; i++) max[i] = Math.max(max[i], p.pinDist[i]);
    }
    for (let i = 1; i < BASE.cylinders; i++) sum += max[i];
    return sum / (BASE.cylinders - 1);
  };
  let lo = L - 0.15;
  let hi = L;
  for (let n = 0; n < 40; n++) {
    const mid = (lo + hi) / 2;
    if (meanTdc(mid) < r + L) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

export const SPEC = Object.freeze({ ...BASE, linkRod: solveLinkRod() });

export function pose(theta) {
  return solvePose(theta, SPEC.linkRod);
}

function pinDistAt(i, crankDeg) {
  return pose(crankDeg * DEG).pinDist[i];
}

const STROKES = (() => {
  const out = [];
  for (let i = 0; i < BASE.cylinders; i++) {
    let max = -Infinity;
    let min = Infinity;
    let tdc = 0;
    for (let k = 0; k < 3600; k++) {
      const s = pinDistAt(i, k * 0.1);
      if (s > max) { max = s; tdc = k * 0.1; }
      if (s < min) min = s;
    }
    out.push({ max, min, tdc });
  }
  return out;
})();

export function strokeCheck() {
  return STROKES.map((s, i) => ({
    cylinder: i + 1,
    tdcDeg: s.tdc,
    nominalTdcDeg: i * 40,
    stroke: s.max - s.min,
    compressionRatio: (headDist - s.min) / (headDist - s.max),
  }));
}

export function cyclePhaseDeg(i, crankDeg) {
  const p = (crankDeg - firingAngleDeg(i)) % 720;
  return p < 0 ? p + 720 : p;
}

export function cylinderVolume(i, crankDeg) {
  return A * (headDist - pinDistAt(i, crankDeg));
}

export function burnFraction(signedPhaseDeg) {
  const t = (signedPhaseDeg - BASE.burnStartDeg) / BASE.burnDurationDeg;
  if (t <= 0) return 0;
  return 1 - Math.exp(-6.9 * t * t * t);
}

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export function exhaustPressure(map) {
  return 1.05 + 0.1 * map;
}

// 圧力 [bar]。map はマニホールド圧 [bar]。
export function cylinderPressureAt(i, phaseDeg, volume, map) {
  const pexh = exhaustPressure(map);
  if (phaseDeg > 180 && phaseDeg <= 360) return pexh;
  if (phaseDeg > 360 && phaseDeg <= 540) return pexh + (map - pexh) * smoothstep(360, 390, phaseDeg);
  const ps = phaseDeg > 540 ? phaseDeg - 720 : phaseDeg;
  const vb = A * (headDist - STROKES[i].min);
  const base = map * Math.pow(vb / volume, BASE.polytropic);
  const fired = base * (1 + (BASE.combustionRatio - 1) * burnFraction(ps));
  return fired + (pexh - fired) * smoothstep(120, 180, ps);
}

export function cylinderPressure(i, crankDeg, map) {
  return cylinderPressureAt(i, cyclePhaseDeg(i, crankDeg), cylinderVolume(i, crankDeg), map);
}

export function valveLift(phaseDeg) {
  const lobe = (open, close) => {
    if (phaseDeg <= open || phaseDeg >= close) return 0;
    return BASE.valveLiftMax * Math.sin(Math.PI * (phaseDeg - open) / (close - open));
  };
  return { exhaust: lobe(130, 375), intake: lobe(345, 590) };
}

export function pvLoop(i, map, n = 360) {
  const out = [];
  const f = firingAngleDeg(i);
  for (let k = 0; k <= n; k++) {
    const deg = f + (k * 720) / n;
    const v = cylinderVolume(i, deg);
    out.push({ phase: (k * 720) / n, v, p: cylinderPressureAt(i, (k * 720 / n) % 720, v, map) });
  }
  return out;
}

// 1 サイクルあたりの図示仕事 [J]
export function indicatedWork(i, map, n = 360) {
  const loop = pvLoop(i, map, n);
  let w = 0;
  for (let k = 0; k < loop.length - 1; k++) {
    w += ((loop[k].p + loop[k + 1].p) / 2) * 1e5 * (loop[k + 1].v - loop[k].v);
  }
  return w;
}

export function engineOutputs(rpm, map) {
  let work = 0;
  for (let i = 0; i < BASE.cylinders; i++) work += indicatedWork(i, map, 240);
  const vd = A * BASE.stroke;
  const powerW = work * (rpm / 120);
  const omega = (rpm * 2 * Math.PI) / 60;
  return {
    imepBar: work / BASE.cylinders / vd / 1e5,
    powerKW: powerW / 1000,
    hp: powerW / 745.7,
    torqueNm: omega > 0 ? powerW / omega : 0,
    meanPistonSpeed: (2 * BASE.stroke * rpm) / 60,
    propRpm: rpm / BASE.propReduction,
  };
}

// 3D 側が使うサイズ
export const GEOM = Object.freeze({
  crankThrow: r,
  headDist,
  clearance,
  pistonArea: A,
});
