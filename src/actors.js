// Model factories for EMBER TIDE. The eight CC0 GLBs under assets/ are fetched
// once as raw buffers; every on-screen character, car and tank is then a FRESH
// GLTFLoader parse of its buffer. That matters twice over: skinned characters
// need their own skeleton per instance (no SkeletonUtils in the vendor tree),
// and the tank GLB is known to collapse under Object3D.clone(). The Kestrel
// jet has no CC0 model anywhere, so it is built from primitives in code here.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const FILES = {
  adventurer: 'assets/adventurer.glb',
  casual: 'assets/casual.glb',
  farmer: 'assets/farmer.glb',
  suit: 'assets/suit.glb',
  woman: 'assets/woman.glb',
  worker: 'assets/worker.glb',
  car: 'assets/car.glb',
  tank: 'assets/tank.glb',
};
export const PED_MODELS = ['casual', 'farmer', 'suit', 'woman', 'worker'];

const buffers = new Map();
const loader = new GLTFLoader();

/** Fetch every GLB once. onProgress(done, total, name) drives the load bar. */
export async function loadAssets(onProgress) {
  const names = Object.keys(FILES);
  let done = 0;
  for (const name of names) {
    const res = await fetch(FILES[name]);
    if (!res.ok) throw new Error(`asset ${name} failed to load (${res.status})`);
    buffers.set(name, await res.arrayBuffer());
    done++;
    if (onProgress) onProgress(done, names.length, name);
  }
}

async function parse(name) {
  const buf = buffers.get(name);
  if (!buf) throw new Error(`asset ${name} not loaded`);
  const gltf = await loader.parseAsync(buf.slice(0), '');
  return gltf;
}

function groundAndCenter(obj) {
  obj.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(obj);
  const c = bb.getCenter(new THREE.Vector3());
  obj.position.x -= c.x; obj.position.z -= c.z; obj.position.y -= bb.min.y;
  const wrap = new THREE.Group();
  wrap.add(obj);
  wrap.userData.size = bb.getSize(new THREE.Vector3());
  return wrap;
}

// ---------------------------------------------------------------------------
// Characters. One parsed instance = one person: own skeleton, own mixer.
// Clips are addressed by the suffix after '|' (Idle, Walk, Run, Gun_Shoot…).
// ---------------------------------------------------------------------------
export class Character {
  constructor(gltf, height) {
    this.group = groundAndCenter(gltf.scene);
    // normalise to the requested standing height
    const h = this.group.userData.size.y;
    if (h > 0.01) this.group.children[0].scale.multiplyScalar(height / h);
    this.group = groundAndCenter(this.group.children[0]);
    this.mixer = new THREE.AnimationMixer(this.group);
    this.actions = new Map();
    for (const clip of gltf.animations) {
      const short = clip.name.includes('|') ? clip.name.split('|').pop() : clip.name;
      this.actions.set(short, this.mixer.clipAction(clip));
    }
    this.current = null;
    this.play('Idle');
  }
  play(name, fade = 0.18) {
    const next = this.actions.get(name);
    if (!next || next === this.current) return;
    next.reset().setLoop(THREE.LoopRepeat).fadeIn(fade).play();
    if (this.current) this.current.fadeOut(fade);
    this.current = next;
  }
  playOnce(name, fade = 0.08) {
    const a = this.actions.get(name);
    if (!a) return;
    a.reset().setLoop(THREE.LoopOnce).setEffectiveWeight(0.9).fadeIn(fade).play();
    a.clampWhenFinished = true;
    // blend back to whatever loop was running
    if (this.current && this.current !== a) this.current.reset().fadeIn(0.25).play();
  }
  update(dt) { this.mixer.update(dt); }
  get position() { return this.group.position; }
}

export async function makeCharacter(model, height = 1.76) {
  const gltf = await parse(model);
  gltf.scene.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
  return new Character(gltf, height);
}

