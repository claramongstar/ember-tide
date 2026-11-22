// The living simulation of EMBER TIDE: Raka on foot, pedestrians, traffic,
// parked cars, and the driving model every vehicle shares. Police, the wanted
// system, combat and the military escalation live in the second half of this
// file; missions live in story.js and steer everything through events.

import * as THREE from 'three';
import { makeCharacter, makeCar, makePoliceCar, makeTank, makeJet, updateLightBar, PED_MODELS } from './actors.js';
import { clamp, lerp, turnToward, angleDelta, collideCircle, segmentBlocked, dist2d, makeRng } from './util.js';
import { AVENUES, STREETS } from './world.js';

const CAR_COLORS = [0x4762a3, 0xb6492f, 0x2e7a6a, 0xd9a05b, 0xe8e3d8, 0x7a4a6e, 0x3f6e46, 0xc2c7cc, 0x8c2f39, 0xe07b2a];
const CAR_NAMES = ['SARAYA SEDAN', 'EMBER GT', 'TIDE HATCH', 'OMBak WAGON', 'STRAND COUPE'];
// Past this z the pier deck is behind the player and the harbour water
// (surface y = -0.5 in world.js) is underfoot: on-foot movement switches
// to swimming. PIER_Z in world.js is 128 and the deck slab ends at z=129.
const SWIM_LINE_Z = 129.3;

export class VehicleEnt {
  constructor(kind, model, name) {
    this.kind = kind;                    // 'car' | 'police' | 'tank' | 'jet'
    this.model = model;                  // CarModel | TankModel | jet wrap group
    this.group = model.group || model;
    this.name = name || 'SEDAN';
    this.heading = 0;
    this.speed = 0;
    this.driver = 'parked';              // parked | traffic | police | player | column
    this.health = 100;
    this.destroyed = false;
    this.steerVis = 0;
    this.traffic = null;                 // { seg, dir, turnTarget, lastJunction }
    this.fireCd = 0;
    this.smokeT = 0;
  }
  get pos() { return this.group.position; }
  forward(out) { return out.set(Math.sin(this.heading), 0, Math.cos(this.heading)); }
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

export class Sim {
  constructor(scene, world, events, seed = 1, farAnimInterval = 0.09) {
    this.scene = scene;
    this.world = world;
    this.events = events;
    this.farAnimInterval = farAnimInterval; // far-ped anim slice, see _pedAnim
    this.rng = makeRng(seed * 31 + 7);
    this.colliders = world.colliders;
    // City traffic and police patrol the city road segments only. The
    // Sable Point connector (the one segment starting east of the gate)
    // is excluded: a traffic car spawned there patrols inside the base
    // forever, and a police unit spawned there is trapped behind the
    // closed gate fence, ramming it while the player roams free.
    this.cityRoads = world.roads.filter((r) => r.axis === 'z' || r.from < 0);
    this.vehicles = [];
    this.peds = [];
    this.time = 0;
    this.shake = 0;
    this.wanted = 0;                     // heat 0..~5.9; stars = ceil
    this.heatDecay = 0;
    this.lastCrimeAt = -99;
    this.flyover = null;
    this.flyoverT = 8;
    this.effects = [];
    this.boomCount = 0;                  // lifetime totals (tests + bragging)
    this.shotsFired = 0;
    this.player = null;
    this.promptText = null;              // current interaction prompt for the HUD
    this._footColliders = [];            // scratch: colliders minus the waterline
    this._initFx();
  }

  get stars() { return Math.ceil(this.wanted - 1e-6); }

