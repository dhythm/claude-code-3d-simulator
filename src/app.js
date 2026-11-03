import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  SPEC, GEOM, displacementLitres, cylinderAxisAngle, firingOrder, firingAngleDeg,
  pose, cyclePhaseDeg, cylinderVolume, cylinderPressure, burnFraction, valveLift,
  pvLoop, engineOutputs, strokeCheck,
} from './model.js';

const DEG = Math.PI / 180;
const N = SPEC.cylinders;
const ACCENT = new THREE.Color('#ff4d17');
const CROWN = 0.055; // ピストンピンからクラウンまで [m]
const HEAD_FACE = GEOM.headDist + CROWN;
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- 状態
const state = {
  throttle: 0.1, rpm: 600, map: 0.46, theta: 0, timeScale: 0.05, paused: false,
  tracked: 0, glass: true, cut: false, xray: false, isolate: false, explode: false, prop: true,
  sound: false,
};
const IDLE_RPM = 600;
const MAX_RPM = 2500;
const targetRpm = (t) => IDLE_RPM + (MAX_RPM - IDLE_RPM) * t;
const targetMap = (t) => 0.35 + 1.1 * t;

// ---------------------------------------------------------------- レンダラー
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas: $('gl'), antialias: true, alpha: true, powerPreference: 'high-performance' });
} catch (err) {
  $('fallback').classList.add('show');
  $('fallbackMsg').textContent = String(err && err.message ? err.message : err);
  throw err;
}
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x000000, 0);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.localClippingEnabled = true;

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;

const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 60);
camera.position.set(2.9, 1.25, 3.7);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 0.5;
controls.maxDistance = 9;
controls.target.set(0, 0, 0.05);

scene.add(new THREE.HemisphereLight(0xffffff, 0xb8b0a0, 0.55));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(3, 6.5, 4);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.radius = 6;
sun.shadow.bias = -0.0004;
Object.assign(sun.shadow.camera, { left: -2.6, right: 2.6, top: 2.6, bottom: -2.6, near: 1, far: 16 });
scene.add(sun);
const rim = new THREE.DirectionalLight(0xdfe8ff, 0.6);
rim.position.set(-4, 2, -3);
scene.add(rim);

const FLOOR_Y = -1.42;
const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.ShadowMaterial({ opacity: 0.16 }));
floor.rotation.x = -Math.PI / 2;
floor.position.y = FLOOR_Y;
floor.receiveShadow = true;
scene.add(floor);

// ---------------------------------------------------------------- 切断面とフェード
const cutPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 2);
const fades = new Map(); // name -> { mats, meshes, cur, target }

function fadeGroup(name) {
  if (!fades.has(name)) fades.set(name, { mats: [], meshes: [], cur: 1, target: 1 });
  return fades.get(name);
}

function mat(name, opts, { clip = false } = {}) {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.5, ...opts });
  m.userData.baseColor = m.color.clone();
  if (clip) { m.clippingPlanes = [cutPlane]; m.side = THREE.DoubleSide; m.clipShadows = true; }
  fadeGroup(name).mats.push(m);
  return m;
}

function mesh(geo, material, parent, group) {
  const m = new THREE.Mesh(geo, material);
  m.castShadow = true;
  m.receiveShadow = true;
  parent.add(m);
  if (group) fadeGroup(group).meshes.push(m);
  return m;
}

// ---------------------------------------------------------------- 形状ヘルパー
function finnedLathe(points, segments = 48) {
  return new THREE.LatheGeometry(points.map(([x, y]) => new THREE.Vector2(x, y)), segments);
}

function barrelProfile() {
  const inner = SPEC.bore / 2;
  const pts = [[inner, 0.28], [inner, 0.535], [0.088, 0.535]];
  for (let y = 0.522; y > 0.33; y -= 0.0145) {
    pts.push([0.088, y], [0.107, y], [0.107, y - 0.0032], [0.088, y - 0.0032]);
  }
  pts.push([0.088, 0.31], [0.098, 0.305], [0.098, 0.28], [inner, 0.28]);
  return pts;
}

function headProfile() {
  const pts = [[0, HEAD_FACE], [SPEC.bore / 2, HEAD_FACE], [SPEC.bore / 2, 0.535], [0.095, 0.538]];
  for (let y = 0.545; y < 0.655; y += 0.0125) {
    pts.push([0.095, y], [0.13, y], [0.13, y + 0.0045], [0.095, y + 0.0045]);
  }
  pts.push([0.094, 0.668], [0.07, 0.69], [0.035, 0.7], [0, 0.702]);
  return pts;
}

function unitRod(w, d) {
  const g = new THREE.BoxGeometry(w, 1, d);
  g.translate(0, 0.5, 0);
  return g;
}

function placeRod(m, ax, ay, bx, by, z = 0) {
  m.position.set(ax, ay, z);
  m.rotation.z = -Math.atan2(bx - ax, by - ay);
  m.scale.y = Math.hypot(bx - ax, by - ay);
}

// ---------------------------------------------------------------- エンジン構築（実寸 m）
const engine = new THREE.Group();
scene.add(engine);

const caseMat = mat('case', { color: '#5f646c', metalness: 0.35, roughness: 0.48 }, { clip: true });
const caseShape = new THREE.Shape();
for (let i = 0; i < N; i++) {
  const a = cylinderAxisAngle(i) + 20 * DEG;
  const R = 0.295 / Math.cos(20 * DEG);
  const x = Math.sin(a) * R;
  const y = Math.cos(a) * R;
  if (i === 0) caseShape.moveTo(x, y); else caseShape.lineTo(x, y);
}
caseShape.closePath();
const caseGeo = new THREE.ExtrudeGeometry(caseShape, { depth: 0.2, bevelEnabled: true, bevelSize: 0.012, bevelThickness: 0.012, bevelSegments: 3 });
caseGeo.translate(0, 0, -0.1);
const crankcase = mesh(caseGeo, caseMat, engine, 'case');

const noseGroup = new THREE.Group();
engine.add(noseGroup);
const noseGeo = new THREE.LatheGeometry([
  [0, 0.1], [0.27, 0.1], [0.27, 0.13], [0.24, 0.2], [0.2, 0.3], [0.17, 0.36], [0.12, 0.4], [0.075, 0.41], [0, 0.41],
].map(([x, y]) => new THREE.Vector2(x, y)), 54);
noseGeo.rotateX(Math.PI / 2);
mesh(noseGeo, caseMat, noseGroup, 'case');

