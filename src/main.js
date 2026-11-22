// EMBER TIDE — boot, camera, input, menus, save/load, and the frame loop.
// The modules do the work: world.js builds Port Saraya, play.js simulates it,
// story.js gives it a plot, hud.js draws the interface. This file owns the
// renderer and the third-person camera, translates keys into the simulation's
// input shape, and stages the deterministic ?shot= scenes the scorer renders.

import * as THREE from 'three';
import { buildWorld } from './world.js';
import { loadAssets, makeCar, makePoliceCar, makeTank, makeJet, setHeadlightGlow } from './actors.js';
import { Sim, VehicleEnt } from './play.js';
import { Story } from './story.js';
import { Hud } from './hud.js';
import { Events, clamp, angleDelta, turnToward, QualityController } from './util.js';

const params = new URLSearchParams(location.search);
const SHOT = params.get('shot');
const SEED = Number(params.get('seed') || 1);
const TEST = params.get('test') === '1';
const SAVE_KEY = 'ember-tide-save-v1';

const $ = (id) => document.getElementById(id);
const events = new Events();

// ------------------------------------------------------------ renderer --
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.25)); // capped: fill-rate is the weak-iGPU bottleneck
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false;
$('app').appendChild(renderer.domElement);

// ------------------------------------------------- adaptive quality --
// Round 2: round 1's fixed caps were not enough on a weak iGPU at 1080p,
// so quality now adapts live. The controller (util.js, pure logic) watches
// smoothed FPS and steps tiers; this table is what a tier MEANS here.
// Tier 0 is exactly the shipped round-1 look. ?shot= frames never adapt:
// the controller is not even created, so staged renders stay bit-exact.
const QT = [
  { pr: Math.min(devicePixelRatio, 1.25), shadow: 768 },
  { pr: 1.0, shadow: 768 },
  { pr: 0.85, shadow: 512 },
  { pr: 0.7, shadow: 0 }, // 0 = shadows off
];
const quality = SHOT ? null : new QualityController();
let qShadowsOff = false;
function applyQuality(t) {
  const q = QT[t];
  renderer.setPixelRatio(q.pr);
  renderer.setSize(innerWidth, innerHeight);
  if (!world || !world.sun) return;
  const sun = world.sun;
  const off = q.shadow === 0;
  if (off !== qShadowsOff) {
    qShadowsOff = off;
    renderer.shadowMap.enabled = !off;
    sun.castShadow = !off;
    // Toggling the shadow map changes every shader's defines: flag all
    // materials so they recompile (a one-frame hitch on a rare tier flip).
    scene.traverse((o) => {
      if (!o.material) return;
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of ms) m.needsUpdate = true;
    });
  }
  if (!off && sun.shadow.mapSize.x !== q.shadow) {
    sun.shadow.mapSize.set(q.shadow, q.shadow);
    if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; } // force realloc at the new size
  }
}

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 900);
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ------------------------------------------------------------ state --
let world, sim, story, hud;
let mode = 'loading';                    // loading | menu | play | pause | shot
let clockMin = 17 * 60 + 36;
let camYaw = Math.PI, camPitch = 0.32, camDist = 7.5;
let mouseIdle = 0;
let camLock = false; // staged shots may pin the camera (e.g. front chase view)
const keys = new Set();
let fireHeld = false, firePressedEdge = false, interactEdge = false;

function saveGame() {
  // Never persist a corpse: pausing inside the death window used to save
  // health 0, and Continue then revived Raka at 0 HP (dead flag unsaved).
  if (!sim || !sim.player || sim.player.dead) return;
  const data = {
    money: sim.player.money, health: sim.player.health, armour: sim.player.armour,
    ammo: sim.player.ammo, weapon: sim.player.weapon,
    clock: Math.round(clockMin),
    story: story ? story.serialize() : null,
  };
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(data)); } catch { /* private mode */ }
}
function loadSave() {
  try { const raw = localStorage.getItem(SAVE_KEY); return raw ? JSON.parse(raw) : null; }
  catch { return null; }
}