  // ------------------------------------------------------------- effects --
  _initFx() {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(64, 64, 4, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,240,200,1)'); gr.addColorStop(0.35, 'rgba(255,160,60,0.75)'); gr.addColorStop(1, 'rgba(255,90,30,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    this.fxTex = new THREE.CanvasTexture(c);
    const sc = document.createElement('canvas'); sc.width = sc.height = 128;
    const sg = sc.getContext('2d');
    const sgr = sg.createRadialGradient(64, 64, 6, 64, 64, 64);
    sgr.addColorStop(0, 'rgba(40,36,40,0.55)'); sgr.addColorStop(1, 'rgba(40,36,40,0)');
    sg.fillStyle = sgr; sg.fillRect(0, 0, 128, 128);
    this.smokeTex = new THREE.CanvasTexture(sc);
    this.boomLight = new THREE.PointLight(0xff8c42, 0, 42, 1.6);
    this.scene.add(this.boomLight);
    this.tracerMat = new THREE.LineBasicMaterial({ color: 0xffd98a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending });
  }
  _sprite(tex, color, scale) {
    const m = new THREE.SpriteMaterial({ map: tex, color, transparent: true, depthWrite: false });
    const s = new THREE.Sprite(m);
    s.scale.setScalar(scale);
    this.scene.add(s);
    return s;
  }
  tracer(a, b, color = 0xffd98a) {
    const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
    const mat = this.tracerMat.clone(); mat.color.set(color);
    const line = new THREE.Line(geo, mat);
    this.scene.add(line);
    this.effects.push({ obj: line, ttl: 0.07, max: 0.07, kind: 'fade' });
  }
  flash(pos, scale = 1.6) {
    const s = this._sprite(this.fxTex, 0xffffff, scale);
    s.position.copy(pos);
    this.effects.push({ obj: s, ttl: 0.06, max: 0.06, kind: 'fade' });
  }
  explosion(pos, radius = 7) {
    this.boomCount++;
    const s = this._sprite(this.fxTex, 0xffc98a, radius * 0.9);
    s.position.copy(pos).y += 1.2;
    this.effects.push({ obj: s, ttl: 0.38, max: 0.38, kind: 'boom' });
    const smoke = this._sprite(this.smokeTex, 0xffffff, radius * 0.8);
    smoke.position.copy(pos).y += 2.2;
    this.effects.push({ obj: smoke, ttl: 1.6, max: 1.6, kind: 'smoke' });
    this.boomLight.position.copy(pos).y += 2.5;
    this.boomLight.intensity = 900;
    this.shake = Math.min(1.4, this.shake + 0.8);
    this.events.emit('explosion', { x: pos.x, z: pos.z, radius });
    // damage everything caught in it
    for (const v of this.vehicles) {
      const d = dist2d(v.pos.x, v.pos.z, pos.x, pos.z);
      if (d < radius + 2 && v.kind !== 'jet') this.damageVehicle(v, 130 * (1 - d / (radius + 3)), null);
    }
    for (const p of this.peds) {
      const d = dist2d(p.char.position.x, p.char.position.z, pos.x, pos.z);
      if (d < radius) this.hurtPed(p, 200);
    }
    const pp = this.playerPos();
    const pd = dist2d(pp.x, pp.z, pos.x, pos.z);
    if (pd < radius && !(this.player.vehicle && this.player.vehicle.kind === 'tank')) {
      this.damagePlayer(46 * (1 - pd / (radius + 1.5)), 'blast');
    }
    this.crime(1.6, pos.x, pos.z);
  }

  // ------------------------------------------------------------- spawning --
  async spawnPlayer() {
    const ch = await makeCharacter('adventurer', 1.78);
    const s = this.world.places.spawn;
    ch.group.position.set(s.x, 0, s.z);
    ch.group.rotation.y = s.heading;
    this.scene.add(ch.group);
    this.player = {
      char: ch, heading: s.heading, speed: 0,
      health: 100, armour: 0, money: 120,
      // War-ready start: Raka carries Sinta's 9MM from the first minute, so
      // combat (this game's identity) works immediately instead of after a
      // story beat. The story's own pistol grant uses Math.max, so it still
      // lands as a top-up rather than a downgrade.
      weapon: 'pistol', ammo: { pistol: 60, carbine: 0 },
      vehicle: null, dead: false, fireCd: 0, stepT: 0,
      vy: 0, grounded: true, swimming: false,
    };
    return this.player;
  }

  async spawnPeds(n = 13) {
    const spots = this._sidewalkSpots();
    for (let i = 0; i < n; i++) {
      const model = PED_MODELS[i % PED_MODELS.length];
      const ch = await makeCharacter(model, 1.66 + (i % 5) * 0.045);
      const spot = spots[i % spots.length];
      ch.group.position.set(spot.x, 0, spot.z);
      this.scene.add(ch.group);
      this.peds.push({
        char: ch, model, axis: spot.axis, at: spot.at, along: spot.along,
        dir: i % 2 ? 1 : -1, speed: 1.15 + (i % 4) * 0.18,
        state: 'walk', fleeT: 0, deadT: 0, phase: i * 1.37,
      });
      ch.play('Walk');
    }
  }
  _sidewalkSpots() {
    const spots = [];
    for (const z of AVENUES) for (let x = -150; x <= 70; x += 26) {
      spots.push({ axis: 'x', at: z + 8.3, along: x + (spots.length % 3) * 4 });
      spots.push({ axis: 'x', at: z - 8.3, along: x + 9 });
    }
    for (const x of STREETS) for (let z = -100; z <= 92; z += 30) {
      spots.push({ axis: 'z', at: x + 8.3, along: z + (spots.length % 2) * 7 });
    }
    return spots;
  }

  async spawnTraffic(n = 9) {
    for (let i = 0; i < n; i++) {
      const color = CAR_COLORS[i % CAR_COLORS.length];
      const model = await makeCar(color);
      const v = new VehicleEnt('car', model, CAR_NAMES[i % CAR_NAMES.length]);
      const seg = this.cityRoads[i % this.cityRoads.length];
      const dir = i % 2 ? 1 : -1;
      const t = 0.15 + (i % 5) * 0.16;
      this._placeOnSeg(v, seg, dir, t);
      v.driver = 'traffic';
      v.traffic = { seg, dir, turnTarget: null, lastJunction: '' };
      this.scene.add(v.group);
      this.vehicles.push(v);
    }
  }
  _lanePoint(seg, dir, along) {
    // right-hand traffic: lane offset to the right of travel direction
    if (seg.axis === 'x') return { x: along, z: seg.at + (dir > 0 ? -2.8 : 2.8) };
    return { x: seg.at + (dir > 0 ? 2.8 : -2.8), z: along };
  }
  _placeOnSeg(v, seg, dir, t01) {
    const along = seg.from + (seg.to - seg.from) * t01;
    const p = this._lanePoint(seg, dir, along);
    v.group.position.set(p.x, 0, p.z);
    v.heading = seg.axis === 'x' ? (dir > 0 ? Math.PI / 2 : -Math.PI / 2) : (dir > 0 ? 0 : Math.PI);
    v.group.rotation.y = v.heading;
    v.speed = 0;
  }

  async spawnParked() {
    const spots = [
      { x: -24.6, z: 40, h: 0, c: 0xe07b2a, name: 'EMBER GT' },       // the crew's car by the workshop street
      { x: 41.5, z: 63, h: Math.PI, c: 0xc2c7cc },
      { x: -81.5, z: -10, h: 0, c: 0x4762a3 },
      { x: -70, z: -89.5, h: Math.PI / 2, c: 0x2e7a6a },
      { x: 30, z: -33.5, h: -Math.PI / 2, c: 0xd9a05b },
      { x: -126.5, z: 16, h: Math.PI, c: 0x7a4a6e },
      { x: -58, z: 110, h: Math.PI / 2, c: 0xe8e3d8 },
      { x: 12, z: 110, h: -Math.PI / 2, c: 0x8c2f39 },
      { x: 96, z: 30, h: 0, c: 0x3f6e46 },                            // a stray inside the base fence line road
    ];
    for (const s of spots) {
      const model = await makeCar(s.c);
      const v = new VehicleEnt('car', model, s.name || 'SARAYA SEDAN');
      v.group.position.set(s.x, 0, s.z);
      v.heading = s.h; v.group.rotation.y = s.h;
      this.scene.add(v.group);
      this.vehicles.push(v);
    }
  }

  /** Named mission hardware: the pool tank and the apron Kestrel. */
  async spawnBaseHardware() {
    const tp = this.world.places.tankPool;
    const tankModel = await makeTank();
    const tank = new VehicleEnt('tank', tankModel, 'BADAK MBT');
    tank.group.position.set(tp.x, 0, tp.z);
    tank.heading = tp.heading; tank.group.rotation.y = tp.heading;
    this.scene.add(tank.group);
    this.vehicles.push(tank);
    this.poolTank = tank;
    const jp = this.world.places.jetPark;
    const jet = new VehicleEnt('jet', makeJet(true), 'KESTREL FJ-9');
    jet.group.position.set(jp.x, 0, jp.z);
    jet.heading = jp.heading; jet.group.rotation.y = jp.heading;
    jet.onGround = true; jet.pitch = 0; jet.roll = 0; jet.alt = 0;
    this.scene.add(jet.group);
    this.vehicles.push(jet);
    this.parkedJet = jet;
    // a second Kestrel waiting at the far end of the runway (set dressing)
    const far = makeJet(true);
    far.position.set(232, 0, -72); far.rotation.y = 0;
    this.scene.add(far);
    return { tank, jet };
  }

  playerPos() {
    if (!this.player) return { x: 0, z: 0 };
    if (this.player.vehicle) return this.player.vehicle.pos;
    return this.player.char.position;
  }

  // ------------------------------------------------------------- per-frame --
  update(dt, input) {
    this.time += dt;
    dt = Math.min(dt, 0.05);
    this._updateFx(dt);
    if (!this.player || this.player.dead) { this.promptText = null; return; }
    if (this.player.vehicle) this._updateDriving(dt, input);
    else this._updateOnFoot(dt, input);
    this._updateTraffic(dt);
    this._updatePeds(dt);
    this._updatePolice(dt);
    this._updateMilitary(dt);
    this._updateWanted(dt);
    for (const v of this.vehicles) {
      if (v.kind === 'tank') v.model.update(dt);
      if (v.destroyed && !v.smokeDone) this._wreckSmoke(dt, v);
    }
  }

  _updateFx(dt) {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i];
      e.ttl -= dt;
      if (e.kind === 'boom') {
        const k = 1 - e.ttl / e.max;
        e.obj.scale.setScalar(2 + k * 13);
        e.obj.material.opacity = 1 - k;
      } else if (e.kind === 'smoke') {
        e.obj.position.y += dt * 1.1;
        e.obj.material.opacity = Math.max(0, e.ttl / e.max) * 0.75;
      } else {
        e.obj.material.opacity = Math.max(0, e.ttl / e.max) * 0.9;
      }
      if (e.ttl <= 0) {
        this.scene.remove(e.obj);
        if (e.obj.geometry) e.obj.geometry.dispose();
        if (e.obj.material) e.obj.material.dispose();
        this.effects.splice(i, 1);
      }
    }
    this.boomLight.intensity = Math.max(0, this.boomLight.intensity - dt * 5200);
    this.shake = Math.max(0, this.shake - dt * 2.6);
  }
  _wreckSmoke(dt, v) {
    v.smokeT -= dt;
    if (v.smokeT <= 0) {
      v.smokeT = 0.28;
      const s = this._sprite(this.smokeTex, 0x888888, 2.6);
      s.position.set(v.pos.x, 1.6, v.pos.z);
      this.effects.push({ obj: s, ttl: 1.5, max: 1.5, kind: 'smoke' });
    }
  }