const rearGroup = new THREE.Group();
engine.add(rearGroup);
const rearMat = mat('case', { color: '#4b5058', metalness: 0.35, roughness: 0.5 }, { clip: true });
const rearGeo = new THREE.CylinderGeometry(0.26, 0.27, 0.14, 54);
rearGeo.rotateX(Math.PI / 2);
rearGeo.translate(0, 0, -0.18);
mesh(rearGeo, rearMat, rearGroup, 'case');
const accGeo = new THREE.CylinderGeometry(0.19, 0.21, 0.2, 40);
accGeo.rotateX(Math.PI / 2);
accGeo.translate(0, 0, -0.35);
mesh(accGeo, rearMat, rearGroup, 'case');
for (const sx of [-1, 1]) {
  const mag = mesh(new THREE.BoxGeometry(0.1, 0.13, 0.16), rearMat, rearGroup, 'case');
  mag.position.set(sx * 0.14, 0.13, -0.42);
}

// 架台
const standMat = mat('stand', { color: '#1f2226', metalness: 0.4, roughness: 0.5 });
const post = mesh(new THREE.CylinderGeometry(0.05, 0.05, Math.abs(FLOOR_Y) - 0.1, 20), standMat, engine, 'stand');
post.position.set(0, FLOOR_Y / 2 - 0.05, -0.5);
const plate = mesh(new THREE.CylinderGeometry(0.42, 0.45, 0.04, 48), standMat, engine, 'stand');
plate.position.set(0, FLOOR_Y + 0.02, -0.5);
const yoke = mesh(new THREE.TorusGeometry(0.22, 0.025, 12, 48), standMat, engine, 'stand');
yoke.position.set(0, 0, -0.47);

// クランク
const crankGroup = new THREE.Group();
engine.add(crankGroup);
const crankMat = mat('crank', { color: '#7d838a', metalness: 0.75, roughness: 0.45 });
const shaftGeo = new THREE.CylinderGeometry(0.045, 0.045, 1.1, 32);
shaftGeo.rotateX(Math.PI / 2);
shaftGeo.translate(0, 0, 0.05);
mesh(shaftGeo, crankMat, crankGroup, 'crank');
const r = GEOM.crankThrow;
const pinGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.12, 32);
pinGeo.rotateX(Math.PI / 2);
const crankPinMesh = mesh(pinGeo, crankMat, crankGroup, 'crank');
crankPinMesh.position.set(0, r, 0);
const cheekShape = new THREE.Shape();
cheekShape.absarc(0, r, 0.06, -Math.PI / 2, Math.PI / 2 + Math.PI, false);
cheekShape.absarc(0, -0.04, 0.17, Math.PI + 0.55, -0.55, false);
for (const z of [-0.07, 0.05]) {
  const g = new THREE.ExtrudeGeometry(cheekShape, { depth: 0.022, bevelEnabled: false, curveSegments: 24 });
  g.translate(0, 0, z);
  mesh(g, crankMat, crankGroup, 'crank');
}

// マスターロッドとリンクロッド
const rodMat = mat('rods', { color: '#a7adb4', metalness: 0.8, roughness: 0.45 });
const masterMat = mat('rods', { color: '#c9a227', metalness: 0.7, roughness: 0.45, emissive: '#000000' });
const bigEndGeo = new THREE.CylinderGeometry(0.1, 0.1, 0.05, 48);
bigEndGeo.rotateX(Math.PI / 2);
const bigEnd = mesh(bigEndGeo, masterMat, engine, 'rods');
const masterRod = mesh(unitRod(0.05, 0.032), masterMat, engine, 'rods');
const knuckleGeo = new THREE.CylinderGeometry(0.012, 0.012, 0.07, 16);
knuckleGeo.rotateX(Math.PI / 2);
const knucklePins = [];
const linkRods = [];
for (let i = 1; i < N; i++) {
  knucklePins.push(mesh(knuckleGeo, crankMat, engine, 'rods'));
  linkRods.push(mesh(unitRod(0.026, 0.02), rodMat, engine, 'rods'));
}

// 気筒ごと
const pistonMat = mat('pistons', { color: '#d4d7da', metalness: 0.7, roughness: 0.45 });
const ringMat = mat('pistons', { color: '#2a2d31', metalness: 0.6, roughness: 0.5 });
const pistonGeo = new THREE.CylinderGeometry(SPEC.bore / 2 - 0.002, SPEC.bore / 2 - 0.002, 0.095, 40);
pistonGeo.translate(0, CROWN - 0.0475, 0);
const ringGeo = new THREE.TorusGeometry(SPEC.bore / 2 - 0.0015, 0.0022, 6, 40);
ringGeo.rotateX(Math.PI / 2);
const barrelGeo = finnedLathe(barrelProfile());
const headGeo = finnedLathe(headProfile());
const glowGeo = new THREE.CylinderGeometry(SPEC.bore / 2 - 0.004, SPEC.bore / 2 - 0.004, 1, 32);
glowGeo.translate(0, 0.5, 0);
const pushGeo = unitRod(0.011, 0.011);
const rockerGeo = new THREE.BoxGeometry(0.034, 0.034, 0.13);
const plugGeo = new THREE.CylinderGeometry(0.008, 0.008, 0.05, 10);
const sparkGeo = new THREE.SphereGeometry(0.02, 12, 8);

const valveMat = mat('valvetrain', { color: '#c4c7cb', metalness: 0.75, roughness: 0.45 });
const intakeMat = mat('intake', { color: '#2d3035', metalness: 0.4, roughness: 0.48 }, { clip: true });
const plugMat = mat('valvetrain', { color: '#e8e6e0', metalness: 0.2, roughness: 0.5 });