// ------------------------------------------------------------ input --
addEventListener('keydown', (e) => {
  if (e.repeat) return;
  keys.add(e.code);
  if (e.code === 'KeyE') interactEdge = true;
  if (e.code === 'Space') { firePressedEdge = true; e.preventDefault(); }
  if (e.code === 'KeyQ' && quality) { // quality override: AUTO -> HIGH -> LOW
    quality.cycleMode();
    applyQuality(quality.tier);
    if (hud) hud.toast(`QUALITY — ${quality.mode.toUpperCase()}`);
  }
  if ((e.code === 'KeyP' || e.code === 'Escape') && mode === 'play') pauseGame();
  else if (e.code === 'Escape' && mode === 'pause') resumeGame();
  if (mode === 'play' && sim && sim.player) {
    if (e.code === 'Digit1' && sim.player.ammo.pistol > 0) sim.player.weapon = 'pistol';
    if (e.code === 'Digit2' && sim.player.ammo.carbine > 0) sim.player.weapon = 'carbine';
    if (e.code === 'Digit0') sim.player.weapon = 'fists';
  }
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('mousedown', (e) => { if (mode === 'play' && e.button === 0) { fireHeld = true; firePressedEdge = true; } });
addEventListener('mouseup', (e) => { if (e.button === 0) fireHeld = false; });
addEventListener('mousemove', (e) => {
  if (mode !== 'play' || document.pointerLockElement !== renderer.domElement) return;
  camYaw -= e.movementX * 0.0031;
  camPitch = clamp(camPitch + e.movementY * 0.0026, -0.12, 1.05);
  mouseIdle = 0;
});
renderer.domElement.addEventListener('click', () => {
  if (mode === 'play' && document.pointerLockElement !== renderer.domElement) {
    renderer.domElement.requestPointerLock();
  }
});

function readInput() {
  const k = (c) => keys.has(c);
  const fwd = (k('KeyW') || k('ArrowUp')) ? 1 : 0;
  const back = (k('KeyS') || k('ArrowDown')) ? 1 : 0;
  const left = (k('KeyA') || k('ArrowLeft')) ? 1 : 0;
  const right = (k('KeyD') || k('ArrowRight')) ? 1 : 0;
  // camera-relative ground movement
  const fx = Math.sin(camYaw), fz = Math.cos(camYaw);
  const rx = Math.cos(camYaw), rz = -Math.sin(camYaw);
  const moveX = fx * (fwd - back) + rx * (right - left);
  const moveZ = fz * (fwd - back) + rz * (right - left);
  const inJet = sim && sim.player && sim.player.vehicle && sim.player.vehicle.kind === 'jet';
  const input = {
    moveX, moveZ,
    jump: k('Space'),   // on foot only; vehicles read Space via burner/firePressed below
    run: k('ShiftLeft') || k('ShiftRight'),
    throttle: fwd - back,
    steer: left - right,
    interact: interactEdge,
    fire: fireHeld || k('KeyF'),
    firePressed: firePressedEdge || fireHeld,
    turretYaw: camYaw,
    aimOrigin: camera.position.clone(),
    aimDir: camera.getWorldDirection(new THREE.Vector3()),
    jetThrottle: inJet ? (k('KeyW') ? 1 : k('KeyS') ? -1 : 0) : 0,
    pitchUp: k('ArrowDown'),
    pitchDown: k('ArrowUp'),
    burner: k('Space'),
  };
  interactEdge = false;
  firePressedEdge = false;
  return input;
}

// ------------------------------------------------------------ camera --
const _camTarget = new THREE.Vector3();
const _camPos = new THREE.Vector3();
function updateCamera(dt) {
  const pp = sim.playerPos();
  const veh = sim.player && sim.player.vehicle;
  let targetY = 1.6, dist = camDist, pitch = camPitch;
  if (veh) {
    dist = veh.kind === 'jet' ? 13 : veh.kind === 'tank' ? 10.5 : 8.2;
    targetY = veh.kind === 'jet' ? 2 : 1.5;
    // gently settle behind the vehicle when the mouse is idle
    mouseIdle += dt;
    if (!camLock && mouseIdle > 2.2 && veh.kind !== 'jet') {
      camYaw = turnToward(camYaw, veh.heading, dt * 1.6);
    }
  } else if (sim.player) {
    mouseIdle += dt;
    if (!camLock && mouseIdle > 3.5 && sim.player.speed > 0.5) {
      camYaw = turnToward(camYaw, sim.player.heading, dt * 1.2);
    }
  }
  if (mode === 'menu') {
    // slow harbour orbit behind the title
    const t = performance.now() * 0.00004;
    _camTarget.set(-6, 2, 84);
    _camPos.set(-6 + Math.sin(t) * 26, 7.5, 84 + Math.cos(t) * 26);
    camera.position.lerp(_camPos, 0.04);
    camera.lookAt(_camTarget);
    return;
  }
  const fx = Math.sin(camYaw), fz = Math.cos(camYaw);
  _camTarget.set(pp.x, (sim.player && sim.player.vehicle && sim.player.vehicle.kind === 'jet' ? sim.player.vehicle.pos.y : 0) + targetY, pp.z);
  if (veh && veh.kind === 'jet') _camTarget.y = veh.pos.y + 2;
  const back = dist, up = Math.sin(pitch) * dist + 1.2;
  _camPos.set(
    _camTarget.x - fx * Math.cos(pitch) * back,
    Math.max(0.6, _camTarget.y + up),
    _camTarget.z - fz * Math.cos(pitch) * back,
  );
  if (sim.shake > 0.02) {
    _camPos.x += (Math.random() - 0.5) * sim.shake * 0.5;
    _camPos.y += (Math.random() - 0.5) * sim.shake * 0.4;
  }
  camera.position.lerp(_camPos, mode === 'shot' ? 1 : 0.35);
  camera.lookAt(_camTarget.x + fx * 6, _camTarget.y + 0.4, _camTarget.z + fz * 6);
  void angleDelta;
}

// ------------------------------------------------------------ flow --
function startPlay(fromSave) {
  mode = 'play';
  $('menu').classList.add('hidden');
  $('loading').classList.add('hidden');
  hud.show();
  const p = sim.player;
  if (fromSave) {
    const d = fromSave;
    p.money = d.money ?? p.money;
    p.health = d.health ?? 100;
    p.armour = d.armour ?? 0;
    p.ammo = d.ammo || p.ammo;
    if (d.weapon && d.weapon !== 'fists') p.weapon = d.weapon;
    if (typeof d.clock === 'number') clockMin = d.clock;
    story.restore(d.story);
    if (story.done) story.finishStory();
    else story.start(story.idx, { silent: true });
    hud.toast('Welcome back to Port Saraya');
  } else {
    try { localStorage.removeItem(SAVE_KEY); } catch { /* noop */ }
    clockMin = 8 * 60; // a new life in Port Saraya starts at 08:00
    story.start(0);
  }
}
function pauseGame() {
  if (mode !== 'play') return;
  mode = 'pause';
  $('pause').classList.remove('hidden');
  if (document.pointerLockElement) document.exitPointerLock();
  saveGame();
}
function resumeGame() {
  if (mode !== 'pause') return;
  mode = 'play';
  $('pause').classList.add('hidden');
}
function onPlayerDead() {
  hud.banner('WASTED', 'PORT SARAYA GENERAL HOSPITAL');
  setTimeout(() => {
    const p = sim.player;
    if (p.vehicle) {
      const v = p.vehicle;
      v.driver = 'parked'; p.vehicle = null;
      // A Kestrel abandoned mid-air stays frozen in the sky forever (only
      // its pilot's update moves it). Put her back on the apron instead.
      if (v.kind === 'jet' && !v.onGround) {
        const jp = world.places.jetPark;
        v.group.position.set(jp.x, 0, jp.z);
        v.heading = jp.heading; v.group.rotation.set(0, jp.heading, 0);
        v.onGround = true; v.pitch = 0; v.roll = 0; v.speed = 0; v.throttle = 0;
      }
    }
    p.char.group.visible = true;
    const h = world.places.hospital;
    p.char.group.position.set(h.x, 0, h.z);
    p.heading = 0;
    p.health = 100;
    p.dead = false;
    const fee = Math.min(150, Math.floor(p.money * 0.1));
    p.money -= fee;
    sim.clearWanted();
    hud.toast(`Hospital bill: $${fee} · the crew covered the rest`);
    saveGame();
  }, 2400);
}

// ------------------------------------------------------------ shots --
// Deterministic staged scenes behind ?shot=cover|street|chase|base (the
// starter's start/play/end names alias to cover/street/base). The world is
// the real game world; actors are posed, animations keep breathing through
// Sim.animateOnly, and __SHOT_READY tells the renderer we are set.
async function stageShot(name) {
  const alias = { start: 'cover', play: 'street', end: 'base' };
  const shot = alias[name] || name;
  const p = sim.player;
  clockMin = 17 * 60 + 42; // cover default: golden hour (the game's identity)
  // each staged shot pins the day-night cycle to its own phase:
  // street = morning 08:15, chase = night 21:40, base = midday 12:30
  p.money = 18450;
  p.health = 72; p.armour = 55;
  p.ammo.carbine = 30; p.weapon = 'carbine';
  hud.setCrewStatus('mira', 'Comms');
  hud.setCrewStatus('dario', 'Workshop');
  hud.setCrewStatus('sinta', 'At the gate', '#ff5348');
  const P = world.places;
  const placePlayer = (x, z, heading) => {
    p.char.group.position.set(x, 0, z);
    p.heading = heading;
    p.char.group.rotation.y = heading;
    camYaw = heading; camPitch = 0.3;
  };
  if (shot === 'cover') {
    placePlayer(0, 71.6, Math.PI / 2);
    p.char.play('Idle_Gun_Pointing');
    const t1 = new VehicleEnt('tank', await makeTank(), 'BADAK MBT');
    t1.group.position.set(19, 0, 73.6); t1.heading = -Math.PI / 2; t1.group.rotation.y = t1.heading;
    t1.driver = 'parked'; scene.add(t1.group); sim.vehicles.push(t1);
    const t2 = new VehicleEnt('tank', await makeTank(), 'BADAK MBT');
    t2.group.position.set(32, 0, 78.8); t2.heading = -Math.PI / 2; t2.group.rotation.y = t2.heading;
    t2.driver = 'parked'; scene.add(t2.group); sim.vehicles.push(t2);
    const fly = makeJet(false);
    fly.position.set(58, 11.5, 76);
    fly.rotation.set(0, Math.PI / 2, 0); fly.rotateZ(0.35);
    if (fly.userData.setBurner) fly.userData.setBurner(3.6);
    scene.add(fly);
    const cop = new VehicleEnt('police', await makePoliceCar(), 'PORT AUTHORITY');
    cop.group.position.set(44, 0, 70.8); cop.heading = -Math.PI / 2; cop.group.rotation.y = cop.heading;
    cop.driver = 'parked'; scene.add(cop.group); sim.vehicles.push(cop);
    sim.wanted = 5.2;
    hud.setMission({
      tag: 'MISSION 5 · ENDGAME JOB', title: 'STEAL THE SKY',
      obj: 'Auction morning. Get through the <b>Sable Point</b> gate in the shift-change chaos and lift the <b>Kestrel</b> — the army is rolling armour down Jalan Ombak to stop you.',
      next: '▸ NEXT — Reach the Sable Point gate · armour on the strand',
      prog: 0.86, sub: 'CHECKPOINT 4 / 5 · 900 M TO SABLE POINT GATE',
    });
    hud.dialogue('sinta', 'Raka — armour column on Jalan Ombak, and a Kestrel just lit its burner over the bay. Whatever you are doing, do it faster.', 30);
  } else if (shot === 'street') {
    // Morning at Pelangi Pier, reframed as a harbour postcard: Raka stands
    // at the deck edge looking WSW along the pier, low deck-level camera
    // close behind him. The Cahaya Pagi rides at anchor centre-right in
    // near-profile — cream side, raked bow and mast against the morning
    // sky, water and the headland behind her — containers and a gantry
    // crane fill the right edge, and the 08:15 sun sits behind the camera
    // so the bay glare stays out of frame and her side rakes warm.
    clockMin = 8 * 60 + 15;
    p.money = 6240; p.health = 100; p.armour = 20;
    p.weapon = 'pistol'; p.ammo.pistol = 12;
    placePlayer(42, 126.6, -0.78);
    camPitch = 0.14; camDist = 6.5; // low, close deck-level camera for this shot
    p.char.play('Idle');
    const spots = [[30, 123.5], [36, 120.5], [24, 125]];
    sim.peds.forEach((ped, i) => {
      if (i < spots.length) { ped.char.group.position.set(spots[i][0], 0, spots[i][1]); ped.char.play('Walk'); }
    });
    { // shot-local pier dressing: crate stack by Raka, bollards receding
      // along the edge toward the boat, a sagging mooring line to her stern
      const woodM = new THREE.MeshStandardMaterial({ color: 0x8a6a4a, roughness: 0.85 });
      const darkM = new THREE.MeshStandardMaterial({ color: 0x2e3438, roughness: 0.5, metalness: 0.5 });
      const crate = (x, y, z, s, ry) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), woodM);
        m.position.set(x, y, z); m.rotation.y = ry; m.castShadow = true; scene.add(m);
      };
      crate(45.8, 0.55, 124.3, 1.1, 0.2); crate(45.9, 1.62, 124.2, 0.95, -0.15); crate(47.3, 0.45, 125.3, 0.9, 0.5);
      crate(28.5, 0.5, 125.6, 1.0, -0.3);
      for (const bx of [22, 31, 40, 49]) {
        const b = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, 0.75, 10), darkM);
        b.position.set(bx, 0.38, 127.2); b.castShadow = true; scene.add(b);
      }
      const a = new THREE.Vector3(31, 0.85, 127.2), b = new THREE.Vector3(16.5, 1.6, 135.8);
      const ropePts = [];
      for (let i = 0; i <= 6; i++) {
        const t = i / 6, pt = a.clone().lerp(b, t);
        pt.y -= Math.sin(t * Math.PI) * 0.55; // sag
        ropePts.push(pt);
      }
      scene.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(ropePts),
        new THREE.LineBasicMaterial({ color: 0x2a2f33 })));
    }
    hud.setCrewStatus('sinta', 'Aboard Cahaya Pagi');
    hud.setMission({
      tag: 'MISSION 2 · STORY JOB', title: 'PAPER TRAIL',
      obj: 'Morning on the harbour. The <b>Cahaya Pagi</b> rides at anchor off <b>Pelangi Pier</b> with the auction clock running — walk the deck, keep the money moving, and don\'t let the Authority clock the crew.',
      next: '▸ NEXT — Meet Sinta aboard the Cahaya Pagi',
      prog: 0.24, sub: 'ON FOOT · PELANGI PIER',
    });
    hud.dialogue('mira', 'Easy, Raka. Gulls, diesel, wet rope — the pier swallows us better than any garage. Sinta\'s already aboard, and the tide won\'t wait.', 30);
  } else if (shot === 'chase') {
    clockMin = 21 * 60 + 40;
    const gt = sim.vehicles.find((v) => v.name === 'EMBER GT');
    gt.group.position.set(34, 0, 73.3); gt.heading = Math.PI / 2; gt.group.rotation.y = gt.heading;
    gt.speed = 32.8;
    placePlayer(30.5, 71, Math.PI / 2);
    sim.enterVehicle(gt);
    gt.speed = 32.8;
    const c1 = await sim._spawnPoliceUnit();
    c1.group.position.set(17, 0, 73.6); c1.heading = Math.PI / 2; c1.group.rotation.y = c1.heading; c1.speed = 30;
    const c2 = await sim._spawnPoliceUnit();
    c2.group.position.set(21, 0, 79.1); c2.heading = Math.PI / 2; c2.group.rotation.y = c2.heading; c2.speed = 29;
    const tk = new VehicleEnt('tank', await makeTank(), 'BADAK MBT');
    tk.group.position.set(2, 0, 77.2); tk.heading = Math.PI / 2; tk.group.rotation.y = tk.heading;
    tk.driver = 'parked'; scene.add(tk.group); sim.vehicles.push(tk);
    sim.wanted = 5.2;
    // front three-quarter view: the GT charges the camera while the pursuit
    // (two Authority units + a Badak) fills the frame behind it
    camYaw = Math.PI / 2 + Math.PI - 0.4; camPitch = 0.22; camLock = true;
    hud.setMission({
      tag: 'MISSION 5 · ENDGAME JOB', title: 'STEAL THE SKY',
      obj: 'Full pursuit on the strand. The <b>Port Authority</b> has units on your bumper and <b>Sable Point</b> armour is rolling in behind them.',
      next: '▸ NEXT — Lose them before the Sable Point gate',
      prog: 0.9, sub: 'PURSUIT · 640 M TO THE GATE · KEEP IT OVER 100',
    });
    hud.dialogue('mira', "Three units on your tail and a tank behind them, Raka — floor it, and whatever you do, don't kiss the palms.", 30);
  } else { // base
    clockMin = 12 * 60 + 30;
    placePlayer(194, 36, 2.35);
    p.char.play('Idle_Gun_Pointing');
    const tk = sim.poolTank;
    tk.group.position.set(224, 0, 30); tk.heading = 2.9; tk.group.rotation.y = 2.9;
    story._moveCrew('dario', 214, 33, -1.2);
    sim.wanted = 5.2;
    hud.setCrewStatus('dario', 'At the tank');
    hud.setMission({
      tag: 'MISSION 5 · ENDGAME JOB', title: 'STEAL THE SKY',
      obj: 'Ninety seconds of shift-change chaos. The <b>Badak</b> is fuelled, the <b>Kestrel</b> is armed — pick your ride out of <b>Sable Point</b>.',
      next: '▸ NEXT — Choose your ride: tank or jet',
      prog: 0.8, sub: 'INSIDE THE WIRE · GATE CLOSES IN 01:27',
    });
    hud.dialogue('mira', "Gate's ours for ninety seconds, Raka. Tank's fuelled, jet's armed — pick your ride and don't look back.", 30);
  }
  void P;
  // let the staged frame settle (mixers mid-stride, bars lit) before signalling
  await new Promise((r) => setTimeout(r, 650));
  window.__SHOT_READY = true;
}