// ---------------------------------------------------------------------------
// Cars. The Quaternius sedan: body material is literally named "Blue" (tint
// it), wheels are separate nodes that can spin and steer. Model forward is
// +Z; normalised to 4.4 m long, origin at ground centre.
// ---------------------------------------------------------------------------
export class CarModel {
  constructor(gltf, color) {
    const scene = gltf.scene;
    this.bodyMat = null;
    scene.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        if (o.material && o.material.name === 'Blue') {
          o.material = o.material.clone();
          o.material.color.set(color);
          this.bodyMat = o.material;
        }
      }
    });
    // normalise: length along Z to 4.4 m
    scene.updateMatrixWorld(true);
    let bb = new THREE.Box3().setFromObject(scene);
    const len = bb.max.z - bb.min.z;
    scene.scale.multiplyScalar(4.4 / len);
    this.group = groundAndCenter(scene);
    addCarLights(this.group);
    // WHEEL PIVOTS. The GLB's wheel nodes carry identity transforms with the
    // tyre geometry baked in car space, so a wheel node's origin is the CAR's
    // centre, not the hub. Setting rotation.x on such a node (the old code)
    // swings the wheel in a metre-wide arc around the car — after enough
    // travel a front wheel ends up on the roof and a rear wheel floats.
    // Instead, wrap each wheel in a steer group parked exactly on its hub
    // (the wheel geometry's bbox centre) with a spin group inside it, and
    // attach() the node so its rendered transform is unchanged. Spinning or
    // steering the pivots then rotates the tyre around its own axle only.
    // (BackWheels is one mesh holding both rear tyres; both hubs lie on the
    // axle line through its bbox centre, so a single pivot is exact there.)
    this.wheels = [];
    this.group.updateMatrixWorld(true);
    const wrapWheel = (node, steerable) => {
      const parent = node.parent;
      if (!parent) return;
      const hub = new THREE.Box3().setFromObject(node).getCenter(new THREE.Vector3());
      const steer = new THREE.Group();
      steer.position.copy(parent.worldToLocal(hub));
      parent.add(steer);
      const spin = new THREE.Group();
      steer.add(spin);
      spin.attach(node);
      this.wheels.push({ spin, steer: steerable ? steer : null });
    };
    const wheelNodes = [];
    this.group.traverse((o) => {
      if (/Front(Left|Right)Wheel/.test(o.name)) wheelNodes.push([o, true]);
      else if (/BackWheels/.test(o.name)) wheelNodes.push([o, false]);
    });
    for (const [node, steerable] of wheelNodes) wrapWheel(node, steerable);
    this.spin = 0;
  }
  /** Roll the wheels for a travelled distance; steer the fronts. */
  roll(distance, steerAngle) {
    // keep the angle wrapped: an ever-growing float loses precision and
    // makes the tyres shimmer after a few minutes of driving
    this.spin = (this.spin + distance / 0.33) % (Math.PI * 2);
    for (const w of this.wheels) {
      w.spin.rotation.x = this.spin;
      if (w.steer) w.steer.rotation.y = steerAngle;
    }
  }
}

export async function makeCar(color = 0x4762a3) {
  const gltf = await parse('car');
  return new CarModel(gltf, color);
}