  /** Screenshot mode: keep idle/walk animations and light bars alive while
   *  every vehicle and AI stays exactly where the scene staged it. */
  animateOnly(dt) {
    this.time += dt;
    if (this.player) this.player.char.update(dt);
    for (const ped of this.peds) ped.char.update(dt);
    for (const v of this.vehicles) {
      if (v.kind === 'tank') v.model.update(dt);
      if (v.group.userData.lightBar) updateLightBar(v.group, this.time);
    }
    this._updateFx(dt);
  }

  // ------------------------------------------------------------- on foot --
  _updateOnFoot(dt, input) {
    const p = this.player;
    const ch = p.char;
    // On foot the waterline wall (tagged `water` in world.js) does not
    // apply, so the player can step off the pier deck and swim; vehicles
    // keep the full collider set and still stop at the deck edge. The
    // filtered list is rebuilt per call from the live colliders, so the
    // base gate's add/remove keeps working for the player too.
    const fc = this._footColliders;
    fc.length = 0;
    for (const c of this.colliders) if (!c.water) fc.push(c);
    const mx = input.moveX || 0, mz = input.moveZ || 0;
    const mag = Math.hypot(mx, mz);
    const swimming = ch.position.z > SWIM_LINE_Z;
    p.swimming = swimming;
    const running = input.run && mag > 0.1 && !swimming;
    const speed = mag < 0.1 ? 0 : swimming ? 1.9 : running ? 6.6 : 3.4;
    p.speed = speed;
    if (mag > 0.1) {
      const target = Math.atan2(mx, mz);
      p.heading = turnToward(p.heading, target, dt * 11);
      let nx = ch.position.x + Math.sin(p.heading) * speed * dt * Math.min(1, mag);
      let nz = ch.position.z + Math.cos(p.heading) * speed * dt * Math.min(1, mag);
      [nx, nz] = collideCircle(fc, nx, nz, 0.42);
      // don't walk through vehicles (the Kestrel's fuselage included —
      // wings and tail still overhang the circle, but the body blocks)
      for (const v of this.vehicles) {
        const d = dist2d(nx, nz, v.pos.x, v.pos.z);
        const r = v.kind === 'tank' ? 3.1 : v.kind === 'jet' ? 2.7 : 2.0;
        if (d < r && d > 0.01) {
          nx = v.pos.x + (nx - v.pos.x) / d * r;
          nz = v.pos.z + (nz - v.pos.z) / d * r;
        }
      }
      ch.position.x = nx; ch.position.z = nz;
    }
    if (swimming) {
      // keep the swim inside the harbour basin, within sight of the pier
      ch.position.x = clamp(ch.position.x, -160, 262);
      ch.position.z = Math.min(ch.position.z, 205);
    }
    ch.group.rotation.y = p.heading;
    // vertical: buoyancy in the water, jump + gravity on land
    if (swimming) {
      p.vy = 0; p.grounded = false;
      // water surface is y=-0.5; ride at chest depth with a slow bob
      const bobY = -1.18 + Math.sin(this.time * 1.7) * 0.07;
      ch.position.y = lerp(ch.position.y, bobY, Math.min(1, dt * 5));
    } else if (ch.position.y < 0) {
      // climbed out of the water onto the deck
      ch.position.y = 0; p.vy = 0; p.grounded = true;
    } else {
      if (input.jump && p.grounded) { p.vy = 4.7; p.grounded = false; }
      if (!p.grounded) {
        p.vy -= 13.5 * dt;
        ch.position.y += p.vy * dt;
        if (ch.position.y <= 0) { ch.position.y = 0; p.vy = 0; p.grounded = true; }
      }
    }
    const armed = p.weapon !== 'fists';
    const anim = swimming ? 'Walk'
      : speed === 0 ? (armed ? 'Idle_Gun_Pointing' : 'Idle') : running ? 'Run' : 'Walk';
    ch.play(anim);
    ch.update(swimming ? dt * 0.5 : dt);   // a slower stroke while swimming
    // fire
    p.fireCd -= dt;
    if (input.fire && armed && p.fireCd <= 0) this._playerShoot(input);
    // interact: enter nearest vehicle (big hulls board from further out —
    // the Kestrel's centre is metres from any point on its fuselage). The
    // same proximity test drives the on-screen prompt, so what the player
    // sees is exactly what E will do.
    let near = null;
    {
      const v = this._nearestVehicle(ch.position.x, ch.position.z, 6);
      if (v) {
        const d = dist2d(ch.position.x, ch.position.z, v.pos.x, v.pos.z);
        const reach = v.kind === 'jet' ? 5.5 : v.kind === 'tank' ? 4.6 : 3.6;
        if (d < reach) near = v;
      }
    }
    this.promptText = !near ? null
      : near.kind === 'tank' ? 'E — ENTER TANK'
      : near.kind === 'jet' ? 'E — ENTER JET'
      : 'E — ENTER CAR';
    if (input.interact && near) this.enterVehicle(near);
  }

  _nearestVehicle(x, z, maxD) {
    let best = null, bd = maxD;
    for (const v of this.vehicles) {
      if (v.destroyed) continue;
      const d = dist2d(x, z, v.pos.x, v.pos.z);
      if (d < bd) { bd = d; best = v; }
    }
    return best;
  }

  enterVehicle(v) {
    const p = this.player;
    this.promptText = null;
    if (v.driver === 'traffic') { v.driver = 'parked'; v.traffic = null; this.crime(0.55, v.pos.x, v.pos.z); }
    if (v.driver === 'column') { v.driver = 'parked'; this.crime(1.2, v.pos.x, v.pos.z); }
    v.driver = 'player';
    v.speed = 0;
    p.vehicle = v;
    p.char.group.visible = false;
    if (v.kind === 'jet') { v.onGround = v.pos.y < 0.5; this.events.emit('toast', 'KESTREL — W/S throttle · ↓ pull up · A/D roll · SPACE burner'); }
    if (v.kind === 'tank') this.events.emit('toast', 'BADAK — slow, unstoppable. SPACE fires the main gun');
    this.events.emit('enterVehicle', { kind: v.kind, name: v.name });
  }

  exitVehicle() {
    const p = this.player;
    const v = p.vehicle;
    if (!v) return;
    v.driver = v.kind === 'jet' ? 'parked' : 'parked';
    if (v.kind === 'car' || v.kind === 'police') v.driver = 'parked';
    p.vehicle = null;
    // step out on the left side
    const lx = v.pos.x + Math.cos(v.heading) * -1.9, lz = v.pos.z - Math.sin(v.heading) * -1.9;
    const [nx, nz] = collideCircle(this.colliders, lx, lz, 0.42);
    p.char.group.position.set(nx, 0, nz);
    p.char.group.visible = true;
    p.heading = v.heading;
    this.events.emit('exitVehicle', { kind: v.kind });
  }