// ------------------------------------------------------------ boot --
async function boot() {
  hud = new Hud();
  await loadAssets((done, total, name) => {
    $('loadfill').style.width = `${Math.round((done / total) * 100)}%`;
    $('loadmsg').textContent = `ROLLING INTO PORT SARAYA… ${name.toUpperCase()} ${done}/${total}`;
  });
  world = buildWorld(scene, SEED);
  sim = new Sim(scene, world, events, SEED);
  story = new Story(sim, world, hud, events);
  await sim.spawnPlayer();
  await sim.spawnPeds(13);
  await sim.spawnTraffic(9);
  await sim.spawnParked();
  await sim.spawnBaseHardware();
  await story.initCrew();
  events.on('save', saveGame);
  events.on('playerDead', onPlayerDead);
  events.on('toast', (t) => hud.toast(typeof t === 'string' ? t : t.text || ''));
  events.on('enterVehicle', ({ kind }) => { if (kind === 'car') hud.toast('E — exit · WASD — drive'); });

  $('btnNew').addEventListener('click', () => startPlay(null));
  $('btnContinue').addEventListener('click', () => { const d = loadSave(); if (d) startPlay(d); });
  $('btnResume').addEventListener('click', resumeGame);
  $('btnRestart').addEventListener('click', () => { resumeGame(); story.restartMission(); });
  $('btnQuit').addEventListener('click', () => location.reload());
  if (!loadSave()) $('btnContinue').disabled = true;

  if (TEST) {
    window.__ET = {
      sim, story, world, hud,
      startNew: () => startPlay(null),
      setTimeScale: (x) => { timeScale = x; },
      get clockMin() { return clockMin; },
      setClockMin: (m) => { clockMin = m; },
      get mode() { return mode; },
      raycastAt: (nx, ny) => {
        const rc = new THREE.Raycaster();
        rc.setFromCamera({ x: nx, y: ny }, camera);
        return rc.intersectObjects(scene.children, true).slice(0, 4).map((h) => ({
          name: h.object.name || h.object.type,
          color: h.object.material && h.object.material.color ? h.object.material.color.getHexString() : '?',
          dist: +h.distance.toFixed(1),
          at: h.point.toArray().map((v) => +v.toFixed(1)),
        }));
      },
      pixelAt: (x, y) => new Promise((res) => {
        requestAnimationFrame(() => {
          const c = document.createElement('canvas');
          c.width = innerWidth; c.height = innerHeight;
          const g = c.getContext('2d');
          g.drawImage(renderer.domElement, 0, 0);
          const d = g.getImageData(x, y, 1, 1).data;
          res([d[0], d[1], d[2]]);
        });
      }),
      sceneKids: () => scene.children.length,
      hideKids: (from, to, vis) => { for (let i = from; i < Math.min(to, scene.children.length); i++) scene.children[i].visible = vis; },
    };
  }
  if (SHOT) {
    await stageShot(SHOT);
    mode = 'shot';
    $('loading').classList.add('hidden');
    hud.show();
    $('ctrlbar').style.display = 'none'; // staged frames keep the shipped composition
  } else {
    mode = 'menu';
    $('loading').classList.add('hidden');
    $('menu').classList.remove('hidden');
  }
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------ loop --
let last = performance.now();
let timeScale = 1; // the ?test=1 hook may raise this; real play is always 1
let frameCount = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const rawDt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (mode === 'pause') { renderer.render(scene, camera); return; }
  // Adaptive quality: feed every live frame (menu orbit included — it is
  // the same city render, so the game pre-adapts before play starts).
  // Paused frames are static and would lie about headroom, so they skip.
  if (quality) { const t = quality.feed(rawDt); if (t >= 0) applyQuality(t); }
  const dt = rawDt * timeScale;
  // The day-night cycle: 1 game-minute per real second (a full day in 24
  // minutes of play). The clock runs in play and behind the menu; staged
  // shots pin it, so it holds still there.
  if (mode === 'play' || mode === 'menu') clockMin = (clockMin + dt) % 1440;
  const input = mode === 'play' ? readInput() : {
    moveX: 0, moveZ: 0, run: false, throttle: 0, steer: 0, interact: false,
    fire: false, firePressed: false, turretYaw: camYaw,
    aimOrigin: camera.position.clone(), aimDir: new THREE.Vector3(0, 0, 1),
    jetThrottle: 0, pitchUp: false, pitchDown: false, burner: false,
  };
  if (mode === 'shot') {
    sim.animateOnly(rawDt);
    if (story) story.animateCrew(rawDt);
  } else {
    // Substep the simulation: physics never sees a step over 1/30 s, so a
    // long frame (or a raised test timeScale) can never tunnel a car
    // through a wall. Edge inputs (interact, shot) fire on substep one only.
    const steps = Math.min(24, Math.max(1, Math.ceil(dt / (1 / 30))));
    const sdt = dt / steps;
    for (let i = 0; i < steps; i++) {
      sim.update(sdt, i === 0 ? input : { ...input, firePressed: false, interact: false });
      if (story) story.update(sdt);
    }
  }
  const pp = sim.playerPos();
  world.update(dt, pp);
  world.setClock(clockMin);
  setHeadlightGlow(world.nightF || 0);
  if (mode === 'play' || mode === 'shot') {
    const p = sim.player;
    const veh = p.vehicle;
    const loc = world.locationAt(pp.x, pp.z);
    hud.setLocation(loc.name, loc.sub);
    hud.update(dt, {
      money: p.money, clockMin, stars: sim.stars,
      health: p.health, armour: p.armour,
      weapon: p.weapon, ammo: p.ammo[p.weapon] || 0,
      vehicle: veh, speedKmh: veh ? veh.speed * 3.6 : 0,
      prompt: sim.promptText || null,
      player: { x: pp.x, z: pp.z, heading: veh ? veh.heading : p.heading },
      vehicles: sim.vehicles, marker: story && story.active ? story._stepTarget() : null,
      crewBlips: story ? story.crewBlips() : [], t: sim.time,
    });
  }
  updateCamera(rawDt);
  // The sun moves slowly (1 game-minute per second): refreshing the shadow
  // map every other frame is invisible and halves the shadow pass cost.
  if ((frameCount++ & 1) === 0) renderer.shadowMap.needsUpdate = true;
  renderer.render(scene, camera);
}

boot().catch((err) => {
  $('loadmsg').textContent = `FAILED TO LOAD — ${err.message}`;
  console.error(err);
});
