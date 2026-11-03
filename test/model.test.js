import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SPEC,
  displacementLitres,
  cylinderAxisAngle,
  firingAngleDeg,
  firingOrder,
  pose,
  cyclePhaseDeg,
  cylinderVolume,
  cylinderPressure,
  burnFraction,
  valveLift,
  pvLoop,
  indicatedWork,
  engineOutputs,
  strokeCheck,
} from '../src/model.js';

const DEG = Math.PI / 180;
const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b} (±${eps})`);

test('総排気量は 9 × π/4 × B² × S ≈ 29.88 L（1,823 in³）', () => {
  close(displacementLitres(), 29.88, 0.05, 'displacement');
});

test('シリンダー軸は 40° 間隔で並ぶ', () => {
  for (let i = 0; i < 9; i++) close(cylinderAxisAngle(i), i * 40 * DEG, 1e-12, `axis ${i}`);
});

test('点火順序は 1-3-5-7-9-2-4-6-8 で 80° ごとに点火する', () => {
  assert.deepEqual(firingOrder(), [1, 3, 5, 7, 9, 2, 4, 6, 8]);
  const angles = firingOrder().map((n) => firingAngleDeg(n - 1));
  for (let k = 1; k < angles.length; k++) close(angles[k] - angles[k - 1], 80, 1e-9, `interval ${k}`);
});

test('マスターピストンのピン位置は TDC で r+L、BDC で L−r', () => {
  const r = SPEC.stroke / 2;
  close(pose(0).pinDist[0], r + SPEC.masterRod, 1e-9, 'TDC');
  close(pose(Math.PI).pinDist[0], SPEC.masterRod - r, 1e-9, 'BDC');
});

test('ナックルピンはクランクピンから一定半径、リンクロッドは一定長', () => {
  for (let a = 0; a < 360; a += 7) {
    const p = pose(a * DEG);
    for (let i = 1; i < 9; i++) {
      const k = p.knuckles[i];
      close(Math.hypot(k.x - p.crankPin.x, k.y - p.crankPin.y), SPEC.knuckleRadius, 1e-9, `knuckle ${i}@${a}`);
      const ax = cylinderAxisAngle(i);
      const pin = { x: Math.sin(ax) * p.pinDist[i], y: Math.cos(ax) * p.pinDist[i] };
      close(Math.hypot(pin.x - k.x, pin.y - k.y), SPEC.linkRod, 1e-9, `link ${i}@${a}`);
    }
  }
});

test('各シリンダーの TDC は公称角度から 4° 以内、行程は公称の 3% 以内', () => {
  for (const c of strokeCheck()) {
    const dev = ((c.tdcDeg - c.nominalTdcDeg + 540) % 360) - 180;
    assert.ok(Math.abs(dev) <= 4, `cyl ${c.cylinder} TDC dev ${dev}`);
    close(c.stroke, SPEC.stroke, SPEC.stroke * 0.03, `cyl ${c.cylinder} stroke`);
  }
});

test('サイクル位相は 0〜720° に収まり、点火角で 0 になる', () => {
  for (let i = 0; i < 9; i++) {
    close(cyclePhaseDeg(i, firingAngleDeg(i)), 0, 1e-9, `phase ${i}`);
    const ph = cyclePhaseDeg(i, 12345.6);
    assert.ok(ph >= 0 && ph < 720);
  }
});

test('マスター気筒の圧縮比は SPEC.compressionRatio に一致', () => {
  const vt = cylinderVolume(0, 0);
  const vb = cylinderVolume(0, 180);
  close(vb / vt, SPEC.compressionRatio, 1e-6, 'CR');
});

test('吸気行程の圧力はマニホールド圧、燃焼後の圧力は圧縮時より高い', () => {
  const map = 1.0;
  close(cylinderPressure(0, firingAngleDeg(0) + 450, map), map, 1e-6, 'intake');
  const compBefore = cylinderPressure(0, firingAngleDeg(0) - 30, map);
  const afterFire = cylinderPressure(0, firingAngleDeg(0) + 30, map);
  assert.ok(afterFire > compBefore * 1.5, `${afterFire} > ${compBefore}`);
});

test('燃焼率は 0→1 に単調増加する', () => {
  let prev = -1;
  for (let ps = -40; ps <= 80; ps += 2) {
    const x = burnFraction(ps);
    assert.ok(x >= prev - 1e-12 && x >= 0 && x <= 1);
    prev = x;
  }
  close(burnFraction(-60), 0, 1e-12, 'before');
  close(burnFraction(120), 1, 1e-6, 'after');
});

test('膨張行程の中盤では吸排気バルブとも閉じている', () => {
  const v = valveLift(90);
  assert.equal(v.intake, 0);
  assert.equal(v.exhaust, 0);
  assert.ok(valveLift(270).exhaust > 0, 'exhaust open');
  assert.ok(valveLift(450).intake > 0, 'intake open');
});

test('P-V ループは閉じ、図示仕事は正', () => {
  const loop = pvLoop(0, 1.0, 720);
  const a = loop[0];
  const b = loop[loop.length - 1];
  close(a.v, b.v, a.v * 0.01, 'v closes');
  close(a.p, b.p, a.p * 0.05, 'p closes');
  assert.ok(indicatedWork(0, 1.0) > 0);
});

test('出力はスロットル（MAP）と回転数で増える', () => {
  const lo = engineOutputs(1200, 0.6);
  const hi = engineOutputs(2400, 1.3);
  assert.ok(hi.powerKW > lo.powerKW);
  assert.ok(hi.imepBar > lo.imepBar);
  close(engineOutputs(2400, 1.3).meanPistonSpeed, 2 * SPEC.stroke * 2400 / 60, 1e-9, 'piston speed');
});

test('同じ入力には同じ出力（純粋関数）', () => {
  assert.deepEqual(pose(1.234), pose(1.234));
});