  // ------------------------------------------------------------- driving --
  _updateDriving(dt, input) {
    const p = this.player;
    const v = p.vehicle;
    // Exit rule: a car must be near-stopped, and the Kestrel only on the
    // ground — bailing out mid-air used to teleport Raka to the street
    // and leave the jet parked in the sky, unreachable for good.
    const canExit = v.kind === 'jet' ? !!v.onGround : Math.abs(v.speed) < 4;
    if (input.interact) { if (canExit) { this.promptText = null; this.exitVehicle(); return; } }
    // mirror the exit rule above: the prompt shows exactly when E works
    this.promptText = canExit ? 'E — EXIT' : null;
    if (v.kind === 'jet') return this._updateJet(dt, input, v);
    const isTank = v.kind === 'tank';
    const maxF = isTank ? 9.5 : v.name === 'EMBER GT' ? 39 : 33;
    const maxR = isTank ? 3.5 : 11;
    const accel = isTank ? 5 : 13;
    if (input.throttle > 0) v.speed = Math.min(maxF, v.speed + accel * dt * input.throttle);
    else if (input.throttle < 0) v.speed = Math.max(-maxR, v.speed - (v.speed > 0.5 ? 22 : accel * 0.7) * dt);
    else v.speed = v.speed > 0 ? Math.max(0, v.speed - 3.2 * dt) : Math.min(0, v.speed + 3.2 * dt);
    if (v.destroyed) v.speed = Math.max(0, v.speed - 14 * dt);
    const steer = (input.steer || 0);
    const steerAuthority = clamp(Math.abs(v.speed) / 6, 0, 1) * (isTank ? 0.5 : 0.95);
    if (v.speed !== 0) v.heading += steer * steerAuthority * dt * 1.55 * Math.sign(v.speed) * (isTank ? 0.8 : 1);
    v.steerVis = lerp(v.steerVis, steer * 0.42, dt * 8);
    const fx = Math.sin(v.heading), fz = Math.cos(v.heading);
    let nx = v.pos.x + fx * v.speed * dt;
    let nz = v.pos.z + fz * v.speed * dt;
    const r = isTank ? 2.6 : 1.7;
    const before = { x: v.pos.x, z: v.pos.z };
    [nx, nz] = collideCircle(this.colliders, nx, nz, r);
    const moved = dist2d(nx, nz, before.x, before.z);
    if (moved < Math.abs(v.speed) * dt * 0.35 && Math.abs(v.speed) > 6) {
      // slammed into something solid
      if (isTank) { v.speed *= 0.92; }
      else {
        this.damageVehicle(v, Math.abs(v.speed) * 0.55, 'crash');
        this.shake = Math.min(1, this.shake + Math.abs(v.speed) * 0.02);
        v.speed *= -0.18;
        this.crime(0.25, nx, nz);
      }
    }
    v.group.position.x = nx; v.group.position.z = nz;
    v.group.rotation.y = v.heading;
    // vehicle vs vehicle
    for (const o of this.vehicles) {
      if (o === v) continue;
      const d = dist2d(nx, nz, o.pos.x, o.pos.z);
      const rr = (isTank ? 3.4 : 2.3) + (o.kind === 'tank' ? 3.4 : o.kind === 'jet' ? 3.2 : 2.3);
      if (d < rr && d > 0.01) {
        if (o.kind !== 'jet' && (isTank || (v.kind !== 'tank' && o.kind !== 'tank' && Math.abs(v.speed) > 8))) {
          // shove the other vehicle; tanks simply roll through
          const push = (rr - d) * (isTank ? 0.9 : 0.4);
          o.group.position.x += (o.pos.x - nx) / d * push;
          o.group.position.z += (o.pos.z - nz) / d * push;
          if (isTank) this.damageVehicle(o, 60 * dt * 8, 'crush');
          else this.damageVehicle(o, Math.abs(v.speed) * 0.3, 'crash');
          if (Math.abs(v.speed) > 12) this.crime(0.3, nx, nz);
        } else {
          // No shove — too slow, or the other hull is immovable (a tank,
          // the parked Kestrel): treat it as a wall and back the player
          // out. Without this branch a slow car ghosted clean through
          // parked traffic, and anything could drive through the jet.
          v.group.position.x = o.pos.x + (nx - o.pos.x) / d * rr;
          v.group.position.z = o.pos.z + (nz - o.pos.z) / d * rr;
          nx = v.group.position.x; nz = v.group.position.z;
          if (Math.abs(v.speed) > 3) { this.damageVehicle(v, Math.abs(v.speed) * 0.3, 'crash'); v.speed *= -0.15; }
          else v.speed *= 0.6;
        }
      }
    }
    // run-over peds dive away or go down
    for (const ped of this.peds) {
      if (ped.state === 'down') continue;
      const d = dist2d(nx, nz, ped.char.position.x, ped.char.position.z);
      if (d < 2.1 && Math.abs(v.speed) > 3) {
        this.hurtPed(ped, 120);
        this.crime(0.8, nx, nz);
        if (!isTank) v.speed *= 0.82;
      }
    }
    if (v.model && v.model.roll) v.model.roll(v.speed * dt, v.steerVis);
    if (isTank) {
      v.model.setDrive(v.speed);
      // turret tracks the camera aim
      if (input.turretYaw !== undefined && v.model.turret) {
        const local = angleDelta(v.heading, input.turretYaw);
        v.model.turret.rotation.y = -local;
      }
      v.reloadT = (v.reloadT || 0) - dt;
      if (input.firePressed && v.reloadT <= 0) { this._tankFire(v, input); v.reloadT = 1.15; }
    } else if (input.fire && p.weapon !== 'fists') {
      p.fireCd -= dt;
      if (p.fireCd <= 0) this._playerShoot(input, v);
    }
    if (v.kind === 'police' || v.model) updateLightBar(v.group, this.time);
  }