// ---------------------------------------------------------------
// Head/taillights: shared emissive discs (+ additive glow sprites for the
// headlights) on every car. One pair of materials serves the whole fleet,
// and setHeadlightGlow raises them at night from the day-night cycle.
// ---------------------------------------------------------------
const headMat = new THREE.MeshStandardMaterial({ color: 0x3a382c, emissive: 0xffedb5, emissiveIntensity: 0.3, roughness: 0.4 });
const tailMat = new THREE.MeshStandardMaterial({ color: 0x330d0d, emissive: 0xff2a22, emissiveIntensity: 0.35, roughness: 0.4 });
const headGlowMat = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  gr.addColorStop(0, 'rgba(255,240,200,0.9)'); gr.addColorStop(1, 'rgba(255,220,150,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return new THREE.SpriteMaterial({ map: t, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
})();
export function setHeadlightGlow(nightF) {
  headMat.emissiveIntensity = 0.3 + nightF * 3.6;
  tailMat.emissiveIntensity = 0.35 + nightF * 2.4;
  headGlowMat.opacity = nightF * 0.55;
}
function addCarLights(group) {
  const disc = new THREE.CircleGeometry(0.09, 10);
  for (const sx of [-0.62, 0.62]) {
    const h = new THREE.Mesh(disc, headMat);
    h.position.set(sx, 0.68, 2.21); group.add(h);
    const glow = new THREE.Sprite(headGlowMat);
    glow.scale.setScalar(0.95); glow.position.set(sx, 0.68, 2.32); group.add(glow);
    const t = new THREE.Mesh(disc, tailMat);
    t.position.set(sx, 0.72, -2.21); t.rotation.y = Math.PI; group.add(t);
  }
}

/** Police livery: white body, black mid stripe, and a working light bar. */
export async function makePoliceCar() {
  const car = await makeCar(0xe8e9ea);
  const g = car.group;
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(1.86, 0.34, 2.6),
    new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.6 }));
  stripe.position.set(0, 0.62, -0.2);
  g.add(stripe);
  const bar = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.07, 0.42),
    new THREE.MeshStandardMaterial({ color: 0x1c1e22, roughness: 0.5 }));
  bar.add(base);
  const mkLamp = (x, color) => {
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.13, 0.36),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.4, roughness: 0.3 }));
    lamp.position.set(x, 0.1, 0);
    bar.add(lamp);
    return lamp;
  };
  const lampL = mkLamp(-0.29, 0xff2a20);
  const lampR = mkLamp(0.29, 0x2255ff);
  bar.position.set(0, 1.32, -0.15);
  g.add(bar);
  g.userData.lightBar = { lampL, lampR, phase: Math.random() * 6 };
  // "PORT AUTHORITY" door text via a tiny canvas plate on both sides
  const c = document.createElement('canvas'); c.width = 256; c.height = 48;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#e8e9ea'; ctx.fillRect(0, 0, 256, 48);
  ctx.fillStyle = '#14263e'; ctx.font = '800 25px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('PORT AUTHORITY', 128, 33);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  for (const sd of [-1, 1]) {
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 0.32),
      new THREE.MeshBasicMaterial({ map: tex }));
    plate.position.set(sd * 0.94, 0.64, 0.55);
    plate.rotation.y = sd * Math.PI / 2;
    g.add(plate);
  }
  return car;
}

/** Flash a police light bar (call every frame for active units). */
export function updateLightBar(carGroup, t) {
  const lb = carGroup.userData.lightBar;
  if (!lb) return;
  const s = Math.sin(t * 14 + lb.phase) > 0;
  lb.lampL.material.emissiveIntensity = s ? 3.2 : 0.15;
  lb.lampR.material.emissiveIntensity = s ? 0.15 : 3.2;
}

// ---------------------------------------------------------------------------
// BADAK MBT. Native GLB: barrel along −X, 17.68 × 4.62 × 10.09 m. Scaled
// per-axis to 7.90 long × 2.45 high × 3.55 wide, then the inner wrapper is
// yawed so the barrel faces +Z (the game's forward). The turret node is kept
// for aiming the main gun; the track armature clips play while it moves.
// ---------------------------------------------------------------------------
export class TankModel {
  constructor(gltf) {
    const model = gltf.scene;
    model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
    model.scale.set(7.9 / 17.68, 2.45 / 4.62, 3.55 / 10.09);
    const inner = new THREE.Group();
    inner.add(model);
    inner.rotation.y = Math.PI / 2; // barrel −X -> +Z
    this.group = groundAndCenter(inner);
    this.turret = null;
    this.group.traverse((o) => { if (o.name === 'Tank_Turret') this.turret = o; });
    this.mixer = new THREE.AnimationMixer(this.group);
    this.clips = new Map();
    for (const clip of gltf.animations) {
      const short = clip.name.includes('|') ? clip.name.split('|').pop() : clip.name;
      this.clips.set(short, this.mixer.clipAction(clip));
    }
    this.mode = '';
  }
  /** speed > 0.3 forward, < -0.3 reverse, else idle tracks. */
  setDrive(speed) {
    const want = speed > 0.3 ? 'Tank_Forward' : speed < -0.3 ? 'Tank_Backwards' : '';
    if (want === this.mode) return;
    for (const a of this.clips.values()) a.fadeOut(0.2);
    if (want && this.clips.get(want)) this.clips.get(want).reset().fadeIn(0.2).play();
    this.mode = want;
  }
  update(dt) { this.mixer.update(dt); }
}