const cyl = [];
for (let i = 0; i < N; i++) {
  const axis = new THREE.Group();
  axis.rotation.z = -cylinderAxisAngle(i);
  engine.add(axis);
  const outer = new THREE.Group();
  axis.add(outer);

  const barrelMat = mat(`cyl${i}`, { color: '#24272b', metalness: 0.55, roughness: 0.45 }, { clip: true });
  const headMat = mat(`cyl${i}`, { color: '#b5b9be', metalness: 0.6, roughness: 0.48, emissive: '#000000' }, { clip: true });
  mesh(barrelGeo, barrelMat, outer, `cyl${i}`);
  const head = mesh(headGeo, headMat, outer, `cyl${i}`);

  for (const sx of [-1, 1]) {
    const rb = mesh(rockerGeo, headMat, outer, `cyl${i}`);
    rb.position.set(sx * 0.052, 0.7, 0);
  }
  const pushrods = [-1, 1].map((sx) => {
    const p = mesh(pushGeo, valveMat, axis, 'valvetrain');
    placeRod(p, sx * 0.04, 0.27, sx * 0.052, 0.66, 0.12);
    p.rotation.x = -Math.atan2(0.12 - 0.075, 0.39);
    p.userData.base = p.position.clone();
    p.userData.dir = new THREE.Vector3(sx * 0.012, 0.39, -0.045).normalize();
    return p;
  });
  const plug = mesh(plugGeo, plugMat, outer, 'valvetrain');
  plug.position.set(0.065, 0.6, 0.1);
  plug.rotation.x = Math.PI / 2;
  const spark = new THREE.Mesh(sparkGeo, new THREE.MeshBasicMaterial({ color: '#ffd38a', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
  spark.position.set(0.065, 0.6, 0.13);
  outer.add(spark);

  const intakeCurve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(0, 0.25, -0.18), new THREE.Vector3(0, 0.5, -0.24), new THREE.Vector3(0, 0.6, -0.1));
  mesh(new THREE.TubeGeometry(intakeCurve, 24, 0.024, 12), intakeMat, axis, 'intake');
  const exCurve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(0, 0.6, 0.09), new THREE.Vector3(0, 0.63, 0.19), new THREE.Vector3(0, 0.52, 0.22));
  const exMat = mat('exhaust', { color: '#4a3f37', metalness: 0.5, roughness: 0.5 }, { clip: true });
  mesh(new THREE.TubeGeometry(exCurve, 20, 0.026, 12), exMat, axis, 'exhaust');

  const piston = new THREE.Group();
  axis.add(piston);
  mesh(pistonGeo, pistonMat, piston, 'pistons');
  for (const y of [CROWN - 0.012, CROWN - 0.022]) {
    const ring = mesh(ringGeo, ringMat, piston, 'pistons');
    ring.position.y = y;
  }
  const glowMat = new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  const glow = new THREE.Mesh(glowGeo, glowMat);
  axis.add(glow);

  cyl.push({ axis, outer, head, headMat, barrelMat, pushrods, spark, piston, glow, glowMat });
}
const exRingMat = mat('exhaust', { color: '#4a3f37', metalness: 0.5, roughness: 0.5 });
const exRing = mesh(new THREE.TorusGeometry(0.52, 0.024, 14, 96), exRingMat, noseGroup, 'exhaust');
exRing.position.z = 0.22;

// プロペラ（表示用の推定寸法）
const propGroup = new THREE.Group();
propGroup.position.z = 0.42;
engine.add(propGroup);
const propMat = mat('prop', { color: '#1b1d20', metalness: 0.45, roughness: 0.45 });
const tipMat = mat('prop', { color: '#e3e1db', metalness: 0.3, roughness: 0.5 });
const hubGeo = new THREE.LatheGeometry([[0, 0], [0.16, 0], [0.16, 0.08], [0.13, 0.17], [0.07, 0.24], [0, 0.26]].map(([x, y]) => new THREE.Vector2(x, y)), 48);
hubGeo.rotateX(Math.PI / 2);
mesh(hubGeo, propMat, propGroup, 'prop');
function bladeGeo(from, to) {
  const s = new THREE.Shape();
  const w = (y) => 0.075 + 0.07 * Math.sin(Math.PI * Math.min(1, y / 1.1)) - 0.04 * (y / 1.3);
  s.moveTo(-w(from), from);
  for (let y = from; y <= to; y += 0.05) s.lineTo(-w(y), y);
  for (let y = to; y >= from; y -= 0.05) s.lineTo(w(y) * 0.8, y);
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.022, bevelEnabled: true, bevelSize: 0.006, bevelThickness: 0.006, bevelSegments: 2 });
  g.translate(0, 0, -0.011);
  return g;
}
const bladeBody = bladeGeo(0.12, 1.12);
const bladeTip = bladeGeo(1.12, 1.3);
for (let b = 0; b < 3; b++) {
  const root = new THREE.Group();
  root.rotation.z = (b * 2 * Math.PI) / 3;
  propGroup.add(root);
  const pitch = new THREE.Group();
  pitch.rotation.y = 0.42;
  pitch.position.z = 0.08;
  root.add(pitch);
  mesh(bladeBody, propMat, pitch, 'prop');
  mesh(bladeTip, tipMat, pitch, 'prop');
}

// ---------------------------------------------------------------- 3D をモデルから姿勢付け
function applyPose(p, crankDeg) {
  crankGroup.rotation.z = -p.theta;
  bigEnd.position.set(p.crankPin.x, p.crankPin.y, 0);
  bigEnd.rotation.z = -p.masterAngle;
  placeRod(masterRod, p.crankPin.x, p.crankPin.y, 0, p.pinDist[0], 0);
  for (let i = 1; i < N; i++) {
    const k = p.knuckles[i];
    const a = cylinderAxisAngle(i);
    knucklePins[i - 1].position.set(k.x, k.y, 0);
    placeRod(linkRods[i - 1], k.x, k.y, Math.sin(a) * p.pinDist[i], Math.cos(a) * p.pinDist[i], 0);
  }
  propGroup.rotation.z = -(crankDeg / SPEC.propReduction) * DEG;

  const exp = fadeOffsets.explode;
  for (let i = 0; i < N; i++) {
    const c = cyl[i];
    const s = p.pinDist[i];
    c.piston.position.y = s;
    const crown = s + CROWN;
    c.glow.position.y = crown;
    c.glow.scale.y = Math.max(0.001, HEAD_FACE + exp * 0.32 - crown);
    c.outer.position.y = exp * 0.32;

    const ph = cyclePhaseDeg(i, crankDeg);
    const ps = ph > 540 ? ph - 720 : ph;
    const burn = ps > -20 && ps < 180 ? burnFraction(ps) * (1 - smooth(0, 150, ps)) : 0;
    c.glowMat.opacity = Math.min(0.85, burn * 1.3);
    c.headMat.emissive.copy(ACCENT).multiplyScalar(burn * 0.55);
    const sparkI = ps > -16 && ps < 6 ? 1 - Math.abs(ps + 5) / 11 : 0;
    c.spark.material.opacity = Math.max(0, sparkI);
    c.spark.scale.setScalar(0.4 + Math.max(0, sparkI));

    const v = valveLift(ph);
    c.pushrods[0].position.copy(c.pushrods[0].userData.base).addScaledVector(c.pushrods[0].userData.dir, v.intake * 0.8);
    c.pushrods[1].position.copy(c.pushrods[1].userData.base).addScaledVector(c.pushrods[1].userData.dir, v.exhaust * 0.8);
  }
}