  _updateJet(dt, input, v) {
    const p = this.player;
    v.throttle = v.throttle || 0;
    if (input.jetThrottle) v.throttle = clamp(v.throttle + input.jetThrottle * dt * 0.55, 0, 1);
    const burner = input.burner ? 1 : 0;
    const maxSpeed = 68 + burner * 42;
    const targetSpeed = v.throttle * maxSpeed;
    v.speed = lerp(v.speed, targetSpeed, dt * (v.onGround ? 0.5 : 0.28));
    const spd = v.speed;
    // steering on the ground, roll/pitch in the air
    if (v.onGround) {
      v.heading += (input.steer || 0) * dt * clamp(spd / 14, 0, 1) * 0.7 * (spd > 0.5 ? 1 : 0);
      if (spd > 26 && input.pitchUp) { v.onGround = false; v.pitch = 0.16; }
      v.pitch = 0; v.roll = 0;
      v.pos.x += Math.sin(v.heading) * spd * dt;
      v.pos.z += Math.cos(v.heading) * spd * dt;
      const [nx, nz] = collideCircle(this.colliders, v.pos.x, v.pos.z, 2.2);
      if (dist2d(nx, nz, v.pos.x, v.pos.z) > 0.4 && spd > 12) { this._jetCrash(v); return; }
      v.pos.x = nx; v.pos.z = nz; v.pos.y = 0;
    } else {
      const rollIn = (input.steer || 0);
      v.roll = lerp(v.roll, -rollIn * 0.85, dt * 3.2);
      v.heading += rollIn * dt * 0.85;
      const pitchIn = (input.pitchUp ? 1 : 0) - (input.pitchDown ? 1 : 0);
      v.pitch = clamp(lerp(v.pitch, pitchIn * 0.5, dt * 2.4), -0.55, 0.62);
      const fx = Math.sin(v.heading) * Math.cos(v.pitch);
      const fz = Math.cos(v.heading) * Math.cos(v.pitch);
      const fy = Math.sin(v.pitch);
      v.pos.x += fx * spd * dt;
      v.pos.z += fz * spd * dt;
      v.pos.y += fy * spd * dt - (spd < 21 ? (21 - spd) * dt * 0.85 : 0);
      if (v.pos.y > 170) v.pos.y = 170;
      // the world ends at the fence lines: a jet that leaves it is lost
      // in empty sky with nothing to land on — slide along the edge
      v.pos.x = clamp(v.pos.x, -164, 270);
      v.pos.z = clamp(v.pos.z, -114, 204);
      if (v.pos.y <= 0) {
        v.pos.y = 0;
        const flat = Math.abs(v.pitch) < 0.3 && Math.abs(v.roll) < 0.45;
        const onRunway = v.pos.x > 222 && v.pos.x < 242 && v.pos.z > -102 && v.pos.z < 94;
        if (flat && spd < 46 && (onRunway || spd < 26)) { v.onGround = true; v.pitch = 0; v.roll = 0; }
        else { this._jetCrash(v); return; }
      }
      // buildings are tall: clipping one at altitude is a crash
      if (v.pos.y < 24 && segmentBlocked(this.world.los, v.pos.x, v.pos.z, v.pos.x, v.pos.z)) { /* point test below */ }
      if (v.pos.y < 23) {
        for (const c of this.world.los) {
          if (v.pos.x > c.minX - 1 && v.pos.x < c.maxX + 1 && v.pos.z > c.minZ - 1 && v.pos.z < c.maxZ + 1) { this._jetCrash(v); return; }
        }
      }
    }
    v.group.position.copy(v.pos);
    v.group.rotation.set(0, 0, 0);
    v.group.rotateY(v.heading);
    v.group.rotateX(-(v.pitch || 0));
    v.group.rotateZ(-(v.roll || 0));
    if (v.group.userData.setBurner) v.group.userData.setBurner(0.6 + v.throttle * 2.6 + burner * 2.5);
    void p;
  }
  _jetCrash(v) {
    this.explosion(v.pos.clone(), 8);
    v.destroyed = true; v.health = 0; v.throttle = 0;
    this.damagePlayer(85, 'crash');
    if (this.player.vehicle === v) this.exitVehicle();
  }

  // ------------------------------------------------------------- traffic --
  _updateTraffic(dt) {
    for (const v of this.vehicles) {
      if (v.driver !== 'traffic' || v.destroyed) continue;
      const tr = v.traffic;
      const pos = v.pos;
      let target;
      if (tr.turnTarget && dist2d(pos.x, pos.z, tr.turnTarget.x, tr.turnTarget.z) < 5) {
        if (tr.pendingSeg) { tr.seg = tr.pendingSeg.seg; tr.dir = tr.pendingSeg.dir; tr.pendingSeg = null; }
        tr.turnTarget = null;
      }
      if (tr.turnTarget) {
        target = tr.turnTarget;
      } else {
        const ahead = 9;
        const along = tr.seg.axis === 'x' ? pos.x + tr.dir * ahead : pos.z + tr.dir * ahead;
        target = this._lanePoint(tr.seg, tr.dir, along);
        // junction decisions
        const crossings = tr.seg.axis === 'x' ? STREETS : AVENUES;
        for (const c of crossings) {
          const dAlong = (c - (tr.seg.axis === 'x' ? pos.x : pos.z)) * tr.dir;
          if (dAlong > 0 && dAlong < 10) {
            const key = `${tr.seg.axis}${tr.seg.at}:${c}`;
            if (tr.lastJunction !== key && this.rng() < 0.4) {
              tr.lastJunction = key;
              const nseg = this.world.roads.find((r) => r.axis !== tr.seg.axis && r.at === c);
              if (nseg) {
                const ndir = this.rng() < 0.5 ? 1 : -1;
                const entry = this._lanePoint(nseg, ndir, c + ndir * 13);
                tr.turnTarget = entry;
                tr.pendingSeg = { seg: nseg, dir: ndir };
              }
            }
          }
        }
        // segment end: U-turn
        const alongNow = tr.seg.axis === 'x' ? pos.x : pos.z;
        if ((tr.dir > 0 && alongNow > tr.seg.to - 4) || (tr.dir < 0 && alongNow < tr.seg.from + 4)) {
          tr.dir *= -1;
        }
      }
      const want = Math.atan2(target.x - pos.x, target.z - pos.z);
      const dd = angleDelta(v.heading, want);
      v.heading = turnToward(v.heading, want, dt * 1.7);
      let cruise = 10.5;
      if (Math.abs(dd) > 0.45) cruise = 5.5;
      // keep distance to the vehicle ahead
      let gap = Infinity;
      for (const o of this.vehicles) {
        if (o === v || o.kind === 'jet') continue;
        const ahead = (o.pos.x - pos.x) * Math.sin(v.heading) + (o.pos.z - pos.z) * Math.cos(v.heading);
        const side = Math.abs((o.pos.x - pos.x) * Math.cos(v.heading) - (o.pos.z - pos.z) * Math.sin(v.heading));
        if (ahead > 0 && ahead < 9 && side < 2.4) gap = Math.min(gap, ahead);
      }
      // ...and to pedestrians: sidewalk lines cross every street at the
      // corners, and traffic used to drive straight through the people
      // crossing there (no brake, no hit — a ghost through a body)
      for (const ped of this.peds) {
        if (ped.state === 'down') continue;
        const px = ped.char.position.x, pz = ped.char.position.z;
        const ahead = (px - pos.x) * Math.sin(v.heading) + (pz - pos.z) * Math.cos(v.heading);
        const side = Math.abs((px - pos.x) * Math.cos(v.heading) - (pz - pos.z) * Math.sin(v.heading));
        if (ahead > 0 && ahead < 8 && side < 1.7) gap = Math.min(gap, ahead);
      }
      const targetSpeed = gap < 5 ? 0 : gap < 9 ? cruise * 0.45 : cruise;
      v.speed = lerp(v.speed, targetSpeed, dt * 2.2);
      pos.x += Math.sin(v.heading) * v.speed * dt;
      pos.z += Math.cos(v.heading) * v.speed * dt;
      v.group.rotation.y = v.heading;
      if (v.model && v.model.roll) v.model.roll(v.speed * dt, clamp(dd, -0.4, 0.4));
      // Round 7 (density): more cars make the known no-overtake deadlock
      // likelier — a car wedged nose-to-tail (classically behind a
      // lane-parked car) would anchor a permanent queue. A car that has
      // barely moved for 14 s AND is far from the player is quietly
      // recycled onto a fresh city segment; near the player nothing pops.
      if (Math.abs(v.speed) < 0.3) {
        tr.stuckT = (tr.stuckT || 0) + dt;
        if (tr.stuckT > 14) {
          const pp = this.playerPos();
          if (dist2d(pos.x, pos.z, pp.x, pp.z) > 60) {
            const seg2 = this.cityRoads[Math.floor(this.rng() * this.cityRoads.length)];
            const dir2 = this.rng() < 0.5 ? 1 : -1;
            this._placeOnSeg(v, seg2, dir2, 0.15 + this.rng() * 0.7);
            v.traffic = { seg: seg2, dir: dir2, turnTarget: null, lastJunction: '', stuckT: 0 };
          }
        }
      } else tr.stuckT = 0;
    }
  }