export async function makeTank() {
  const gltf = await parse('tank');
  return new TankModel(gltf);
}

// ---------------------------------------------------------------------------
// KESTREL FJ-9 — no CC0 fighter model exists, so the jet is original code:
// tapered fuselage, cone nose, glossy canopy, chin intake, extruded swept
// wings, twin canted fins with ember tips, stabilators, missiles, a live
// afterburner face, and (for the parked one) landing gear. Built facing +X,
// then wrapped so the nose is +Z; normalised to exactly 15.0 m long.
// ---------------------------------------------------------------------------
export function makeJet(withGear) {
  const jet = new THREE.Group();
  const grey = flatMat(0xb4bcc4, 0.55), darkGrey = flatMat(0x878e96, 0.6), dark = flatMat(0x1c2126, 0.5);
  const canopyM = new THREE.MeshStandardMaterial({ color: 0x10161f, roughness: 0.12, metalness: 0.65 });
  const accent = flatMat(0xff8c42, 0.6), missileM = flatMat(0xe9ebee, 0.5);
  function flatMat(color, rough) {
    return new THREE.MeshStandardMaterial({ color, roughness: rough, flatShading: true, metalness: 0.25 });
  }
  const add = (mesh, x, y, z) => { mesh.position.set(x, y, z); mesh.castShadow = true; jet.add(mesh); return mesh; };

  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.98, 9.6, 10), grey);
  body.rotation.z = -Math.PI / 2; add(body, -0.4, 1.5, 0);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.55, 4.4, 10), grey);
  nose.rotation.z = -Math.PI / 2; add(nose, 6.6, 1.5, 0);
  const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.7, 0.9, 10), darkGrey);
  pipe.rotation.z = -Math.PI / 2; add(pipe, -5.6, 1.5, 0);
  const burnerMat = new THREE.MeshStandardMaterial({ color: 0x2a1408, emissive: 0xff7a26, emissiveIntensity: 0.6 });
  const burner = new THREE.Mesh(new THREE.CircleGeometry(0.5, 12), burnerMat);
  burner.rotation.y = -Math.PI / 2; add(burner, -6.06, 1.5, 0);
  add(new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.3, 0.7), darkGrey), 0.7, 2.28, 0);
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.62, 14, 10), canopyM);
  canopy.scale.set(2.5, 0.8, 0.92); add(canopy, 2.7, 2.02, 0);
  add(new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.5, 1.45), dark), 0.4, 0.72, 0);
  add(new THREE.Mesh(new THREE.BoxGeometry(2.9, 0.16, 1.7), darkGrey), 0.4, 1.0, 0);

  function extruded(points, depth) {
    const s = new THREE.Shape();
    s.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) s.lineTo(points[i][0], points[i][1]);
    s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false });
    g.rotateX(Math.PI / 2);
    return g;
  }
  const wingMat = new THREE.MeshStandardMaterial({ color: 0xa7aeb6, roughness: 0.6, flatShading: true, side: THREE.DoubleSide, metalness: 0.25 });
  const wg = extruded([[1.9, 0.55], [-2.7, 0.55], [-1.8, 4.95], [0.5, 4.95]], 0.13);
  const wR = new THREE.Mesh(wg, wingMat); wR.position.set(0, 1.28, 0); wR.castShadow = true; jet.add(wR);
  const wL = new THREE.Mesh(wg, wingMat); wL.scale.z = -1; wL.position.set(0, 1.28, 0); wL.castShadow = true; jet.add(wL);
  const sg = extruded([[0.9, 0.3], [-1.2, 0.3], [-0.8, 2.6], [0.35, 2.6]], 0.1);
  const stR = new THREE.Mesh(sg, wingMat); stR.position.set(-5.0, 1.35, 0); stR.castShadow = true; jet.add(stR);
  const stL = new THREE.Mesh(sg, wingMat); stL.scale.z = -1; stL.position.set(-5.0, 1.35, 0); stL.castShadow = true; jet.add(stL);

  function finGeo() {
    const s = new THREE.Shape();
    s.moveTo(0.9, 0); s.lineTo(-1.3, 0); s.lineTo(-1.7, 1.9); s.lineTo(-0.5, 1.9); s.closePath();
    return new THREE.ExtrudeGeometry(s, { depth: 0.1, bevelEnabled: false });
  }
  const fg = finGeo();
  for (const sd of [1, -1]) {
    const fin = new THREE.Mesh(fg, darkGrey);
    fin.position.set(-4.6, 2.0, sd * 0.58);
    fin.rotation.x = sd * 0.30;
    fin.castShadow = true; jet.add(fin);
    const tip = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.22, 0.13), accent);
    tip.position.set(-5.75, 3.86, sd * (0.58 + Math.tan(0.30) * 1.86));
    tip.rotation.x = sd * 0.30; jet.add(tip);
  }
  function missile(len, r) {
    const m = new THREE.Group();
    const b = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 8), missileM);
    b.rotation.z = -Math.PI / 2; m.add(b);
    const tip = new THREE.Mesh(new THREE.ConeGeometry(r, r * 3.2, 8), accent);
    tip.rotation.z = -Math.PI / 2; tip.position.x = len / 2 + r * 1.6; m.add(tip);
    for (const a of [0, Math.PI / 2]) {
      const f = new THREE.Mesh(new THREE.BoxGeometry(0.5, a ? 0.05 : 0.55, a ? 0.55 : 0.05), darkGrey);
      f.position.x = -len / 2 + 0.3; m.add(f);
    }
    m.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    return m;
  }
  for (const sd of [1, -1]) {
    const m1 = missile(3.3, 0.17); m1.position.set(-0.4, 0.98, sd * 2.9); jet.add(m1);
    const m2 = missile(2.5, 0.13); m2.position.set(-0.9, 1.22, sd * 4.85); jet.add(m2);
  }
  if (withGear) {
    const strutM = flatMat(0xd6dade, 0.4), tyreM = flatMat(0x17181a, 0.9);
    const wheel = (x, z, r) => {
      const topY = 1.02;
      const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, topY - r, 8), strutM);
      strut.position.set(x, r + (topY - r) / 2, z); jet.add(strut);
      const w = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.2, 12), tyreM);
      w.rotation.x = Math.PI / 2; w.position.set(x, r, z); w.castShadow = true; jet.add(w);
    };
    wheel(3.6, 0, 0.30); wheel(-0.7, 0.88, 0.44); wheel(-0.7, -0.88, 0.44);
  }
  // normalise to 15 m long, ground it, then wrap facing +Z
  jet.updateMatrixWorld(true);
  let bb = new THREE.Box3().setFromObject(jet);
  jet.scale.setScalar(15.0 / (bb.max.x - bb.min.x));
  const inner = new THREE.Group();
  inner.add(jet);
  inner.rotation.y = -Math.PI / 2; // nose +X -> +Z
  const wrap = groundAndCenter(inner);
  wrap.userData.burnerMat = burnerMat;
  wrap.userData.setBurner = (v) => { burnerMat.emissiveIntensity = v; };
  return wrap;
}