function smooth(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------- フェードと分解
const fadeOffsets = { explode: 0, cut: 0 };

function fadeTargets() {
  const t = {};
  const set = (k, v) => { t[k] = Math.min(t[k] ?? 1, v); };
  for (const k of fades.keys()) t[k] = 1;
  if (state.xray) {
    set('case', 0.1); set('intake', 0.15); set('exhaust', 0.15); set('valvetrain', 0.3); set('prop', 0.12); set('stand', 0.35);
    for (let i = 0; i < N; i++) set(`cyl${i}`, 0.13);
  }
  if (state.isolate) {
    set('case', 0.04); set('intake', 0); set('exhaust', 0); set('valvetrain', 0); set('prop', 0); set('stand', 0.2);
    for (let i = 0; i < N; i++) set(`cyl${i}`, 0.04);
  }
  if (state.explode) { set('intake', 0); set('exhaust', 0.25); set('valvetrain', 0); }
  if (!state.prop) set('prop', 0);
  if (state.glass) set(`cyl${state.tracked}`, 0.2);
  return t;
}

function updateFades(dt) {
  const t = fadeTargets();
  const k = 1 - Math.exp(-dt * 6);
  for (const [name, g] of fades) {
    g.cur += ((t[name] ?? 1) - g.cur) * k;
    const o = g.cur;
    for (const m of g.mats) {
      m.opacity = o;
      const tr = o < 0.995;
      // transparent の切り替えはシェーダー（OPAQUE define）が変わるため needsUpdate が要る
      if (m.transparent !== tr) { m.transparent = tr; m.needsUpdate = true; }
      m.depthWrite = o > 0.5;
    }
    for (const m of g.meshes) { m.visible = o > 0.01; m.castShadow = o > 0.5; }
  }
  fadeOffsets.explode += ((state.explode ? 1 : 0) - fadeOffsets.explode) * k;
  fadeOffsets.cut += ((state.cut ? 1 : 0) - fadeOffsets.cut) * k;
  cutPlane.constant = 1.4 - fadeOffsets.cut * 1.4;
  const e = fadeOffsets.explode;
  noseGroup.position.z = e * 0.35;
  rearGroup.position.z = -e * 0.3;
  propGroup.position.z = 0.42 + e * 0.75;
  masterMat.emissive.copy(ACCENT).multiplyScalar(state.isolate ? 0.12 : 0);
}

// ---------------------------------------------------------------- カメラ
const VIEWS = {
  hero: { pos: [2.9, 1.25, 3.7], target: [0, -0.05, 0.05] },
  front: { pos: [0, 0.05, 3.4], target: [0, 0, 0] },
  side: { pos: [4.4, 0.35, 0.05], target: [0, -0.1, 0] },
  top: { pos: [0.02, 4.4, 0.6], target: [0, 0, 0] },
  inside: { pos: [0.75, 0.55, 1.35], target: [0, 0.1, 0] },
};
let camTween = null;
function goView(name) {
  const v = VIEWS[name];
  camTween = { t: 0, from: camera.position.clone(), fromT: controls.target.clone(), to: new THREE.Vector3(...v.pos), toT: new THREE.Vector3(...v.target) };
  for (const b of document.querySelectorAll('#views button')) b.classList.toggle('on', b.dataset.view === name);
}
function updateCamera(dt) {
  if (!camTween) return;
  camTween.t = Math.min(1, camTween.t + dt / 1.4);
  const e = camTween.t < 0.5 ? 4 * camTween.t ** 3 : 1 - (-2 * camTween.t + 2) ** 3 / 2;
  camera.position.lerpVectors(camTween.from, camTween.to, e);
  controls.target.lerpVectors(camTween.fromT, camTween.toT, e);
  if (camTween.t >= 1) camTween = null;
}
controls.addEventListener('start', () => { camTween = null; });

// ---------------------------------------------------------------- UI 構築
const cylBox = $('cyls');
for (let i = 0; i < N; i++) {
  const b = document.createElement('button');
  b.textContent = String(i + 1);
  b.dataset.cyl = String(i);
  cylBox.appendChild(b);
}
const fireBox = $('fireorder');
const fireCells = firingOrder().map((n) => {
  const d = document.createElement('div');
  d.textContent = String(n);
  fireBox.appendChild(d);
  return d;
});

function syncButtons() {
  for (const b of document.querySelectorAll('[data-toggle]')) b.classList.toggle('on', !!state[b.dataset.toggle]);
  for (const b of cylBox.children) b.classList.toggle('on', Number(b.dataset.cyl) === state.tracked);
  for (const b of document.querySelectorAll('[data-speed]')) b.classList.toggle('on', Number(b.dataset.speed) === state.timeScale);
  $('pause').classList.toggle('on', state.paused);
  $('sound').classList.toggle('on', state.sound);
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  audioClick();
  if (b.dataset.toggle) state[b.dataset.toggle] = !state[b.dataset.toggle];
  if (b.dataset.cyl) state.tracked = Number(b.dataset.cyl);
  if (b.dataset.view) goView(b.dataset.view);
  if (b.dataset.speed) state.timeScale = Number(b.dataset.speed);
  if (b.id === 'pause') state.paused = !state.paused;
  if (b.id === 'sound') toggleSound();
  syncButtons();
});

const thr = $('throttle');
function setThrottleUI(v) {
  thr.value = String(v);
  thr.style.setProperty('--p', `${v * 100}%`);
  $('thrVal').textContent = `${Math.round(v * 100)}%`;
  $('tgtVal').textContent = String(Math.round(targetRpm(v)));
}
thr.addEventListener('input', () => { state.throttle = Number(thr.value); setThrottleUI(state.throttle); });
setThrottleUI(state.throttle);

let panelsOn = true;
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement && e.key !== 'h' && e.key !== 'H') return;
  const k = e.key.toLowerCase();
  if (k === 'h') { panelsOn = !panelsOn; $('hud').classList.toggle('hidden', !panelsOn); $('callouts').style.display = panelsOn ? '' : 'none'; }
  else if (k === ' ') { state.paused = !state.paused; e.preventDefault(); }
  else if (k >= '1' && k <= '9') state.tracked = Number(k) - 1;
  else if (k === 'c') state.cut = !state.cut;
  else if (k === 'x') state.xray = !state.xray;
  else if (k === 'e') state.explode = !state.explode;
  else if (k === 'w' || k === 'arrowup') { state.throttle = Math.min(1, state.throttle + 0.05); setThrottleUI(state.throttle); }
  else if (k === 's' || k === 'arrowdown') { state.throttle = Math.max(0, state.throttle - 0.05); setThrottleUI(state.throttle); }
  syncButtons();
});