  // ------------------------------------------------------------- peds --
  /** Far-away crowds don't need 60 Hz skeletons: beyond ~85 m their mixers
   *  advance in slices of `farAnimInterval` seconds (~11 Hz at the 0.09 s
   *  default; round 5 passes 0.18 s on touch devices, ~5.5 Hz, where the
   *  CPU saving matters most). Movement still runs every frame, so
   *  nothing drifts or pops — only the (unreadable, at that range) limb
   *  motion is sampled coarser. A real saving on integrated GPUs/CPUs. */
  _pedAnim(ped, dt, far) {
    if (!far) { ped.char.update(dt); return; }
    ped.animAcc = (ped.animAcc || 0) + dt;
    if (ped.animAcc >= this.farAnimInterval) { ped.char.update(ped.animAcc); ped.animAcc = 0; }
  }
  _updatePeds(dt) {
    const pp = this.playerPos();
    for (const ped of this.peds) {
      const ch = ped.char;
      const dPlayer = dist2d(ch.position.x, ch.position.z, pp.x, pp.z);
      const far = dPlayer > 85;
      if (ped.state === 'down') {
        ped.deadT -= dt;
        if (ped.deadT <= 0) { ped.state = 'walk'; ch.play('Walk'); this._respawnPed(ped, pp); }
        this._pedAnim(ped, dt, far);
        continue;
      }
      // keep the crowd near the player
      if (dPlayer > 185) this._respawnPed(ped, pp);
      let speed = ped.speed, dirSign = ped.dir;
      if (ped.fleeT > 0) {
        ped.fleeT -= dt;
        speed = 5.4;
        const away = Math.atan2(ch.position.x - ped.fleeFrom.x, ch.position.z - ped.fleeFrom.z);
        const h = turnToward(ch.group.rotation.y, away, dt * 6);
        ch.group.rotation.y = h;
        let nx = ch.position.x + Math.sin(h) * speed * dt;
        let nz = ch.position.z + Math.cos(h) * speed * dt;
        [nx, nz] = collideCircle(this.colliders, nx, nz, 0.4);
        ch.position.x = nx; ch.position.z = nz;
        ch.play('Run');
        this._pedAnim(ped, dt, far);
        continue;
      }
      // sidewalk walking: along one axis at a fixed offset line
      ped.along += dirSign * speed * dt;
      const range = ped.axis === 'x' ? [-156, 76] : [-104, 96];
      if (ped.along > range[1]) { ped.along = range[1]; ped.dir = -1; }
      if (ped.along < range[0]) { ped.along = range[0]; ped.dir = 1; }
      const x = ped.axis === 'x' ? ped.along : ped.at;
      const z = ped.axis === 'x' ? ped.at : ped.along;
      const [nx, nz] = collideCircle(this.colliders, x, z, 0.4);
      ch.position.x = nx; ch.position.z = nz;
      const heading = ped.axis === 'x' ? (ped.dir > 0 ? Math.PI / 2 : -Math.PI / 2) : (ped.dir > 0 ? 0 : Math.PI);
      ch.group.rotation.y = turnToward(ch.group.rotation.y, heading, dt * 5);
      ch.play(ped.fleeT > 0 ? 'Run' : 'Walk');
      this._pedAnim(ped, dt, far);
    }
  }
  _respawnPed(ped, near) {
    const spots = this._sidewalkSpots();
    const rng = this.rng;
    for (let tries = 0; tries < 8; tries++) {
      const s = spots[Math.floor(rng() * spots.length)];
      const x = s.axis === 'x' ? s.along : s.at;
      const z = s.axis === 'x' ? s.at : s.along;
      const d = dist2d(x, z, near.x, near.z);
      if (d > 55 && d < 130) {
        ped.axis = s.axis; ped.at = s.at; ped.along = s.along;
        ped.char.position.set(x, 0, z);
        ped.state = 'walk'; ped.fleeT = 0;
        ped.char.play('Walk');
        return;
      }
    }
  }
  hurtPed(ped, dmg) {
    if (ped.state === 'down') return;
    ped.state = 'down';
    ped.deadT = 16;
    ped.char.play('Death', 0.05);
    this.events.emit('pedDown', { x: ped.char.position.x, z: ped.char.position.z });
  }
  scarePeds(x, z, radius) {
    for (const ped of this.peds) {
      if (ped.state === 'down') continue;
      if (dist2d(ped.char.position.x, ped.char.position.z, x, z) < radius) {
        ped.fleeT = 3.5;
        ped.fleeFrom = { x, z };
      }
    }
  }

  // ------------------------------------------------------------- wanted --
  crime(amount, x, z) {
    // crimes only count when authority could plausibly notice: always counts
    // at close range, otherwise needs a witness (police/ped within 30 m)
    let witnessed = false;
    for (const v of this.vehicles) if (v.driver === 'police' && dist2d(v.pos.x, v.pos.z, x, z) < 42) witnessed = true;
    if (!witnessed) for (const ped of this.peds) if (dist2d(ped.char.position.x, ped.char.position.z, x, z) < 26) witnessed = true;
    if (this.stars >= 1) witnessed = true;
    if (witnessed || amount >= 1.2) {
      this.wanted = clamp(this.wanted + amount, 0, 5.6);
      this.lastCrimeAt = this.time;
      this.heatDecay = 0;
    }
    this.events.emit('crime', { amount, stars: this.stars });
  }
  _updateWanted(dt) {
    // heat cools when no police can see the player for a while
    const pp = this.playerPos();
    let seen = false;
    for (const v of this.vehicles) {
      if (v.driver !== 'police' && v.driver !== 'column') continue;
      const d = dist2d(v.pos.x, v.pos.z, pp.x, pp.z);
      if (d < 55 && !segmentBlocked(this.world.los, v.pos.x, v.pos.z, pp.x, pp.z)) seen = true;
    }
    if (!seen && this.time - this.lastCrimeAt > 6 && this.wanted > 0) {
      this.heatDecay += dt;
      this.wanted = Math.max(0, this.wanted - dt * (this.heatDecay > 4 ? 0.14 : 0.05));
    } else this.heatDecay = 0;
    if (this.wanted <= 0.01 && this.stars > 0) this.wanted = 0;
  }
  clearWanted() { this.wanted = 0; this.heatDecay = 0; }

