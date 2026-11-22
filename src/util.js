// Small shared helpers for EMBER TIDE: a seeded RNG (the same seed always grows
// the same Port Saraya), math conveniences, and the collision tests the player,
// traffic and police all share. No imports — everything here is pure.

/** Deterministic RNG (mulberry32). `rng()` -> [0,1); helpers ride on top. */
export function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.range = (lo, hi) => lo + next() * (hi - lo);
  next.int = (lo, hi) => Math.floor(next.range(lo, hi + 1));
  next.pick = (arr) => arr[Math.floor(next() * arr.length) % arr.length];
  next.chance = (p) => next() < p;
  return next;
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;

/** Shortest signed turn from angle a to angle b, in radians. */
export function angleDelta(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Turn `angle` toward `target` by at most `maxStep` radians. */
export function turnToward(angle, target, maxStep) {
  const d = angleDelta(angle, target);
  return angle + clamp(d, -maxStep, maxStep);
}

/** Heading convention for the whole game: forward = (sin h, 0, cos h). */
export function forwardOf(heading, out) {
  out.set(Math.sin(heading), 0, Math.cos(heading));
  return out;
}

export const dist2d = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);

/**
 * Push a circle (x, z, radius r) out of every AABB collider it overlaps.
 * Colliders are { minX, maxX, minZ, maxZ }. Mutates and returns [x, z].
 * Two passes so corners resolve cleanly; cheap enough for our counts.
 */
export function collideCircle(colliders, x, z, r) {
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i];
      if (x < c.minX - r || x > c.maxX + r || z < c.minZ - r || z > c.maxZ + r) continue;
      const cx = clamp(x, c.minX, c.maxX);
      const cz = clamp(z, c.minZ, c.maxZ);
      const dx = x - cx, dz = z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 > 1e-9) {
        const d = Math.sqrt(d2);
        if (d < r) { x = cx + (dx / d) * r; z = cz + (dz / d) * r; }
      } else {
        // Centre inside the box: leave by the shallowest face.
        const left = x - c.minX, right = c.maxX - x, top = z - c.minZ, bot = c.maxZ - z;
        const m = Math.min(left, right, top, bot);
        if (m === left) x = c.minX - r;
        else if (m === right) x = c.maxX + r;
        else if (m === top) z = c.minZ - r;
        else z = c.maxZ + r;
      }
    }
  }
  return [x, z];
}

/** Segment vs AABB in 2D — used for line-of-sight (police shooting, spotting). */
export function segmentBlocked(colliders, ax, az, bx, bz) {
  for (let i = 0; i < colliders.length; i++) {
    const c = colliders[i];
    // Slab test.
    let t0 = 0, t1 = 1;
    const dx = bx - ax, dz = bz - az;
    if (Math.abs(dx) < 1e-9) { if (ax < c.minX || ax > c.maxX) continue; }
    else {
      let ta = (c.minX - ax) / dx, tb = (c.maxX - ax) / dx;
      if (ta > tb) { const t = ta; ta = tb; tb = t; }
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 > t1) continue;
    }
    if (Math.abs(dz) < 1e-9) { if (az < c.minZ || az > c.maxZ) continue; }
    else {
      let ta = (c.minZ - az) / dz, tb = (c.maxZ - az) / dz;
      if (ta > tb) { const t = ta; ta = tb; tb = t; }
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 > t1) continue;
    }
    return true;
  }
  return false;
}

/** Format an in-game clock minute count as HH:MM. */
export function clockText(minutes) {
  const m = ((Math.floor(minutes) % 1440) + 1440) % 1440;
  const hh = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

export const moneyText = (n) => '$' + Math.round(n).toLocaleString('en-US');

/** Move `v` toward `target` by at most `step` (per-second rates multiplied by dt). */
export const approach = (v, target, step) => (v < target ? Math.min(target, v + step) : Math.max(target, v - step));

/** HUD-friendly distance: "412 M" under a kilometre, "1.2 KM" above. */
export function distText(m) {
  if (m < 1000) return `${Math.round(m)} M`;
  return `${(m / 1000).toFixed(1)} KM`;
}

/**
 * Minimal pub/sub so the simulation, missions and HUD stay decoupled:
 * play.js raises 'crime', 'shot', 'explosion'; story.js listens and answers
 * with 'dialogue', 'objective'; hud.js renders whatever it is handed.
 */
export class Events {
  constructor() { this.map = new Map(); }
  on(name, fn) {
    if (!this.map.has(name)) this.map.set(name, []);
    this.map.get(name).push(fn);
    return () => this.off(name, fn);
  }
  off(name, fn) {
    const list = this.map.get(name);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  emit(name, payload) {
    const list = this.map.get(name);
    if (!list) return;
    for (const fn of list.slice()) fn(payload);
  }
}