// モデル検算表
(function buildCheck() {
  const rows = strokeCheck();
  const html = ['<tr><th>CYL</th><th>TDC °</th><th>行程 mm</th><th>圧縮比</th></tr>'];
  for (const c of rows) {
    html.push(`<tr data-row="${c.cylinder - 1}"><td>${c.cylinder}${c.cylinder === 1 ? ' M' : ''}</td><td>${c.tdcDeg.toFixed(1)}</td><td>${(c.stroke * 1000).toFixed(2)}</td><td>${c.compressionRatio.toFixed(2)}</td></tr>`);
  }
  $('check').innerHTML = html.join('');
  $('checkNote').innerHTML =
    `排気量 <code>9 × π/4 × 155.58² × 174.63 mm³ = ${displacementLitres().toFixed(2)} L</code>（1,823 in³）。` +
    `リンクロッド長 <code>${(SPEC.linkRod * 1000).toFixed(1)} mm</code> はリンク側8気筒の TDC 平均がマスター側と一致するよう解いた値。` +
    `ボア／ストロークは公開値、マスターロッド長・ナックル半径・減速比・バルブタイミングは推定値。気筒ごとに TDC と圧縮比がずれるのは関節ロッド式の実際の特性。`;
})();

// ---------------------------------------------------------------- チャート
function setupCanvas(c) {
  const dpr = Math.min(devicePixelRatio, 2);
  const w = c.clientWidth;
  const h = c.clientHeight;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}
const INK = '#15171a';
const GRID = '#d6d0c4';
const MUTED = '#8a8e95';
const BLUE = '#2f6fdf';
const ORANGE = '#ff4d17';

const pvCache = new Map();
function getLoop(i, map) {
  const key = `${i}:${map.toFixed(2)}`;
  if (!pvCache.has(key)) {
    if (pvCache.size > 200) pvCache.clear();
    pvCache.set(key, pvLoop(i, Number(map.toFixed(2)), 360));
  }
  return pvCache.get(key);
}
const outCache = new Map();
function outputs(rpm, map) {
  const key = map.toFixed(2);
  if (!outCache.has(key)) outCache.set(key, engineOutputs(1000, Number(key)));
  const b = outCache.get(key);
  return { imepBar: b.imepBar, hp: (b.hp * rpm) / 1000, torqueNm: b.torqueNm, meanPistonSpeed: (b.meanPistonSpeed * rpm) / 1000, propRpm: rpm / SPEC.propReduction };
}

const STROKES = [
  [0, 180, '膨張 POWER', ORANGE], [180, 360, '排気 EXHAUST', MUTED], [360, 540, '吸気 INTAKE', BLUE], [540, 720, '圧縮 COMP', INK],
];
function strokeOf(ph) { return STROKES.find(([a, b]) => ph >= a && ph < b) || STROKES[0]; }