  // ------------------------------------------------------------- police --
  async _spawnPoliceUnit() {
    const model = await makePoliceCar();
    const v = new VehicleEnt('police', model, 'PORT AUTHORITY');
    const pp = this.playerPos();
    // spawn on a road 65–95 m away from the player (city segments only —
    // a unit spawning on the base connector is trapped behind the gate)
    const segs = this.cityRoads;
    for (let tries = 0; tries < 10; tries++) {
      const seg = segs[Math.floor(this.rng() * segs.length)];
      const along = this.rng.range(seg.from + 6, seg.to - 6);
      const p = this._lanePoint(seg, 1, along);
      const d = dist2d(p.x, p.z, pp.x, pp.z);
      if (d > 60 && d < 110) {
        v.group.position.set(p.x, 0, p.z);
        break;
      }
      if (tries === 9) v.group.position.set(pp.x + 70, 0, pp.z);
    }
    v.driver = 'police';
    v.fireCd = this.rng.range(0.4, 1.4);
    this.scene.add(v.group);
    this.vehicles.push(v);
    return v;
  }
  _policeCount() { return this.vehicles.filter((v) => v.driver === 'police' && !v.destroyed).length; }
  _updatePolice(dt) {
    const stars = this.stars;
    const want = [0, 1, 2, 3, 4, 4][stars] || 0;
    if (this._policeCount() < want && !this._spawningPolice) {
      this._spawningPolice = true;
      this._spawnPoliceUnit().finally(() => { this._spawningPolice = false; });
    }
    const pp = this.playerPos();
    for (const v of this.vehicles) {
      if (v.driver !== 'police') continue;
      updateLightBar(v.group, this.time);
      if (v.destroyed) continue;
      const d = dist2d(v.pos.x, v.pos.z, pp.x, pp.z);
      if (d > 190 && stars === 0) { // give up and melt away
        this.scene.remove(v.group);
        this.vehicles.splice(this.vehicles.indexOf(v), 1);
        continue;
      }
      // pursuit: aim at a point just behind the player's motion. With no
      // stars the heat is gone — the unit disengages and drives AWAY
      // instead of ramming the player forever (the ram below was not
      // star-gated, so a leftover unit hunted a clean player eternally)
      const engaging = stars > 0;
      const pv = this.player.vehicle;
      const lead = pv ? pv.speed * 0.35 : 0;
      const tx = engaging ? pp.x + (pv ? Math.sin(pv.heading) * lead : 0) : v.pos.x + (v.pos.x - pp.x);
      const tz = engaging ? pp.z + (pv ? Math.cos(pv.heading) * lead : 0) : v.pos.z + (v.pos.z - pp.z);
      const wantH = Math.atan2(tx - v.pos.x, tz - v.pos.z);
      const dd = angleDelta(v.heading, wantH);
      v.heading = turnToward(v.heading, wantH, dt * 1.9);
      let cruise = !engaging ? 21 : d > 40 ? 31 : d > 14 ? 24 : 13;
      if (Math.abs(dd) > 0.6) cruise *= 0.55;
      if (engaging && d < 5.5) cruise = 0;           // arrived: block / engage
      v.speed = lerp(v.speed, cruise, dt * (cruise > v.speed ? 1.4 : 3));
      let nx = v.pos.x + Math.sin(v.heading) * v.speed * dt;
      let nz = v.pos.z + Math.cos(v.heading) * v.speed * dt;
      [nx, nz] = collideCircle(this.colliders, nx, nz, 1.7);
      v.group.position.x = nx; v.group.position.z = nz;
      v.group.rotation.y = v.heading;
      if (v.model && v.model.roll) v.model.roll(v.speed * dt, clamp(dd, -0.4, 0.4));
      // ram damage (only while there is any heat to enforce)
      if (engaging && d < 3.4 && Math.abs(v.speed) > 7) {
        if (pv) this.damageVehicle(pv, 7, 'ram');
        else this.damagePlayer(9, 'ram');
        v.speed *= 0.4;
      }
      // return fire at 3+ stars when close and in the open
      v.fireCd -= dt;
      if (stars >= 3 && d > 6 && d < 30 && v.fireCd <= 0) {
        v.fireCd = this.rng.range(0.8, 1.3);
        if (!segmentBlocked(this.world.los, v.pos.x, v.pos.z, pp.x, pp.z)) this._policeShoot(v);
      }
    }
  }
  _policeShoot(v) {
    const pp = this.playerPos();
    const from = new THREE.Vector3(v.pos.x, 1.25, v.pos.z);
    const to = new THREE.Vector3(pp.x, this.player.vehicle ? 1.0 : 1.3, pp.z);
    for (let i = 0; i < 3; i++) {
      const jitter = new THREE.Vector3(to.x + (this.rng() - 0.5) * 1.6, to.y, to.z + (this.rng() - 0.5) * 1.6);
      this.tracer(from, jitter, 0xff9a7a);
    }
    this.flash(from.clone().add(new THREE.Vector3(0, 0.15, 0)), 0.9);
    if (this.rng() < 0.62) {
      if (this.player.vehicle) { this.damageVehicle(this.player.vehicle, 3.5, 'shot'); if (this.rng() < 0.4) this.damagePlayer(2.5, 'shot'); }
      else this.damagePlayer(5.5, 'shot');
    }
    this.scarePeds(pp.x, pp.z, 16);
  }

  // ------------------------------------------------------------- military --
  async _spawnColumnTank() {
    const model = await makeTank();
    const v = new VehicleEnt('tank', model, 'BADAK MBT');
    const pp = this.playerPos();
    const side = pp.x > -20 ? -1 : 1;
    v.group.position.set(clamp(pp.x + side * 95, -140, 60), 0, 76 + (this.rng() < 0.5 ? -2.8 : 2.8));
    v.heading = side > 0 ? Math.PI / 2 : -Math.PI / 2;
    v.group.rotation.y = v.heading;
    v.driver = 'column';
    v.fireCd = this.rng.range(2.5, 4.5);
    this.scene.add(v.group);
    this.vehicles.push(v);
    return v;
  }
  _updateMilitary(dt) {
    const stars = this.stars;
    const columns = this.vehicles.filter((v) => v.driver === 'column' && !v.destroyed);
    if (stars >= 5 && columns.length < 2 && !this._spawningTank) {
      this._spawningTank = true;
      this._spawnColumnTank().finally(() => { this._spawningTank = false; });
    }
    const pp = this.playerPos();
    for (const v of columns) {
      // roll along Jalan Ombak toward the player's x, slowly and heavily.
      // Below 5 stars the deployment is over: the column rolls away from
      // the player and melts off — it used to keep hunting and shelling
      // a clean player forever, since nothing here was star-gated.
      const engaging = stars >= 5;
      const dx = pp.x - v.pos.x;
      const wantH = engaging
        ? (Math.abs(dx) > 6 ? (dx > 0 ? Math.PI / 2 : -Math.PI / 2) : v.heading)
        : (v.pos.x >= pp.x ? Math.PI / 2 : -Math.PI / 2);
      v.heading = turnToward(v.heading, wantH, dt * 0.5);
      const distP = Math.abs(dx);
      v.speed = lerp(v.speed, engaging ? (distP > 16 ? 5.6 : 0) : 5.6, dt * 0.8);
      let nx = v.pos.x + Math.sin(v.heading) * v.speed * dt;
      let nz = v.pos.z + Math.cos(v.heading) * v.speed * dt;
      [nx, nz] = collideCircle(this.colliders, nx, nz, 2.6);
      v.group.position.x = nx; v.group.position.z = nz;
      v.group.rotation.y = v.heading;
      v.model.setDrive(v.speed);
      if (v.model.turret) {
        const aim = Math.atan2(pp.x - v.pos.x, pp.z - v.pos.z);
        v.model.turret.rotation.y = -angleDelta(v.heading, aim);
      }
      v.fireCd -= dt;
      const d = dist2d(v.pos.x, v.pos.z, pp.x, pp.z);
      if (engaging && v.fireCd <= 0 && d < 78 && d > 9) {
        v.fireCd = this.rng.range(3.6, 5.2);
        if (!segmentBlocked(this.world.los, v.pos.x, v.pos.z, pp.x, pp.z)) {
          // shell lands near the player — terrifying, occasionally lethal
          const miss = this.rng.range(2, 7);
          const ang = this.rng() * Math.PI * 2;
          const at = new THREE.Vector3(pp.x + Math.cos(ang) * miss, 0.4, pp.z + Math.sin(ang) * miss);
          this.explosion(at, 6.5);
        }
      }
      if (d > 220 || (!engaging && d > 130)) { this.scene.remove(v.group); this.vehicles.splice(this.vehicles.indexOf(v), 1); }
    }
    // Kestrel flyovers at 5 stars (and a rare ambient one at 4)
    this.flyoverT -= dt;
    if (!this.flyover && this.flyoverT <= 0 && stars >= 4) {
      const jet = makeJet(false);
      const dirZ = this.rng() < 0.5 ? 1 : -1;
      jet.position.set(this.rng.range(-120, 40), this.rng.range(38, 60), dirZ > 0 ? -190 : 210);
      jet.rotation.y = dirZ > 0 ? 0 : Math.PI;
      jet.rotation.z = dirZ * 0.35;
      if (jet.userData.setBurner) jet.userData.setBurner(3.4);
      this.scene.add(jet);
      this.flyover = { group: jet, dirZ, speed: 95 };
      this.flyoverT = this.rng.range(16, 26);
    }
    if (this.flyover) {
      const f = this.flyover;
      f.group.position.z += f.dirZ * f.speed * dt;
      if (Math.abs(f.group.position.z) > 260) { this.scene.remove(f.group); this.flyover = null; }
    }
  }

  // ------------------------------------------------------------- combat --
  _playerShoot(input, fromVehicle = null) {
    const p = this.player;
    const w = p.weapon;
    const cfg = w === 'pistol' ? { cd: 0.3, dmg: 34, range: 85 } : { cd: 0.115, dmg: 21, range: 95 };
    if (p.ammo[w] <= 0) { p.fireCd = 0.3; this.events.emit('toast', 'OUT OF AMMO — Dario sells shells at the workshop'); return; }
    p.ammo[w]--;
    p.fireCd = cfg.cd;
    const origin = input.aimOrigin || new THREE.Vector3(p.char.position.x, 1.4, p.char.position.z);
    const dir = input.aimDir || new THREE.Vector3(Math.sin(p.heading), 0, Math.cos(p.heading));
    const from = origin.clone().add(dir.clone().multiplyScalar(0.5));
    this.flash(from, 1.1);
    if (!fromVehicle) p.char.playOnce('Gun_Shoot');
    // nearest hit among peds and vehicles along the ray (t = distance along
    // the ray to the closest approach; the perpendicular gap must be small)
    let bestT = cfg.range, bestPed = null, bestVeh = null;
    const dirN = dir.clone().normalize();
    const along = (c) => {
      const to = new THREE.Vector3().subVectors(c, origin);
      const t = to.dot(dirN);
      if (t < 0.5) return -1;
      const perp = to.addScaledVector(dirN, -t).length();
      return { t, perp };
    };
    for (const ped of this.peds) {
      if (ped.state === 'down') continue;
      const c = new THREE.Vector3(ped.char.position.x, 1.05, ped.char.position.z);
      const r = along(c);
      if (r && r.perp < 0.55 && r.t < bestT) { bestT = r.t; bestPed = ped; bestVeh = null; }
    }
    for (const v of this.vehicles) {
      if (v === fromVehicle || v.destroyed) continue;
      const c = new THREE.Vector3(v.pos.x, v.kind === 'tank' ? 1.5 : 0.9, v.pos.z);
      const r = along(c);
      const rr = v.kind === 'tank' ? 3.4 : 2.3;
      if (r && r.perp < rr && r.t < bestT) { bestT = r.t; bestVeh = v; bestPed = null; }
    }
    // buildings stop the bullet
    const end = origin.clone().add(dir.clone().multiplyScalar(bestT));
    if (segmentBlocked(this.world.los, origin.x, origin.z, end.x, end.z) && !bestPed && !bestVeh) {
      bestT = cfg.range * 0.5;
    }
    const hitPoint = origin.clone().add(dir.clone().multiplyScalar(bestT));
    this.tracer(from, hitPoint);
    if (bestPed) { this.hurtPed(bestPed, cfg.dmg * 2.2); this.crime(0.9, bestPed.char.position.x, bestPed.char.position.z); }
    else if (bestVeh) {
      this.damageVehicle(bestVeh, cfg.dmg, 'shot');
      if (bestVeh.driver === 'police' || bestVeh.kind === 'tank') this.crime(0.7, bestVeh.pos.x, bestVeh.pos.z);
      else this.crime(0.35, bestVeh.pos.x, bestVeh.pos.z);
    } else this.crime(0.45, origin.x, origin.z);
    this.scarePeds(origin.x, origin.z, 15);
    this.events.emit('shot', {});
  }

  _tankFire(v, input) {
    this.shotsFired++;
    const yaw = input.turretYaw !== undefined ? input.turretYaw : v.heading;
    const origin = new THREE.Vector3(v.pos.x, 2.1, v.pos.z);
    const dir = new THREE.Vector3(Math.sin(yaw), 0.06, Math.cos(yaw)).normalize();
    // march the shell until it meets a building or runs out of range
    let hit = origin.clone().add(dir.clone().multiplyScalar(95));
    for (let t = 4; t < 95; t += 2) {
      const px = origin.x + dir.x * t, pz = origin.z + dir.z * t;
      let inside = false;
      for (const c of this.world.los) if (px > c.minX && px < c.maxX && pz > c.minZ && pz < c.maxZ) { inside = true; break; }
      if (inside) { hit = new THREE.Vector3(px, 0.6, pz); break; }
    }
    // or the first vehicle in the line
    for (const o of this.vehicles) {
      if (o === v || o.kind === 'jet') continue;
      const d = dist2d(o.pos.x, o.pos.z, origin.x, origin.z);
      if (d > 4 && d < 95) {
        const along = (o.pos.x - origin.x) * dir.x + (o.pos.z - origin.z) * dir.z;
        const side = Math.abs((o.pos.x - origin.x) * dir.z - (o.pos.z - origin.z) * dir.x);
        if (along > 0 && side < 3) { hit = new THREE.Vector3(o.pos.x, 0.7, o.pos.z); break; }
      }
    }
    const muzzle = origin.clone().add(dir.clone().multiplyScalar(4.6));
    this.flash(muzzle, 3.2);
    this.tracer(muzzle, hit, 0xffb347);
    this.shake = Math.min(1.2, this.shake + 0.35);
    hit.y = 0.5;
    this.explosion(hit, 7.5);
  }

  damageVehicle(v, dmg, cause) {
    if (v.destroyed || v.kind === 'jet') return;
    if (v.kind === 'tank' && cause !== 'crush') dmg *= 0.12;      // armour shrugs off most things
    v.health -= dmg;
    if (v.health <= 0) {
      v.health = 0;
      v.destroyed = true;
      v.speed = 0;
      if (v.model && v.model.bodyMat) v.model.bodyMat.color.multiplyScalar(0.3);
      this.flash(new THREE.Vector3(v.pos.x, 1.4, v.pos.z), 4.5);
      this.events.emit('vehicleDown', { kind: v.kind, x: v.pos.x, z: v.pos.z });
      if (this.player.vehicle === v) this.damagePlayer(12, 'fire');
    }
  }

  damagePlayer(dmg, cause) {
    const p = this.player;
    if (!p || p.dead) return;
    if (p.armour > 0) {
      const absorbed = Math.min(p.armour, dmg * 0.6);
      p.armour -= absorbed;
      dmg -= absorbed;
    }
    p.health -= dmg;
    this.events.emit('playerHurt', { health: p.health, cause });
    if (p.health <= 0) {
      p.health = 0;
      p.dead = true;
      this.events.emit('playerDead', { cause });
    }
  }
  healPlayer(n) {
    const p = this.player;
    p.health = clamp(p.health + n, 0, 100);
  }
}