function drawPV(i, map, crankDeg) {
  const { ctx, w, h } = setupCanvas($('pv'));
  const loop = getLoop(i, map);
  const vmin = cylinderVolume(i, 0) * 0; // 0 から描く
  const vmax = Math.max(...loop.map((p) => p.v)) * 1.05;
  const pmax = 50;
  const X = (v) => 30 + ((v - vmin) / (vmax - vmin)) * (w - 38);
  const Y = (p) => h - 16 - (p / pmax) * (h - 24);
  ctx.strokeStyle = GRID; ctx.lineWidth = 1; ctx.font = '9px JetBrains Mono'; ctx.fillStyle = MUTED;
  for (let p = 0; p <= pmax; p += 10) { ctx.beginPath(); ctx.moveTo(30, Y(p)); ctx.lineTo(w - 8, Y(p)); ctx.stroke(); ctx.fillText(String(p), 6, Y(p) + 3); }
  ctx.fillText('V [L] →', w - 52, h - 4);
  ctx.fillText('bar', 4, 9);
  ctx.lineWidth = 1.8;
  for (let k = 0; k < loop.length - 1; k++) {
    ctx.strokeStyle = strokeOf(loop[k].phase)[3];
    ctx.beginPath(); ctx.moveTo(X(loop[k].v), Y(loop[k].p)); ctx.lineTo(X(loop[k + 1].v), Y(loop[k + 1].p)); ctx.stroke();
  }
  const v = cylinderVolume(i, crankDeg);
  const p = cylinderPressure(i, crankDeg, map);
  ctx.fillStyle = ORANGE; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(X(v), Y(p), 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  $('pvVal').innerHTML = `<b>${p.toFixed(1)}</b> bar · <b>${(v * 1000).toFixed(2)}</b> L`;
}

function drawTravel(i, crankDeg) {
  const { ctx, w, h } = setupCanvas($('travel'));
  const X = (ph) => 6 + (ph / 720) * (w - 12);
  const top = 12;
  const bottom = h - 16;
  for (const [a, b, name, col] of STROKES) {
    ctx.fillStyle = col; ctx.globalAlpha = 0.07; ctx.fillRect(X(a), top, X(b) - X(a), bottom - top); ctx.globalAlpha = 1;
    ctx.fillStyle = col; ctx.font = '600 8.5px JetBrains Mono'; ctx.fillText(name.split(' ')[1], X(a) + 3, h - 4);
  }
  const f = firingAngleDeg(i);
  const sc = strokeCheck()[i];
  const s0 = sc.stroke;
  ctx.lineWidth = 1.8; ctx.strokeStyle = INK; ctx.beginPath();
  for (let ph = 0; ph <= 720; ph += 4) {
    const s = pose((f + ph) * DEG).pinDist[i];
    const y = bottom - ((s - (sc.stroke ? STROKE_MIN[i] : 0)) / s0) * (bottom - top);
    if (ph === 0) ctx.moveTo(X(ph), y); else ctx.lineTo(X(ph), y);
  }
  ctx.stroke();
  for (const [key, col] of [['exhaust', MUTED], ['intake', BLUE]]) {
    ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.beginPath();
    for (let ph = 0; ph <= 720; ph += 4) {
      const y = bottom - (valveLift(ph)[key] / SPEC.valveLiftMax) * (bottom - top) * 0.45;
      if (ph === 0) ctx.moveTo(X(ph), y); else ctx.lineTo(X(ph), y);
    }
    ctx.stroke();
  }
  const ph = cyclePhaseDeg(i, crankDeg);
  ctx.strokeStyle = ORANGE; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(X(ph), top - 4); ctx.lineTo(X(ph), bottom); ctx.stroke();
  const st = strokeOf(ph);
  $('strokeName').innerHTML = `<b style="color:${st[3]}">${st[2]}</b> ${ph.toFixed(0)}°`;
}
const STROKE_MIN = (() => {
  const out = new Array(N).fill(Infinity);
  for (let k = 0; k < 720; k++) {
    const p = pose(k * 0.5 * DEG);
    for (let i = 0; i < N; i++) out[i] = Math.min(out[i], p.pinDist[i]);
  }
  return out;
})();

function drawSchematic(p, crankDeg) {
  const { ctx, w, h } = setupCanvas($('schem'));
  const cx = w / 2;
  const cy = h / 2 + 2;
  const S = (h / 2 - 6) / 0.72;
  const P = (x, y) => [cx + x * S, cy - y * S];
  ctx.lineCap = 'round';
  for (let i = 0; i < N; i++) {
    const a = cylinderAxisAngle(i);
    const ux = Math.sin(a);
    const uy = Math.cos(a);
    const nx = uy;
    const ny = -ux;
    const half = SPEC.bore / 2;
    const ph = cyclePhaseDeg(i, crankDeg);
    const ps = ph > 540 ? ph - 720 : ph;
    const burn = ps > -20 && ps < 180 ? burnFraction(ps) * (1 - smooth(0, 150, ps)) : 0;
    const corner = (s, side) => P(ux * s + nx * half * side, uy * s + ny * half * side);
    // シリンダー外形
    ctx.strokeStyle = i === state.tracked ? ORANGE : '#9ea2a8'; ctx.lineWidth = i === state.tracked ? 1.6 : 1;
    ctx.beginPath();
    ctx.moveTo(...corner(0.28, -1)); ctx.lineTo(...corner(HEAD_FACE, -1)); ctx.lineTo(...corner(HEAD_FACE, 1)); ctx.lineTo(...corner(0.28, 1));
    ctx.stroke();
    // 燃焼ガス
    const crown = p.pinDist[i] + CROWN;
    if (burn > 0.02) {
      ctx.fillStyle = `rgba(255,77,23,${Math.min(0.9, burn * 1.2)})`;
      ctx.beginPath();
      ctx.moveTo(...corner(crown, -1)); ctx.lineTo(...corner(HEAD_FACE, -1)); ctx.lineTo(...corner(HEAD_FACE, 1)); ctx.lineTo(...corner(crown, 1));
      ctx.fill();
    }
    // ピストン
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.moveTo(...corner(crown, -0.92)); ctx.lineTo(...corner(crown - 0.06, -0.92)); ctx.lineTo(...corner(crown - 0.06, 0.92)); ctx.lineTo(...corner(crown, 0.92));
    ctx.fill();
    // 番号
    const [lx, ly] = P(ux * 0.69, uy * 0.69);
    ctx.fillStyle = i === state.tracked ? ORANGE : MUTED; ctx.font = '700 9px JetBrains Mono'; ctx.textAlign = 'center';
    ctx.fillText(String(i + 1), lx, ly + 3);
  }
  // クランク円
  ctx.strokeStyle = GRID; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy, GEOM.crankThrow * S, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = INK; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(...P(p.crankPin.x, p.crankPin.y)); ctx.stroke();
  // ロッド
  ctx.strokeStyle = '#7d838a'; ctx.lineWidth = 1.4;
  for (let i = 1; i < N; i++) {
    const a = cylinderAxisAngle(i);
    const k = p.knuckles[i];
    ctx.beginPath(); ctx.moveTo(...P(k.x, k.y)); ctx.lineTo(...P(Math.sin(a) * p.pinDist[i], Math.cos(a) * p.pinDist[i])); ctx.stroke();
  }
  ctx.strokeStyle = '#c9a227'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(...P(p.crankPin.x, p.crankPin.y)); ctx.lineTo(...P(0, p.pinDist[0])); ctx.stroke();
  ctx.fillStyle = '#c9a227';
  ctx.beginPath(); ctx.arc(...P(p.crankPin.x, p.crankPin.y), SPEC.knuckleRadius * S, 0, Math.PI * 2); ctx.globalAlpha = 0.35; ctx.fill(); ctx.globalAlpha = 1;
  ctx.textAlign = 'left';
}

// ---------------------------------------------------------------- コールアウト
const svg = $('leaders');
const callouts = [
  { id: 'trk', anchor: () => cyl[state.tracked].head.localToWorld(tmp.set(0, 0.62, 0.0)) },
  { id: 'master', anchor: (p) => engine.localToWorld(tmp.set(p.crankPin.x * 0.4, (p.crankPin.y + p.pinDist[0]) * 0.55, 0.03)) },
  { id: 'crank', anchor: (p) => engine.localToWorld(tmp.set(p.crankPin.x, p.crankPin.y, 0.07)) },
  { id: 'prop', anchor: () => propGroup.localToWorld(tmp.set(0, 0, 0.2)) },
];
const tmp = new THREE.Vector3();
for (const c of callouts) {
  c.el = document.createElement('div');
  c.el.className = 'co';
  $('callouts').appendChild(c.el);
  c.line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  c.line.setAttribute('fill', 'none');
  c.line.setAttribute('stroke', INK);
  c.line.setAttribute('stroke-width', '1');
  c.dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  c.dot.setAttribute('r', '3');
  c.dot.setAttribute('fill', ORANGE);
  c.dot.setAttribute('stroke', '#fff');
  svg.append(c.line, c.dot);
}

function updateCallouts(p, crankDeg, view) {
  const W = innerWidth;
  const H = innerHeight;
  const i = state.tracked;
  const ph = cyclePhaseDeg(i, crankDeg);
  const visible = {
    trk: true,
    master: fades.get('case').cur < 0.5 || fadeOffsets.cut > 0.6,
    crank: fades.get('case').cur < 0.5 || fadeOffsets.cut > 0.6,
    prop: fades.get('prop').cur > 0.5 && view !== 'top',
  };
  const texts = {
    trk: `CYL ${i + 1} <em>${strokeOf(ph)[2]}</em><small>${cylinderPressure(i, crankDeg, state.map).toFixed(1)} bar · 位相 ${ph.toFixed(0)}°</small>`,
    master: `MASTER ROD<small>CYL 1 に固定 · 傾き ${(p.masterAngle / DEG).toFixed(1)}°</small>`,
    crank: `CRANK PIN<small>r = ${(GEOM.crankThrow * 1000).toFixed(1)} mm · ${(crankDeg % 360).toFixed(0)}°</small>`,
    prop: `PROP · 16:11 減速<small>${Math.round(state.rpm / SPEC.propReduction)} rpm（推定比）</small>`,
  };
  const offsets = { trk: [1, -1], master: [-1, -0.6], crank: [-1, 0.7], prop: [1, 0.8] };
  for (const c of callouts) {
    const a = c.anchor(p).project(camera);
    const sx = (a.x * 0.5 + 0.5) * W;
    const sy = (-a.y * 0.5 + 0.5) * H;
    const on = visible[c.id] && panelsOn && a.z < 1 && sx > 0 && sx < W && sy > 0 && sy < H;
    c.el.style.display = on ? '' : 'none';
    c.line.style.display = on ? '' : 'none';
    c.dot.style.display = on ? '' : 'none';
    if (!on) continue;
    c.el.innerHTML = texts[c.id];
    const [ox, oy] = offsets[c.id];
    const lx = sx + ox * 110;
    const ly = sy + oy * 70;
    const bw = c.el.offsetWidth;
    const bx = Math.min(W - bw - 8, Math.max(8, ox > 0 ? lx : lx - bw));
    c.el.style.transform = `translate(${bx}px, ${ly - 14}px)`;
    c.line.setAttribute('points', `${sx},${sy} ${lx - ox * 30},${ly} ${lx},${ly}`);
    c.dot.setAttribute('cx', String(sx));
    c.dot.setAttribute('cy', String(sy));
  }
}

// ---------------------------------------------------------------- サウンド
let audio = null;
function toggleSound() {
  state.sound = !state.sound;
  if (!state.sound) return;
  try {
    if (!audio) {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const master = ctx.createGain();
      master.gain.value = 0.5;
      const comp = ctx.createDynamicsCompressor();
      master.connect(comp).connect(ctx.destination);
      const buf = ctx.createBuffer(1, ctx.sampleRate * 0.25, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let k = 0; k < d.length; k++) d[k] = (Math.random() * 2 - 1) * Math.exp(-k / (ctx.sampleRate * 0.05));
      audio = { ctx, master, noise: buf };
    }
    audio.ctx.resume();
  } catch (err) {
    console.warn('音声を初期化できません', err);
    state.sound = false;
  }
}
function audioThump(level) {
  if (!state.sound || !audio) return;
  try {
    const { ctx, master, noise } = audio;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 260 + level * 500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5 + level * 0.6, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    src.connect(lp).connect(g).connect(master);
    src.start(t);
    const o = ctx.createOscillator();
    const og = ctx.createGain();
    o.frequency.setValueAtTime(90, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.12);
    og.gain.setValueAtTime(0.4 + level * 0.4, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    o.connect(og).connect(master);
    o.start(t);
    o.stop(t + 0.15);
  } catch (err) {
    console.warn(err);
  }
}
function audioClick() {
  if (!state.sound || !audio) return;
  try {
    const { ctx, master } = audio;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 2400;
    g.gain.setValueAtTime(0.08, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + 0.04);
  } catch (err) {
    console.warn(err);
  }
}

// ---------------------------------------------------------------- ツアー（自動操作）
const cursor = $('cursor');
const cur = { x: innerWidth * 0.5, y: innerHeight * 0.6 };
let tour = null;
let lastInput = performance.now();
const IDLE_MS = 25000;

function placeCursor() { cursor.style.transform = `translate(${cur.x - 3}px, ${cur.y - 2}px)`; }
function frameWait(token, ms, fn) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const step = (now) => {
      if (token.cancelled) return reject(new Error('cancelled'));
      const t = Math.min(1, (now - t0) / ms);
      if (fn) fn(t);
      if (t >= 1) resolve(); else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
function centerOf(el) { const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }
async function moveTo(token, x, y, ms = 750) {
  const fx = cur.x;
  const fy = cur.y;
  await frameWait(token, ms, (t) => { const e = ease(t); cur.x = fx + (x - fx) * e; cur.y = fy + (y - fy) * e; placeCursor(); });
}
async function press(token, sel) {
  const el = document.querySelector(sel);
  if (!el || el.offsetParent === null) return;
  const c = centerOf(el);
  await moveTo(token, c.x, c.y);
  const ring = cursor.querySelector('.ring');
  ring.classList.remove('go'); void ring.offsetWidth; ring.classList.add('go');
  el.click();
  await frameWait(token, 250);
}
async function dragThrottle(token, to, ms = 2200) {
  const b = thr.getBoundingClientRect();
  const X = (v) => b.left + 9 + v * (b.width - 18);
  const from = state.throttle;
  await moveTo(token, X(from), b.top + b.height / 2);
  await frameWait(token, ms, (t) => {
    const v = from + (to - from) * ease(t);
    cur.x = X(v); placeCursor();
    state.throttle = v; setThrottleUI(v);
  });
}
async function setOff(token, key) { if (state[key]) await press(token, `[data-toggle="${key}"]`); }
async function setOn(token, key) { if (!state[key]) await press(token, `[data-toggle="${key}"]`); }
const wait = (token, ms) => frameWait(token, ms);

async function tourScript(token) {
  for (;;) {
    if (state.paused) await press(token, '#pause');
    if (state.timeScale !== 0.05) await press(token, '[data-speed="0.05"]');
    await press(token, '[data-view="hero"]');
    await setOff(token, 'cut'); await setOff(token, 'xray'); await setOff(token, 'isolate'); await setOff(token, 'explode');
    await setOn(token, 'prop'); await setOn(token, 'glass');
    await wait(token, 1500);
    await dragThrottle(token, 0.95);
    await wait(token, 2200);
    await press(token, '[data-cyl="3"]');
    await wait(token, 1200);
    await press(token, '[data-toggle="cut"]');
    await wait(token, 1200);
    await press(token, '[data-view="inside"]');
    await wait(token, 4200);
    await press(token, '[data-cyl="1"]');
    await wait(token, 2500);
    await press(token, '[data-toggle="cut"]');
    await press(token, '[data-toggle="isolate"]');
    await press(token, '[data-view="front"]');
    await wait(token, 4500);
    await press(token, '[data-toggle="isolate"]');
    await press(token, '[data-toggle="explode"]');
    await press(token, '[data-view="hero"]');
    await wait(token, 3500);
    await press(token, '[data-toggle="xray"]');
    await press(token, '[data-view="side"]');
    await wait(token, 3500);
    await press(token, '[data-toggle="explode"]');
    await press(token, '[data-toggle="xray"]');
    await press(token, '[data-cyl="0"]');
    await press(token, '[data-view="hero"]');
    await dragThrottle(token, 0.1, 2600);
    await wait(token, 3000);
  }
}

function startTour() {
  if (tour) return;
  const token = { cancelled: false };
  tour = token;
  cursor.classList.add('show');
  $('mode').className = 'auto';
  $('mode').textContent = 'AUTO TOUR · 操作で手動に';
  tourScript(token).catch(() => {});
}
function stopTour() {
  if (!tour) return;
  tour.cancelled = true;
  tour = null;
  cursor.classList.remove('show');
  $('mode').className = '';
}
for (const type of ['pointerdown', 'wheel', 'keydown', 'touchstart']) {
  window.addEventListener(type, (e) => { if (!e.isTrusted) return; lastInput = performance.now(); stopTour(); }, { capture: true, passive: true });
}
window.addEventListener('pointermove', (e) => { if (e.isTrusted && !tour) lastInput = performance.now(); }, { passive: true });

// ---------------------------------------------------------------- 品質ステップ
const QUALITY = [
  { pr: Math.min(devicePixelRatio, 2), shadow: 2048, chartEvery: 1 },
  { pr: Math.min(devicePixelRatio, 1.5), shadow: 1024, chartEvery: 1 },
  { pr: 1, shadow: 512, chartEvery: 2 },
  { pr: 0.75, shadow: 0, chartEvery: 3 },
];
let qLevel = 0;
let fpsAcc = 0;
let fpsFrames = 0;
let fps = 60;
function applyQuality() {
  const q = QUALITY[qLevel];
  renderer.setPixelRatio(q.pr);
  renderer.shadowMap.enabled = q.shadow > 0;
  if (q.shadow > 0) {
    sun.shadow.mapSize.set(q.shadow, q.shadow);
    if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
  }
  resize();
}
function trackPerf(dt) {
  fpsAcc += dt; fpsFrames++;
  if (fpsAcc >= 1.5) {
    fps = fpsFrames / fpsAcc;
    if (fps < 42 && qLevel < QUALITY.length - 1 && document.visibilityState === 'visible') { qLevel++; applyQuality(); }
    fpsAcc = 0; fpsFrames = 0;
    $('perf').textContent = `${fps.toFixed(0)} fps · Q${qLevel} · ${renderer.info.render.calls} draws`;
  }
}

// ---------------------------------------------------------------- ループ
function resize() {
  const w = innerWidth;
  const h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // 縦長画面では引きで見せる
  camera.fov = w / h < 1 ? 46 : 32;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

let currentView = 'hero';
document.addEventListener('click', (e) => { const b = e.target.closest('[data-view]'); if (b) currentView = b.dataset.view; });

let last = performance.now();
let frame = 0;
let lastFire = -1;
const order = firingOrder();

function tick(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  frame++;

  // エンジンの状態（rpm と MAP は一次遅れで目標に追従）
  const k = 1 - Math.exp(-dt / 0.7);
  state.rpm += (targetRpm(state.throttle) - state.rpm) * k;
  state.map += (targetMap(state.throttle) - state.map) * (1 - Math.exp(-dt / 0.25));
  if (!state.paused) state.theta = (state.theta + (state.rpm / 60) * 360 * dt * state.timeScale) % 11520;
  const crankDeg = state.theta;
  const p = pose(crankDeg * DEG);

  const fireIdx = Math.floor(crankDeg / 80);
  if (fireIdx !== lastFire) {
    if (lastFire >= 0 && !state.paused) audioThump(state.throttle);
    lastFire = fireIdx;
  }
  const firing = order[((fireIdx % 9) + 9) % 9] - 1;

  updateFades(dt);
  applyPose(p, crankDeg);
  updateCamera(dt);
  controls.update();
  renderer.render(scene, camera);

  // パネル
  const out = outputs(state.rpm, state.map);
  $('rpmNum').textContent = String(Math.round(state.rpm)).padStart(4, '0');
  $('sMap').firstChild.textContent = state.map.toFixed(2);
  $('sHp').firstChild.textContent = String(Math.round(out.hp));
  $('sTq').firstChild.textContent = String(Math.round(out.torqueNm));
  $('sProp').firstChild.textContent = String(Math.round(out.propRpm));
  $('sVp').firstChild.textContent = out.meanPistonSpeed.toFixed(1);
  $('sCrank').firstChild.textContent = String(Math.round(crankDeg % 720)).padStart(3, '0');
  $('pvCyl').textContent = `CYL ${state.tracked + 1}`;
  fireCells.forEach((c, j) => c.classList.toggle('fire', order[j] - 1 === firing));
  for (const row of $('check').querySelectorAll('tr[data-row]')) row.classList.toggle('trk', Number(row.dataset.row) === state.tracked);

  if (frame % QUALITY[qLevel].chartEvery === 0 && panelsOn) {
    if ($('left').offsetParent !== null) {
      drawPV(state.tracked, state.map, crankDeg);
      drawTravel(state.tracked, crankDeg);
    }
    drawSchematic(p, crankDeg);
  }
  updateCallouts(p, crankDeg, currentView);

  if (!tour && now - lastInput > IDLE_MS) startTour();
  if (!tour) {
    const left = Math.max(0, Math.ceil((IDLE_MS - (now - lastInput)) / 1000));
    $('mode').textContent = `MANUAL · ${left}s 無操作でツアー`;
  }
  trackPerf(dt);
  requestAnimationFrame(tick);
}

// シェーダーを先にコンパイルしてから開始（透過・切断の状態もすべて同じプログラムを使う）
syncButtons();
applyPose(pose(0), 0);
updateFades(1);
try {
  // 不透明・半透明の両バリアントを先にコンパイルして、ボタン操作時に固まらないようにする
  const all = [...fades.values()].flatMap((g) => g.mats);
  for (const tr of [true, false]) {
    for (const m of all) { m.transparent = tr; m.needsUpdate = true; }
    renderer.compile(scene, camera);
  }
} catch (err) {
  console.warn('シェーダーの事前コンパイルに失敗', err);
}
cur.x = innerWidth * 0.55; cur.y = innerHeight * 0.55; placeCursor();
requestAnimationFrame((t) => { last = t; tick(t); });
startTour();
