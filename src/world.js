// Port Saraya, built procedurally: the pastel shophouse grid, Jalan Ombak on the
// strand, Pasar Ikan and the pier, and — across the fence to the east — Sable
// Point Naval Air Station. Everything visual in the game world is made here:
// canvas-texture facades with balconies and shop awnings, curved feather-frond
// palms, harbour cranes, the base. The module also owns the collision boxes and
// the road network the traffic drives on, so what you see is what you hit.

import * as THREE from 'three';
import { makeRng } from './util.js';

// ---- city plan (metres; x east, z south, ground y=0) ----
export const AVENUES = [-84, -28, 28, 76];        // E-W roads, constant z
export const STREETS = [-132, -76, -20, 36];      // N-S roads, constant x
export const ROAD_W = 12;
export const CITY = { minX: -164, maxX: 66, minZ: -114, maxZ: 104 };
export const BASE = { minX: 92, maxX: 270, minZ: -114, maxZ: 104 };
export const GATE = { x: 92, z: 76 };             // base gate, on Jalan Ombak
export const PIER_Z = 128;                        // deck edge; water beyond

const PALETTE = ['#e8b98a', '#9fd4c5', '#f2e3c8', '#e58e6d', '#7fb5b0', '#d9a05b', '#c96f4a', '#e6cf9f', '#d98a80', '#a8c686'];
export const SHOPS = [
  { name: 'KOPI OMBAK', bg: '#0f4c5c', fg: '#ffe9b8' },
  { name: 'SARAYA PAWN & GOLD', bg: '#3a2c14', fg: '#ffd257' },
  { name: 'BENGKEL DARIO', bg: '#5c1f16', fg: '#ffb347' },
  { name: 'HOTEL PELANGI', bg: '#173f35', fg: '#a8e6cf' },
  { name: 'TIDE MART · 24 JAM', bg: '#7a1f2b', fg: '#ffe3e3' },
  { name: 'SATE LAUT', bg: '#40260f', fg: '#ffc978' },
  { name: 'PASAR IKAN', bg: '#123a4a', fg: '#9fe8ff' },
  { name: 'WARUNG SENJA', bg: '#4a2c5c', fg: '#ffd98a' },
  { name: 'TOKO MAS SINAR', bg: '#2c2c34', fg: '#f7d774' },
  { name: 'APOTEK BAYU', bg: '#e8f2e4', fg: '#1d6b4f' },
];

const std = (color, rough = 0.9, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: rough, ...extra });
const flat = (color, rough = 0.75, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: rough, flatShading: true, ...extra });

function box(w, h, d, mat, x, y, z, parent) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true; m.receiveShadow = true;
  parent.add(m);
  return m;
}

/** Vertical sky gradient used as the scene background. The canvas is kept
 *  and repainted by the day-night cycle (world.setClock) from lerped phase
 *  stops; it starts on the golden-hour gradient the game shipped with. */
const SKY_STOP_POS = [0.0, 0.34, 0.58, 0.78, 1.0];
function makeSky() {
  const c = document.createElement('canvas'); c.width = 4; c.height = 512;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const paint = (stops) => {
    const g = c.getContext('2d');
    const gr = g.createLinearGradient(0, 0, 0, 512);
    stops.forEach((s, i) => gr.addColorStop(SKY_STOP_POS[i], s));
    g.fillStyle = gr; g.fillRect(0, 0, 4, 512);
    tex.needsUpdate = true;
  };
  paint(['#2c1e4e', '#7a3060', '#c65a3a', '#f08c46', '#ffc978']);
  return { tex, paint };
}

function glowSprite(inner, outer, scale, opacity) {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(128, 128, 8, 128, 128, 128);
  gr.addColorStop(0, inner); gr.addColorStop(1, outer);
  g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, opacity, depthWrite: false, fog: false }));
  s.scale.setScalar(scale);
  return s;
}

// ---------------------------------------------------------------------------
// Facades: one canvas per (colour, layout) — windows with frames, mullions,
// shutters, lit/unlit variety, grime; the shop band at the bottom when asked.
// The layout numbers are returned so geometry (balconies, AC) can align.
// ---------------------------------------------------------------------------
function facadeTexture(rng, base, lay, litRatio, shop) {
  const { floors, cols, parapetPx, shopPx } = lay;
  const c = document.createElement('canvas'); c.width = 256; c.height = 512;
  const g = c.getContext('2d');
  // Night twin of the facade: black except the lit windows and shop panes,
  // used as the material's emissiveMap so windows glow after dark while the
  // walls stay dark (world.setClock raises emissiveIntensity at night).
  const nc = document.createElement('canvas'); nc.width = 256; nc.height = 512;
  const ng = nc.getContext('2d');
  ng.fillStyle = '#000'; ng.fillRect(0, 0, 256, 512);
  g.fillStyle = base; g.fillRect(0, 0, 256, 512);
  const gr = g.createLinearGradient(0, 0, 0, 512);
  gr.addColorStop(0, 'rgba(255,190,120,0.20)'); gr.addColorStop(0.6, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(30,10,20,0.28)');
  g.fillStyle = gr; g.fillRect(0, 0, 256, 512);
  const regionH = 512 - parapetPx - shopPx;
  const fh = regionH / floors, cw = 256 / cols;
  const litCols = ['#ffc978', '#ffbe6e', '#ffd98a', '#ffb85e', '#ffe3ae'];
  const darkCols = ['#1d2b33', '#24333d', '#1a2833', '#2a3540'];
  const shutCols = ['#14666b', '#7a4436', '#31456e', '#5e6e46'];
  const doorCol = !shop ? Math.floor(rng() * cols) : -1;
  for (let f = 0; f < floors; f++) {
    const by = parapetPx + f * fh;
    g.fillStyle = 'rgba(60,30,20,0.35)'; g.fillRect(0, by + fh - 2, 256, 2);
    for (let col = 0; col < cols; col++) {
      const ground = f === floors - 1;
      if (ground && col === doorCol) {
        const dw = cw * 0.52, dh = fh * 0.86, dx = col * cw + cw * 0.24, dy = by + fh - dh;
        g.fillStyle = '#3a2a20'; g.fillRect(dx - 2, dy - 2, dw + 4, dh + 2);
        g.fillStyle = '#5c3a26'; g.fillRect(dx, dy, dw, dh);
        g.fillStyle = '#ffd98a'; g.fillRect(dx + dw - 7, dy + dh * 0.5, 3, 3);
        continue;
      }
      const w = cw * 0.52, h = fh * 0.56;
      const x = col * cw + cw * 0.24, y = by + fh * 0.22;
      if (rng() < 0.3) { // shutters
        g.fillStyle = shutCols[Math.floor(rng() * shutCols.length)];
        g.fillRect(x - w * 0.3, y, w * 0.26, h); g.fillRect(x + w * 1.04, y, w * 0.26, h);
      }
      g.fillStyle = '#2e2019'; g.fillRect(x - 2.5, y - 2.5, w + 5, h + 5);
      const lit = rng() < litRatio;
      let lc = null;
      if (lit) {
        const lg = g.createLinearGradient(0, y, 0, y + h);
        lc = litCols[Math.floor(rng() * litCols.length)];
        lg.addColorStop(0, lc); lg.addColorStop(1, '#e08b3e');
        g.fillStyle = lg;
      } else {
        g.fillStyle = darkCols[Math.floor(rng() * darkCols.length)];
      }
      g.fillRect(x, y, w, h);
      const blind = lit && rng() < 0.4;
      if (blind) { g.fillStyle = 'rgba(90,40,20,0.5)'; g.fillRect(x, y, w, h * 0.4); } // blind
      if (!lit) { g.fillStyle = 'rgba(200,220,235,0.20)'; g.beginPath(); g.moveTo(x + 2, y + h); g.lineTo(x + w * 0.5, y); g.lineTo(x + w * 0.8, y); g.lineTo(x + w * 0.3, y + h); g.fill(); }
      g.fillStyle = 'rgba(30,18,12,0.55)';
      g.fillRect(x + w / 2 - 1, y, 2, h); g.fillRect(x, y + h / 2 - 1, w, 2); // mullions
      if (lit) { // the same window on the night canvas, mullions and blind included
        ng.fillStyle = lc; ng.fillRect(x, y, w, h);
        if (blind) { ng.fillStyle = 'rgba(0,0,0,0.5)'; ng.fillRect(x, y, w, h * 0.4); }
        ng.fillStyle = '#000';
        ng.fillRect(x + w / 2 - 1, y, 2, h); ng.fillRect(x, y + h / 2 - 1, w, 2);
      }
      if (rng() < 0.3) { g.fillStyle = 'rgba(40,22,14,0.30)'; g.fillRect(x - 1, y + h + 2, w + 2, 4); } // grime
    }
  }
  if (shop) {
    const topY = 512 - shopPx;
    g.fillStyle = 'rgba(24,14,10,0.85)'; g.fillRect(0, topY, 256, shopPx);
    const panes = 4, pw = 256 / panes;
    for (let p = 0; p < panes; p++) {
      const px = p * pw + 5, py = topY + 12, pwid = pw - 10, ph = shopPx - 22;
      const lg = g.createLinearGradient(0, py, 0, py + ph);
      lg.addColorStop(0, '#ffca7a'); lg.addColorStop(1, '#c96f2e');
      g.fillStyle = lg; g.fillRect(px, py, pwid, ph);
      ng.fillStyle = '#e8a34e'; ng.fillRect(px, py, pwid, ph); // shopfronts glow at night
      g.fillStyle = 'rgba(70,35,15,0.55)';
      for (let s = 0; s < 3; s++) g.fillRect(px + 4, py + ph * (0.34 + s * 0.24), pwid - 8, 3);
      for (let s = 0; s < 4; s++) g.fillRect(px + 6 + s * (pwid - 12) / 3, py + ph * 0.34, 4, ph * 0.6);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  const nt = new THREE.CanvasTexture(nc);
  nt.colorSpace = THREE.SRGBColorSpace; nt.anisotropy = 4;
  return { day: t, night: nt };
}

function awningTexture(colA) {
  const c = document.createElement('canvas'); c.width = 128; c.height = 64;
  const g = c.getContext('2d');
  for (let i = 0; i < 8; i++) { g.fillStyle = i % 2 ? '#e8e0cc' : colA; g.fillRect(i * 16, 0, 16, 64); }
  g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(0, 48, 128, 16);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function signTexture(text, bg, fg) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 96;
  const g = c.getContext('2d');
  g.fillStyle = bg; g.fillRect(0, 0, 512, 96);
  g.strokeStyle = fg; g.lineWidth = 4; g.strokeRect(5, 5, 502, 86);
  g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle';
  let size = 44;
  g.font = `800 ${size}px "Avenir Next", sans-serif`;
  while (g.measureText(text).width > 470 && size > 18) { size -= 3; g.font = `800 ${size}px "Avenir Next", sans-serif`; }
  g.fillText(text, 256, 52);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

// ---------------------------------------------------------------------------
// Palms and broadleaf trees (the v3 look: feathered drooping fronds on curved
// ringed trunks; clustered flat-shaded canopies for the broadleaf).
// ---------------------------------------------------------------------------
function trunkTexture(rng) {
  const c = document.createElement('canvas'); c.width = 64; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#8a6a4a'; g.fillRect(0, 0, 64, 256);
  for (let i = 0; i < 260; i++) {
    g.fillStyle = `rgba(${40 + rng() * 40 | 0},${26 + rng() * 26 | 0},14,${0.12 + rng() * 0.15})`;
    g.fillRect(rng() * 64, rng() * 256, 2.5, 2.5);
  }
  for (let y = 6; y < 256; y += 24) {
    g.fillStyle = 'rgba(52,34,18,0.55)'; g.fillRect(0, y, 64, 5);
    g.fillStyle = 'rgba(255,220,170,0.20)'; g.fillRect(0, y + 5, 64, 2);
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(1, 2.2);
  return t;
}

function frondTexture(rng) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 256, 64);
  g.strokeStyle = '#5a4630'; g.lineWidth = 4;
  g.beginPath(); g.moveTo(0, 32); g.lineTo(256, 32); g.stroke();
  for (let i = 0; i < 42; i++) {
    const x = 6 + i * 5.8, len = 15 + Math.sin(i * 0.7) * 4 + rng() * 5;
    g.strokeStyle = ['#6db85a', '#57a047', '#82cc6e', '#4c9440'][i % 4]; g.lineWidth = 3;
    g.beginPath(); g.moveTo(x, 32); g.lineTo(x + 13, 32 - len); g.stroke();
    g.beginPath(); g.moveTo(x, 32); g.lineTo(x + 13, 32 + len); g.stroke();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

function makeFrondGeo() {
  const geo = new THREE.PlaneGeometry(3.0, 0.62, 8, 1);
  const pos = geo.attributes.position;
  for (let v = 0; v < pos.count; v++) {
    const px = pos.getX(v), py = pos.getY(v);
    const t = (px + 1.5) / 3.0;
    pos.setY(v, py * (1 - t * 0.78));
    pos.setZ(v, -(t * t) * 1.3 - Math.abs(py) * 0.85);
  }
  geo.translate(1.5, 0, 0);
  geo.computeVertexNormals();
  return geo;
}

class Vegetation {
  constructor(rng) {
    this.trunkMat = new THREE.MeshStandardMaterial({ map: trunkTexture(rng), roughness: 1 });
    const ft = frondTexture(rng);
    // The emissive term (modulated by the frond texture itself) lifts the
    // crowns out of silhouette at dusk: they read GREEN against poles and
    // sky instead of near-black (owner note 2026-11-21). frondB's old tint
    // (0xb9c9a8) multiplied the texture DOWN ~25%; it is a lift now.
    this.frondA = new THREE.MeshStandardMaterial({ map: ft, alphaTest: 0.38, side: THREE.DoubleSide, roughness: 0.9, emissive: 0x2c4d1c, emissiveMap: ft, emissiveIntensity: 0.75 });
    this.frondB = new THREE.MeshStandardMaterial({ map: ft, alphaTest: 0.38, side: THREE.DoubleSide, roughness: 0.9, color: 0xd9e8c8, emissive: 0x2c4d1c, emissiveMap: ft, emissiveIntensity: 0.65 });
    this.frondDead = new THREE.MeshStandardMaterial({ map: ft, alphaTest: 0.38, side: THREE.DoubleSide, roughness: 1, color: 0xa8895a });
    this.frondGeo = makeFrondGeo();
    this.nutMat = std(0x66702e, 1);
    this.rng = rng;
  }
  palm(h, seed) {
    const rng = this.rng;
    const hash = (n) => { const v = Math.sin(n) * 43758.5453; return v - Math.floor(v); };
    const g = new THREE.Group();
    const C = h * (0.05 + hash(seed * 3.7) * 0.08);
    const segs = 7, sh = h / segs;
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.25, 0.5, 8), this.trunkMat);
    base.position.set(0, 0.25, 0); base.castShadow = true; g.add(base);
    for (let i = 0; i < segs; i++) {
      const t0 = i / segs, tm = (i + 0.5) / segs;
      const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.17 - 0.075 * (t0 + 1 / segs), 0.17 - 0.075 * t0, sh * 1.07, 7), this.trunkMat);
      seg.position.set(C * tm * tm, sh * (i + 0.5), 0);
      seg.rotation.z = -Math.atan(2 * C * tm / h);
      seg.castShadow = true; g.add(seg);
    }
    const crown = new THREE.Group(); crown.position.set(C, h, 0); g.add(crown);
    const fronds = [];
    for (let i = 0; i < 5; i++) fronds.push({ a: (i / 5) * Math.PI * 2 + hash(seed + i) * 0.5, lift: 0.60, s: 0.92, m: i % 2 ? this.frondB : this.frondA });
    for (let i = 0; i < 6; i++) fronds.push({ a: (i / 6) * Math.PI * 2 + 0.4 + hash(seed + 9 + i) * 0.5, lift: 0.26, s: 1.06, m: i % 2 ? this.frondA : this.frondB });
    for (let i = 0; i < 3; i++) fronds.push({ a: (i / 3) * Math.PI * 2 + 0.9, lift: -0.18, s: 0.95, m: this.frondB });
    for (let i = 0; i < 2; i++) fronds.push({ a: (i / 2) * Math.PI * 2 + 1.7, lift: -0.78, s: 0.7, m: this.frondDead });
    for (const fd of fronds) {
      const holder = new THREE.Group(); holder.rotation.y = fd.a;
      const frond = new THREE.Mesh(this.frondGeo, fd.m);
      frond.rotation.z = fd.lift; frond.scale.setScalar(fd.s);
      frond.position.x = 0.04; frond.castShadow = true;
      holder.add(frond); crown.add(holder);
    }
    for (const [nx, ny, nz] of [[0.1, -0.15, 0.08], [-0.12, -0.13, -0.05], [0.02, -0.2, -0.1]]) {
      const nut = new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 8), this.nutMat);
      nut.position.set(C + nx, h + ny, nz); nut.castShadow = true; g.add(nut);
    }
    g.userData.crownY = h;
    void rng;
    return g;
  }
  broadleaf(s) {
    const g = new THREE.Group();
    const barkM = std(0x6e5136, 1);
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.15, 2.7, 7), barkM);
    trunk.position.y = 1.35; trunk.castShadow = true; g.add(trunk);
    for (const sd of [-1, 1]) {
      const br = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.07, 1.35, 6), barkM);
      br.position.set(sd * 0.34, 3.05, 0); br.rotation.z = sd * -0.6; br.castShadow = true; g.add(br);
    }
    const greens = [0x4a7d3a, 0x5c8f42, 0x3e6e33, 0x54853c];
    const blobs = [[0, 4.05, 0, 1.4], [0.9, 3.5, 0.3, 1.0], [-0.85, 3.6, -0.25, 1.05], [0.25, 3.55, -0.75, 0.9], [-0.3, 3.6, 0.8, 0.95]];
    blobs.forEach(([bx, by, bz, br], i) => {
      const b = new THREE.Mesh(new THREE.IcosahedronGeometry(br, 1), flat(greens[i % 4], 0.95));
      b.position.set(bx, by, bz); b.castShadow = true; g.add(b);
    });
    g.scale.setScalar(s);
    return g;
  }
}

// ---------------------------------------------------------------------------
// One shophouse: facade-textured box plus the geometry that sells it —
// balconies and AC units aligned to the painted window grid, parapets,
// roof water tanks / antennas / setback storeys, and for shops a sign,
// a striped awning and a step. Local +Z is the street face; the caller
// rotates the group. Returns nothing; pushes its AABB into `colliders`.
// ---------------------------------------------------------------------------
function buildBuilding(scene, colliders, rng, veg, opts, facadeMats) {
  const { x, z, w, h, d, color, shop, face } = opts; // face: 0=+Z 1=+X 2=-Z 3=-X
  const grp = new THREE.Group();
  const parapetM = 0.55, shopM = shop ? 3.4 : 0;
  const regionM = h - parapetM - shopM;
  const floors = Math.max(shop ? 1 : 2, Math.round(regionM / 2.9));
  const cols = Math.max(3, Math.round(w / 2.6));
  const lay = { floors, cols, parapetPx: 512 * parapetM / h, shopPx: 512 * shopM / h };
  const bandM = regionM / floors, colM = w / cols;
  const winH = bandM * 0.56;
  const winX = (col) => -w / 2 + (col + 0.5) * colM;
  const winY = (f) => h - parapetM - (f + 0.5) * bandM;
  const sillY = (f) => winY(f) - winH / 2;
  const frontZ = d / 2;
  const tex = facadeTexture(rng, color, lay, 0.42, !!shop);
  const mat = new THREE.MeshStandardMaterial({ map: tex.day, emissiveMap: tex.night, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.92 });
  if (facadeMats) facadeMats.push(mat);
  const plain = std(new THREE.Color(color).multiplyScalar(0.8), 0.95);
  const roofM = std(0x6e4a3a, 0.95);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), [mat, mat, roofM, roofM, mat, mat]);
  mesh.position.y = h / 2; mesh.castShadow = true; mesh.receiveShadow = true;
  grp.add(mesh);
  box(w + 0.3, 0.35, d + 0.3, roofM, 0, h + 0.15, 0, grp);
  box(w + 0.14, 0.17, 0.12, std(new THREE.Color(color).multiplyScalar(1.12), 0.9), 0, h - 0.3, frontZ + 0.03, grp);
  const concreteM = std(0xcfc4b0, 0.95), railM = std(0x2e3134, 0.5, { metalness: 0.6 }), acM = std(0xb9bcbe, 0.6, { metalness: 0.3 });
  const terraM = std(0xa85f38, 0.9), leafM = flat(0x4d7d33, 0.9);
  const plantPot = (px, py, pz, s = 1) => {
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.10 * s, 0.075 * s, 0.17 * s, 8), terraM);
    pot.position.set(px, py, pz); grp.add(pot);           // sub-texel at shadow range: no cast
    const blob = new THREE.Mesh(new THREE.IcosahedronGeometry(0.15 * s, 1), leafM);
    blob.position.set(px, py + 0.16 * s, pz); grp.add(blob);
  };
  let nBalc = 0, nAC = 0;
  for (let f = 0; f < floors; f++) {
    const groundBand = !shop && f === floors - 1;
    for (let col = 0; col < cols; col++) {
      if (!groundBand && nBalc < 5 && rng() < 0.26) {
        nBalc++;
        const bx = winX(col), by = sillY(f);
        box(1.8, 0.09, 0.66, concreteM, bx, by - 0.06, frontZ + 0.33, grp);
        // balcony rails/spindles are centimetre-thin: invisible in a 340 m
        // shadow frustum, but each was a shadow-pass draw call. No cast.
        box(1.8, 0.05, 0.05, railM, bx, by + 0.52, frontZ + 0.62, grp).castShadow = false;
        for (let sp = 0; sp < 6; sp++) box(0.035, 0.5, 0.035, railM, bx - 0.75 + sp * 0.3, by + 0.26, frontZ + 0.62, grp).castShadow = false;
        box(0.05, 0.05, 0.6, railM, bx - 0.87, by + 0.52, frontZ + 0.33, grp).castShadow = false;
        box(0.05, 0.05, 0.6, railM, bx + 0.87, by + 0.52, frontZ + 0.33, grp).castShadow = false;
        if (rng() < 0.3) plantPot(bx + 0.58, by - 0.01, frontZ + 0.3, 0.9);
        if (rng() < 0.16) {
          const cloth = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.62),
            std([0xf2e3c8, 0xe58e6d, 0x9fd4c5, 0xf7d774][Math.floor(rng() * 4)], 0.95, { side: THREE.DoubleSide }));
          cloth.position.set(bx - 0.32, by + 0.2, frontZ + 0.64);
          cloth.rotation.z = (rng() - 0.5) * 0.12; grp.add(cloth);
        }
      } else if (!groundBand && nAC < 4 && rng() < 0.14) {
        nAC++;
        box(0.56, 0.38, 0.3, acM, winX(col), sillY(f) - 0.3, frontZ + 0.16, grp);
        box(0.46, 0.28, 0.03, std(0x3a3f42, 0.7), winX(col), sillY(f) - 0.3, frontZ + 0.32, grp).castShadow = false;
      }
    }
  }
  const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, h - 0.4, 6), std(0x4a4038, 0.8));
  pipe.position.set(-w / 2 + 0.3, (h - 0.4) / 2 + 0.1, frontZ + 0.07); grp.add(pipe); // 9 cm wide: no cast
  if (h >= 10 && rng() < 0.45) {
    const hs = 2.3 + rng() * 1.4, sw = w * 0.64, sd = d * 0.68;
    const lay2 = { floors: 1, cols: Math.max(2, Math.round(sw / 2.6)), parapetPx: 512 * 0.3 / hs, shopPx: 0 };
    const tex2 = facadeTexture(rng, new THREE.Color(color).multiplyScalar(0.94).getStyle(), lay2, 0.4, false);
    const mat2 = new THREE.MeshStandardMaterial({ map: tex2.day, emissiveMap: tex2.night, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.92 });
    if (facadeMats) facadeMats.push(mat2);
    const top2 = new THREE.Mesh(new THREE.BoxGeometry(sw, hs, sd), [mat2, mat2, roofM, roofM, mat2, mat2]);
    top2.position.set((rng() - 0.5) * w * 0.1, h + hs / 2 + 0.3, -d * 0.08);
    top2.castShadow = true; top2.receiveShadow = true; grp.add(top2);
    box(sw + 0.24, 0.22, sd + 0.24, roofM, top2.position.x, h + hs + 0.42, top2.position.z, grp);
    plantPot(-w * 0.3, h + 0.33, frontZ - 0.55, 1.15);
    plantPot(-w * 0.3 + 0.55, h + 0.33, frontZ - 0.5, 0.9);
  } else {
    if (rng() < 0.5) {
      const tx = w * 0.3, tz = -d * 0.15, tankM = std(0x8a5a3a, 0.65, { metalness: 0.35 });
      for (const [lx, lz] of [[-0.38, -0.38], [0.38, -0.38], [-0.38, 0.38], [0.38, 0.38]])
        box(0.07, 0.5, 0.07, std(0x5a4632, 0.9), tx + lx, h + 0.57, tz + lz, grp);
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 1.05, 12), tankM);
      tank.position.set(tx, h + 1.34, tz); tank.castShadow = true; grp.add(tank);
      const cap = new THREE.Mesh(new THREE.ConeGeometry(0.66, 0.34, 12), tankM);
      cap.position.set(tx, h + 2.03, tz); cap.castShadow = true; grp.add(cap);
    }
    if (rng() < 0.55) {
      const ax = -w * 0.32, az = -d * 0.15;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.7, 6), std(0x333638, 0.6));
      pole.position.set(ax, h + 1.17, az); grp.add(pole);
      box(0.8, 0.03, 0.03, std(0x333638, 0.6), ax, h + 1.95, az, grp);
      box(0.55, 0.03, 0.03, std(0x333638, 0.6), ax, h + 1.68, az, grp);
    }
  }
  if (shop) {
    const s = SHOPS[shop % SHOPS.length];
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(w * 0.86, 8.4), 1.05),
      new THREE.MeshBasicMaterial({ map: signTexture(s.name, s.bg, s.fg) }));
    sign.position.set(0, 3.78, frontZ + 0.06);
    grp.add(sign);
    const awnLen = Math.min(w * 0.84, 7.6);
    const awnMat = new THREE.MeshStandardMaterial({ map: awningTexture(shop % 2 ? '#b6492f' : '#14666b'), roughness: 0.9 });
    const awn = box(awnLen, 0.06, 1.7, awnMat, 0, 3.02, frontZ + 0.8, grp);
    awn.rotation.x = 0.3;
    box(awnLen, 0.3, 0.04, awnMat, 0, 2.8, frontZ + 1.58, grp);
    const rodM = std(0x2f3336, 0.5, { metalness: 0.6 });
    for (const rx of [-awnLen / 2 + 0.25, awnLen / 2 - 0.25]) {
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 1.7, 6), rodM);
      rod.position.set(rx, 3.18, frontZ + 0.82); rod.rotation.x = 1.05; grp.add(rod);
    }
    box(Math.min(w * 0.7, 5), 0.1, 1.0, std(0xcfc4b0, 0.95), 0, 0.19, frontZ + 0.5, grp);
    if (rng() < 0.6) {
      box(0.55, 0.55, 0.55, std(0xa9743f, 0.9), w * 0.36, 0.42, frontZ + 0.45, grp);
      box(0.48, 0.48, 0.48, std(0x8a6a4a, 0.9), w * 0.36, 0.93, frontZ + 0.42, grp);
    }
  }
  grp.position.set(x, 0, z);
  grp.rotation.y = face * Math.PI / 2;
  scene.add(grp);
  // AABB in world space (rotation by whole right angles only)
  const hw = (face % 2 === 0 ? w : d) / 2, hd = (face % 2 === 0 ? d : w) / 2;
  colliders.push({ minX: x - hw, maxX: x + hw, minZ: z - hd, maxZ: z + hd });
  void veg;
  return grp;
}

// ---------------------------------------------------------------------------
// buildWorld: assemble everything, return the data the game runs on.
// ---------------------------------------------------------------------------
export function buildWorld(scene, seed = 1) {
  const rng = makeRng(seed * 7919 + 13);
  const colliders = [];       // movement collision (AABBs)
  const los = [];             // line-of-sight blockers (buildings, hangar)
  const facadeMats = [];      // building materials whose windows glow at night
  const veg = new Vegetation(rng);

  const sky = makeSky();
  scene.background = sky.tex;
  scene.fog = new THREE.Fog(0xcf7040, 110, 520);
  const hemi = new THREE.HemisphereLight(0xffd2a0, 0x453248, 1.05);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffa257, 2.7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(768, 768); // the frustum spans 340 m, so texels were already ~33 cm; 768 costs little softness, saves real fill
  sun.shadow.camera.left = -170; sun.shadow.camera.right = 170;
  sun.shadow.camera.top = 170; sun.shadow.camera.bottom = -170;
  sun.shadow.camera.far = 700; sun.shadow.bias = -0.0006;
  scene.add(sun); scene.add(sun.target);
  const fill = new THREE.DirectionalLight(0xffc9a0, 0.5);
  fill.position.set(80, 60, -120);
  scene.add(fill);
  const sunBall = glowSprite('rgba(255,240,205,1)', 'rgba(255,150,60,0)', 46, 0.95);
  sunBall.position.set(-330, 62, 330); scene.add(sunBall);
  const sunHalo = glowSprite('rgba(255,170,80,0.55)', 'rgba(255,120,50,0)', 150, 0.5);
  sunHalo.position.copy(sunBall.position); scene.add(sunHalo);
  // stars: one Points dome, faded in by the day-night cycle at night
  const starMat = new THREE.PointsMaterial({ color: 0xcfe0ff, size: 1.7, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, fog: false });
  {
    const sr = makeRng(5150);
    const pts = [];
    for (let i = 0; i < 520; i++) {
      const az = sr() * Math.PI * 2, el = Math.asin(sr() * 0.92 + 0.06), r = 620;
      pts.push(40 + Math.cos(az) * Math.cos(el) * r, Math.sin(el) * r, 10 + Math.sin(az) * Math.cos(el) * r);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    scene.add(new THREE.Points(starGeo, starMat));
  }
  let lampHaloMat = null, lampPoolMat = null;   // assigned in the lamp block below

  // ---- water (animated streak texture) and far ground ----
  const wc = document.createElement('canvas'); wc.width = wc.height = 256;
  const wg2 = wc.getContext('2d');
  wg2.fillStyle = '#17424e'; wg2.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 300; i++) {
    wg2.fillStyle = `rgba(${140 + rng() * 80 | 0},${90 + rng() * 60 | 0},60,${0.05 + rng() * 0.12})`;
    wg2.fillRect(rng() * 256, rng() * 256, 8 + rng() * 30, 1.6);
  }
  const waterTex = new THREE.CanvasTexture(wc);
  waterTex.wrapS = waterTex.wrapT = THREE.RepeatWrapping; waterTex.repeat.set(30, 24);
  waterTex.colorSpace = THREE.SRGBColorSpace;
  const water = new THREE.Mesh(new THREE.PlaneGeometry(1100, 900),
    new THREE.MeshStandardMaterial({ map: waterTex, roughness: 0.55, metalness: 0.25 }));
  water.rotation.x = -Math.PI / 2; water.position.set(40, -0.5, 60);
  scene.add(water);
  const far = new THREE.Mesh(new THREE.PlaneGeometry(1100, 560), std(0x5c4450, 1));
  far.rotation.x = -Math.PI / 2; far.position.set(40, -0.08, -152);
  far.receiveShadow = true;
  scene.add(far);
  // distant headland silhouettes across the bay
  for (const [hx, hz, hw, hh] of [[-420, 320, 300, 42], [180, 380, 420, 30], [520, 240, 260, 52]]) {
    const hill = box(hw, hh, 60, std(0x51304a, 1), hx, hh / 2 - 4, hz, scene);
    hill.castShadow = false; hill.receiveShadow = false;
  }

  // ---- land slab, asphalt road strips, block sidewalks ----
  // (The asphalt used to be one map-wide plane: it buried the sidewalk slabs
  // and the base pads under a single dark sheet and carried a long sun-glare
  // band. Roads are strips now, with a speckled texture that breaks the
  // grazing-angle sheen into ordinary tarmac grain.)
  const grainTex = (base, fleck, n = 2600) => {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = base; g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < n; i++) {
      g.fillStyle = fleck[i % fleck.length];
      g.globalAlpha = 0.05 + rng() * 0.1;
      g.fillRect(rng() * 256, rng() * 256, 1 + rng() * 3, 1 + rng() * 3);
    }
    g.globalAlpha = 1;
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  const landTex = grainTex('#8a7360', ['#7a624e', '#9a8268', '#6e5743']);
  landTex.repeat.set(40, 20);
  const land = box(452, 0.1, 232, new THREE.MeshStandardMaterial({ map: landTex, roughness: 1 }), 53, -0.05, -5, scene);
  land.castShadow = false;
  // (This grain draw is kept even though the strips now use the richer
  // asphalt below: it preserves the world rng stream, so every building and
  // prop downstream is generated exactly as before.)
  const roadTexA = grainTex('#554e55', ['#4a444c', '#615a62', '#3f3a41']);
  void roadTexA;
  // Road dressing gets its own rng so the scatter below can never shift the
  // world rng stream either.
  const rr = makeRng(90210);
  // Rich asphalt: aggregate speckle over soft tonal patches, hairline cracks
  // and tar repair seams. ~16 m tiles keep the repetition subtle; avenues and
  // streets use different seeds for per-street variation.
  const asphaltTex = (seed) => {
    const r = makeRng(seed);
    const c = document.createElement('canvas'); c.width = c.height = 512;
    const g = c.getContext('2d');
    g.fillStyle = '#4e4a4f'; g.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 16; i++) {                        // tonal patches
      const px = r() * 512, py = r() * 512, rad = 60 + r() * 150;
      const gr = g.createRadialGradient(px, py, 4, px, py, rad);
      gr.addColorStop(0, r() < 0.55 ? 'rgba(28,25,30,0.13)' : 'rgba(198,190,180,0.07)');
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(px, py, rad, 0, 7); g.fill();
    }
    for (let i = 0; i < 15000; i++) {                     // aggregate speckle
      g.fillStyle = r() < 0.5 ? '#5d585f' : '#3a373d';
      g.globalAlpha = 0.05 + r() * 0.11;
      g.fillRect(r() * 512, r() * 512, 1 + r() * 2, 1 + r() * 2);
    }
    g.globalAlpha = 1;
    g.strokeStyle = 'rgba(24,22,26,0.35)';                // hairline cracks
    for (let i = 0; i < 9; i++) {
      g.lineWidth = 0.8 + r() * 0.8; g.beginPath();
      let px = r() * 512, py = r() * 512; g.moveTo(px, py);
      for (let s = 0; s < 5; s++) { px += (r() - 0.5) * 90; py += (r() - 0.5) * 90; g.lineTo(px, py); }
      g.stroke();
    }
    g.fillStyle = 'rgba(30,28,32,0.20)';                  // tar repair seams
    for (let i = 0; i < 4; i++) {
      if (r() < 0.5) g.fillRect(0, r() * 512, 512, 3 + r() * 4);
      else g.fillRect(r() * 512, 0, 3 + r() * 4, 512);
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    return t;
  };
  const asphA = asphaltTex(4242); asphA.repeat.set(28, 1);
  const asphS = asphaltTex(777); asphS.repeat.set(1, 14);
  const roadMatA = new THREE.MeshStandardMaterial({ map: asphA, roughness: 0.96 });
  const roadMatS = new THREE.MeshStandardMaterial({ map: asphS, roughness: 0.96 });
  const roadStrip = (w, d, mat, x, z, y = 0.02) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
    m.rotation.x = -Math.PI / 2; m.position.set(x, y, z);
    m.receiveShadow = true; scene.add(m);
    return m;
  };
  for (const z of AVENUES) roadStrip(452, 13.6, roadMatA, 53, z, 0.02);
  for (const x of STREETS) roadStrip(13.6, 232, roadMatS, x, -5, 0.026); // 6 mm proud: no z-fight where strips cross
  const slabM = std(0x9a8a76, 1), grassM = std(0x5d7d3c, 1);
  const xCells = [[-164, -138], [-126, -82], [-70, -26], [-14, 30], [42, 66]];
  const zCells = [[-114, -90], [-78, -34], [-22, 22], [34, 70], [82, 104]];
  const slab = (cx0, cx1, cz0, cz1, mat = slabM) => {
    // top face sits at y≈0 so feet and wheels never sink into the sidewalk
    const s = box(cx1 - cx0, 0.14, cz1 - cz0, mat, (cx0 + cx1) / 2, -0.068, (cz0 + cz1) / 2, scene);
    s.castShadow = false;
    return s;
  };
  for (const [x0, x1] of xCells) for (const [z0, z1] of zCells) slab(x0, x1, z0, z1);

  // ---- road dressing: markings, gutters, curbs, decals (VISUAL ONLY) ----
  // Nothing here adds colliders or touches the road network, traffic or
  // spawns. Everything is merged into one mesh per material (the old paint
  // was ~350 separate planes). Paint layers sit at stepped heights over the
  // asphalt — gutter .032, tyre polish .034, decals .036–.038, edge lines
  // .040, centrelines .042, arrows .043, stop lines .045, zebras .048 — and
  // the paint materials polygon-offset, so no layer z-fights another.
  const mergeGeoms = (geoms) => {
    const parts = geoms.map((g) => (g.index ? g.toNonIndexed() : g));
    let total = 0; for (const p of parts) total += p.attributes.position.count;
    const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), uv = new Float32Array(total * 2);
    let o = 0;
    for (const p of parts) {
      pos.set(p.attributes.position.array, o * 3);
      nor.set(p.attributes.normal.array, o * 3);
      if (p.attributes.uv) uv.set(p.attributes.uv.array, o * 2);
      o += p.attributes.position.count;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return geo;
  };
  const plain = (arr, w, d, x, y, z, rot = 0, uRep = 0, vRep = 0) => {
    const g = new THREE.PlaneGeometry(w, d);
    if (uRep || vRep) {
      const uv = g.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uRep ? uv.getX(i) * uRep : uv.getX(i), vRep ? uv.getY(i) * vRep : uv.getY(i));
    }
    g.rotateX(-Math.PI / 2); if (rot) g.rotateY(rot); g.translate(x, y, z); arr.push(g);
  };
  // Worn paint: tonal scuffs plus chips punched through to the asphalt; each
  // quad samples a shifted, tiled patch so the wear never repeats in step.
  const paintTexture = (hex) => {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = hex; g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 2600; i++) {
      g.fillStyle = rr() < 0.5 ? 'rgba(60,55,50,0.10)' : 'rgba(255,255,255,0.08)';
      g.fillRect(rr() * 256, rr() * 256, 1 + rr() * 3, 1 + rr() * 3);
    }
    g.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 1500; i++) {
      g.globalAlpha = 0.5 + rr() * 0.5;
      g.fillRect(rr() * 256, rr() * 256, 1 + rr() * 2.5, 1 + rr() * 2.5);
    }
    g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    return t;
  };
  const paintMat = (hex) => new THREE.MeshStandardMaterial({
    map: paintTexture(hex), transparent: true, alphaTest: 0.35, roughness: 0.85,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const paint = (arr, w, d, x, y, z, rot = 0) => {
    const g = new THREE.PlaneGeometry(w, d);
    const uv = g.attributes.uv, ou = rr() * 0.6, ov = rr() * 0.6;
    const su = Math.max(1, Math.round(w / 6)) * 0.34, sv = Math.max(1, Math.round(d / 6)) * 0.34;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su + ou, uv.getY(i) * sv + ov);
    g.rotateX(-Math.PI / 2); if (rot) g.rotateY(rot); g.translate(x, y, z); arr.push(g);
  };
  const gCirc = (arr, r, x, y, z, sx = 1, sz = 1, rot = 0) => {
    const g = new THREE.CircleGeometry(r, 22);
    g.rotateX(-Math.PI / 2); g.scale(sx, 1, sz); if (rot) g.rotateY(rot); g.translate(x, y, z); arr.push(g);
  };
  // free intervals of [from,to] after cutting out the blocked spans
  const segs = (from, to, blocks) => {
    const out = []; let cur = from;
    for (const [b0, b1] of blocks) { if (b0 > cur) out.push([cur, Math.min(b0, to)]); cur = Math.max(cur, b1); if (cur >= to) break; }
    if (cur < to) out.push([cur, to]);
    return out.filter(([a, b]) => b - a > 0.4);
  };
  const aveBlocks = (pad) => STREETS.map((sx) => [sx - pad, sx + pad]);
  const stBlocks = (pad) => AVENUES.map((az) => [az - pad, az + pad]);
  const AVE_FROM = -171, AVE_TO = 218;      // paint stops short of the runway
  const ST_FROM = -119, ST_TO = 109;

  const whiteGeos = [], yellowGeos = [], gutterGeos = [], polishGeos = [], stainGeos = [],
    patchGeos = [], holeGeos = [], manholeGeos = [], grateGeos = [], arrowGeos = [],
    curbGeos = [], paveGeos = [];

  // avenues: gutters, solid edge lines, tyre polish, double-yellow centre
  for (const az of AVENUES) {
    for (const [a, b] of segs(AVE_FROM, AVE_TO, aveBlocks(7.0))) {
      const len = b - a, mid = (a + b) / 2;
      for (const s of [-1, 1]) {
        plain(gutterGeos, len, 0.55, mid, 0.032, az + s * 6.35, 0, len / 16);
        paint(whiteGeos, len, 0.14, mid, 0.040, az + s * 5.85);
        for (const wp of [2.0, 3.6]) plain(polishGeos, len, 0.85, mid, 0.034, az + s * wp, 0, len / 10);
      }
    }
    for (const [a, b] of segs(AVE_FROM, AVE_TO, aveBlocks(10.6))) {
      const len = b - a, mid = (a + b) / 2;
      for (const s of [-1, 1]) paint(yellowGeos, len, 0.13, mid, 0.042, az + s * 0.28);
    }
  }
  // streets: gutters, edge lines, polish, white dashed centreline
  for (const sx of STREETS) {
    for (const [a, b] of segs(ST_FROM, ST_TO, stBlocks(7.0))) {
      const len = b - a, mid = (a + b) / 2;
      for (const s of [-1, 1]) {
        plain(gutterGeos, 0.55, len, sx + s * 6.35, 0.032, mid, 0, 0, len / 16);
        paint(whiteGeos, 0.14, len, sx + s * 5.85, 0.040, mid);
        for (const wp of [2.0, 3.6]) plain(polishGeos, len, 0.85, sx + s * wp, 0.034, mid, Math.PI / 2, len / 10);
      }
    }
    for (const [a, b] of segs(ST_FROM, ST_TO, stBlocks(10.6)))
      for (let z = a + 1; z + 3 < b; z += 6.5) paint(whiteGeos, 0.15, 3, sx, 0.042, z + 1.5);
  }
  // intersections: zebra crosswalks on all four arms, stop lines on the
  // approach halves (right-hand traffic, lanes at ±2.8), direction arrows
  const arrow = (x, z, h) => {
    const g = new THREE.PlaneGeometry(1.7, 3.4);
    g.rotateX(-Math.PI / 2); g.rotateY(Math.PI + h); g.translate(x, 0.043, z); arrowGeos.push(g);
  };
  for (const az of AVENUES) for (const sx of STREETS) {
    for (const s of [-1, 1]) {
      for (let i = -4; i <= 4; i++) paint(whiteGeos, 0.62, 3.0, sx + i * 1.25, 0.048, az + s * 8.8); // crossing the street
      for (let i = -4; i <= 4; i++) paint(whiteGeos, 3.0, 0.62, sx + s * 8.8, 0.048, az + i * 1.25); // crossing the avenue
    }
    paint(whiteGeos, 0.5, 5.2, sx - 11.6, 0.045, az - 2.95);
    paint(whiteGeos, 0.5, 5.2, sx + 11.6, 0.045, az + 2.95);
    paint(whiteGeos, 5.2, 0.5, sx + 2.95, 0.045, az - 11.6);
    paint(whiteGeos, 5.2, 0.5, sx - 2.95, 0.045, az + 11.6);
    arrow(sx - 18, az - 2.8, Math.PI / 2);
    arrow(sx + 18, az + 2.8, -Math.PI / 2);
    if ((sx + az) % 2 === 0) { arrow(sx + 2.8, az - 18, 0); arrow(sx - 2.8, az + 18, Math.PI); }
    plain(grateGeos, 1.05, 0.55, sx + 7.35, 0.037, az + 6.32);
    plain(grateGeos, 1.05, 0.55, sx - 7.35, 0.037, az - 6.32);
  }
  // parking bays: Jalan Ombak south kerb, Jalan Cemara north kerb
  const bayRun = (zLine, zOut, a, b) => {
    paint(whiteGeos, b - a, 0.12, (a + b) / 2, 0.040, zLine);
    for (let x = a + 2.8; x < b - 1; x += 5.6) paint(whiteGeos, 0.12, Math.abs(zOut - zLine), x, 0.040, (zLine + zOut) / 2);
  };
  bayRun(76 + 3.3, 76 + 5.65, -160, -24);
  bayRun(76 + 3.3, 76 + 5.65, 44, 86);
  bayRun(28 - 3.3, 28 - 5.65, -120, -30);
  // scatter: oil stains, repair patches, patched potholes, manhole covers
  const roadPoint = () => {
    if (rr() < 0.55) {
      const az = rr.pick(AVENUES); const [a, b] = rr.pick(segs(AVE_FROM, AVE_TO, aveBlocks(7.5)));
      return { x: rr.range(a + 2, b - 2), z: az + rr.range(-5, 5), alongX: true };
    }
    const sx = rr.pick(STREETS); const [a, b] = rr.pick(segs(ST_FROM, ST_TO, stBlocks(7.5)));
    return { x: sx + rr.range(-5, 5), z: rr.range(a + 2, b - 2), alongX: false };
  };
  for (let i = 0; i < 26; i++) { const p = roadPoint(); gCirc(stainGeos, 1, p.x, 0.036, p.z, rr.range(0.8, 2.4), rr.range(0.6, 1.6), rr() * 3.14); }
  for (let i = 0; i < 14; i++) { const p = roadPoint(); plain(patchGeos, rr.range(2, 4.5), rr.range(1.6, 3), p.x, 0.037, p.z, (p.alongX ? 0 : Math.PI / 2) + rr.range(-0.04, 0.04)); }
  for (let i = 0; i < 10; i++) { const p = roadPoint(); gCirc(holeGeos, rr.range(0.3, 0.55), p.x, 0.037, p.z); }
  for (const az of AVENUES) for (const [a, b] of segs(AVE_FROM, AVE_TO, aveBlocks(7.5)))
    if (b - a > 12) gCirc(manholeGeos, 0.45, (a + b) / 2 + rr.range(-3, 3), 0.038, az + rr.range(-4.4, 4.4));
  for (const sx of STREETS) for (const [a, b] of segs(ST_FROM, ST_TO, stBlocks(7.5)))
    if (b - a > 12) gCirc(manholeGeos, 0.45, sx + rr.range(-4.4, 4.4), 0.038, (a + b) / 2 + rr.range(-3, 3));
  // curbs: light concrete rims around every block, gapped where the zebra
  // arms cross and at a driveway cut on long runs
  const curbGapsX = [], curbGapsZ = [];
  for (const sx of STREETS) curbGapsX.push([sx - 11.0, sx - 6.6], [sx + 6.6, sx + 11.0]);
  for (const az of AVENUES) curbGapsZ.push([az - 11.0, az - 6.6], [az + 6.6, az + 11.0]);
  const curbRun = (horiz, fixed, a, b, gaps) => {
    let gs = gaps;
    if (b - a > 34) { const d = a + (b - a) * rr.range(0.3, 0.6); gs = gaps.concat([[d - 1.7, d + 1.7]]); }
    for (const [s0, s1] of segs(a, b, gs)) {
      const len = s1 - s0, mid = (s0 + s1) / 2;
      const g = horiz ? new THREE.BoxGeometry(len, 0.15, 0.34) : new THREE.BoxGeometry(0.34, 0.15, len);
      g.translate(horiz ? mid : fixed, 0.0, horiz ? fixed : mid);
      curbGeos.push(g);
    }
  };
  for (const [x0, x1] of xCells) for (const [z0, z1] of zCells) {
    curbRun(true, z0, x0, x1, curbGapsX); curbRun(true, z1, x0, x1, curbGapsX);
    curbRun(false, x0, z0, z1, curbGapsZ); curbRun(false, x1, z0, z1, curbGapsZ);
  }
  // sidewalk paving: seamed concrete overlay on the block slabs (the park
  // keeps its grass), tiled every 2.2 m so the slab grid reads at street level
  for (const [x0, x1] of xCells) for (const [z0, z1] of zCells) {
    if (x0 === -126 && z0 === 34) continue;              // Taman Ombak grass
    plain(paveGeos, x1 - x0, z1 - z0, (x0 + x1) / 2, 0.006, (z0 + z1) / 2, 0, (x1 - x0) / 2.2, (z1 - z0) / 2.2);
  }
  // Sable Point: apron stand lines, a vehicle roadway, motor-pool parking
  // boxes, and a taxiway link to the runway (paint layers over the pads)
  paint(yellowGeos, 0.18, 34, 197, 0.062, 11);
  paint(yellowGeos, 2.0, 0.3, 197, 0.062, 28);
  paint(yellowGeos, 0.18, 32, 215, 0.062, 18);
  paint(yellowGeos, 2.0, 0.3, 215, 0.062, 34);
  paint(whiteGeos, 0.14, 66, 185.5, 0.062, 20);
  paint(whiteGeos, 0.14, 66, 188.5, 0.062, 20);
  for (const bx of [142, 150, 158]) {
    paint(whiteGeos, 7, 0.12, bx, 0.062, 38); paint(whiteGeos, 7, 0.12, bx, 0.062, 42);
    paint(whiteGeos, 0.12, 4, bx - 3.5, 0.062, 40); paint(whiteGeos, 0.12, 4, bx + 3.5, 0.062, 40);
  }
  const taxi = new THREE.Mesh(new THREE.PlaneGeometry(16, 10),
    new THREE.MeshStandardMaterial({ map: asphaltTex(31337), roughness: 0.96 }));
  taxi.rotation.x = -Math.PI / 2; taxi.position.set(234, 0.03, 24);
  taxi.receiveShadow = true; scene.add(taxi);
  paint(yellowGeos, 16, 0.15, 234, 0.042, 24);

  // ---- decal / paint textures and the merged batch meshes ----
  const radialTex = (inner, outer) => {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(64, 64, 6, 64, 64, 62);
    gr.addColorStop(0, inner); gr.addColorStop(1, outer);
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  const stainTex = radialTex('rgba(18,14,12,0.55)', 'rgba(18,14,12,0)');
  const tireTexC = document.createElement('canvas'); tireTexC.width = tireTexC.height = 64;
  {
    const g = tireTexC.getContext('2d');
    const gr = g.createLinearGradient(0, 0, 0, 64);
    gr.addColorStop(0, 'rgba(12,10,12,0)'); gr.addColorStop(0.25, 'rgba(12,10,12,0.20)');
    gr.addColorStop(0.5, 'rgba(12,10,12,0.27)'); gr.addColorStop(0.75, 'rgba(12,10,12,0.20)');
    gr.addColorStop(1, 'rgba(12,10,12,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    for (let i = 0; i < 260; i++) { g.fillStyle = `rgba(12,10,12,${0.03 + rr() * 0.05})`; g.fillRect(rr() * 64, rr() * 64, 2 + rr() * 5, 1.5); }
  }
  const tireTex = new THREE.CanvasTexture(tireTexC);
  tireTex.wrapS = tireTex.wrapT = THREE.RepeatWrapping; tireTex.colorSpace = THREE.SRGBColorSpace;
  const patchTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#3a373c'; g.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 2400; i++) { g.fillStyle = rr() < 0.5 ? '#454148' : '#2f2c31'; g.globalAlpha = 0.08 + rr() * 0.1; g.fillRect(rr() * 128, rr() * 128, 1.5, 1.5); }
    g.globalAlpha = 1; g.strokeStyle = 'rgba(16,14,16,0.65)'; g.lineWidth = 7; g.strokeRect(4, 4, 120, 120);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const holeTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#2b292d';
    g.beginPath();
    for (let i = 0; i <= 14; i++) {
      const a = (i / 14) * Math.PI * 2, rad = 44 + rr() * 14;
      const px = 64 + Math.cos(a) * rad, py = 64 + Math.sin(a) * rad;
      i ? g.lineTo(px, py) : g.moveTo(px, py);
    }
    g.closePath(); g.fill();
    for (let i = 0; i < 300; i++) { g.fillStyle = 'rgba(120,112,104,0.25)'; g.fillRect(24 + rr() * 80, 24 + rr() * 80, 1.6, 1.6); }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const manholeTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#333136'; g.beginPath(); g.arc(64, 64, 62, 0, 7); g.fill();
    g.strokeStyle = '#222126'; g.lineWidth = 5; g.beginPath(); g.arc(64, 64, 54, 0, 7); g.stroke();
    g.strokeStyle = 'rgba(190,190,195,0.35)'; g.lineWidth = 2; g.beginPath(); g.arc(64, 64, 60, 0, 7); g.stroke();
    g.fillStyle = 'rgba(190,190,195,0.28)';
    for (let ring = 0; ring < 3; ring++) for (let i = 0; i < 10 + ring * 4; i++) {
      const a = (i / (10 + ring * 4)) * Math.PI * 2, rad = 16 + ring * 13;
      g.beginPath(); g.arc(64 + Math.cos(a) * rad, 64 + Math.sin(a) * rad, 2.4, 0, 7); g.fill();
    }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const grateTex = (() => {
    const c = document.createElement('canvas'); c.width = 128; c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = '#3d3a40'; g.fillRect(0, 0, 128, 64);
    g.fillStyle = '#17161a';
    for (let i = 0; i < 6; i++) g.fillRect(10 + i * 19, 8, 10, 48);
    g.strokeStyle = 'rgba(190,190,195,0.3)'; g.lineWidth = 3; g.strokeRect(2, 2, 124, 60);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const arrowTex = (() => {
    const c = document.createElement('canvas'); c.width = 128; c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = '#eae5d6';
    g.beginPath();
    g.moveTo(64, 8); g.lineTo(112, 92); g.lineTo(80, 92); g.lineTo(80, 246); g.lineTo(48, 246); g.lineTo(48, 92); g.lineTo(16, 92);
    g.closePath(); g.fill();
    g.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 700; i++) { g.globalAlpha = 0.5 + rr() * 0.5; g.fillRect(rr() * 128, rr() * 256, 1 + rr() * 2.5, 1 + rr() * 2.5); }
    g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    return t;
  })();
  const paveTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = '#9d9080'; g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 5200; i++) {
      g.fillStyle = rr() < 0.5 ? '#a89a86' : '#8a7c68';
      g.globalAlpha = 0.05 + rr() * 0.1;
      g.fillRect(rr() * 256, rr() * 256, 1 + rr() * 2.5, 1 + rr() * 2.5);
    }
    g.globalAlpha = 1;
    for (let i = 0; i < 5; i++) {                        // faint stains
      const px = rr() * 256, py = rr() * 256, rad = 22 + rr() * 46;
      const gr = g.createRadialGradient(px, py, 3, px, py, rad);
      gr.addColorStop(0, 'rgba(70,58,46,0.12)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(px, py, rad, 0, 7); g.fill();
    }
    g.fillStyle = 'rgba(74,64,54,0.55)';                 // slab seams (tile edges)
    g.fillRect(0, 0, 256, 3); g.fillRect(0, 253, 256, 3); g.fillRect(0, 0, 3, 256); g.fillRect(253, 0, 3, 256);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    return t;
  })();
  const gutterMat = new THREE.MeshStandardMaterial({ map: asphaltTex(555), color: 0x8f8a91, roughness: 0.5, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const tireMat = new THREE.MeshBasicMaterial({ map: tireTex, transparent: true, depthWrite: false });
  const stainMat = new THREE.MeshStandardMaterial({ map: stainTex, transparent: true, depthWrite: false, roughness: 1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const patchMat = new THREE.MeshStandardMaterial({ map: patchTex, roughness: 0.98, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const holeMat = new THREE.MeshStandardMaterial({ map: holeTex, transparent: true, alphaTest: 0.3, roughness: 1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const manholeMat = new THREE.MeshStandardMaterial({ map: manholeTex, roughness: 0.55, metalness: 0.35, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const grateMat = new THREE.MeshStandardMaterial({ map: grateTex, roughness: 0.7, metalness: 0.3, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const arrowMat = new THREE.MeshStandardMaterial({ map: arrowTex, transparent: true, alphaTest: 0.3, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const paveMat = new THREE.MeshStandardMaterial({ map: paveTex, roughness: 1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const addBatch = (geos, mat, { shadow = true, cast = false, order = 0 } = {}) => {
    if (!geos.length) return;
    const m = new THREE.Mesh(mergeGeoms(geos), mat);
    m.receiveShadow = shadow; m.castShadow = cast; m.renderOrder = order;
    scene.add(m);
  };
  addBatch(paveGeos, paveMat);
  addBatch(gutterGeos, gutterMat);
  addBatch(polishGeos, tireMat, { shadow: false, order: 1 });
  addBatch(stainGeos, stainMat, { shadow: false, order: 1 });
  addBatch(patchGeos, patchMat);
  addBatch(holeGeos, holeMat);
  addBatch(manholeGeos, manholeMat);
  addBatch(grateGeos, grateMat);
  addBatch(whiteGeos, paintMat('#eae5d6'));
  addBatch(yellowGeos, paintMat('#f0c94e'));
  addBatch(arrowGeos, arrowMat);
  addBatch(curbGeos, std(0xa79b87, 1), { cast: true });

  // ---- buildings: special places first, then seeded fill ----
  const addB = (opts) => { const g = buildBuilding(scene, colliders, rng, veg, opts, facadeMats); los.push(colliders[colliders.length - 1]); return g; };
  // Bengkel Dario (workshop) — faces Jalan Cemara (z=28)
  addB({ x: 8, z: 13, w: 17, h: 9, d: 13, color: '#c96f4a', shop: 2, face: 0 });
  // Hotel Pelangi — tall, faces Jalan Ombak
  addB({ x: 53, z: 44, w: 19, h: 20, d: 15, color: '#7fb5b0', shop: 3, face: 0 });
  // Pawn & Gold on the strand
  addB({ x: -48, z: 44, w: 16, h: 11, d: 13, color: '#e8b98a', shop: 1, face: 0 });
  // Apotek Bayu = the hospital block, west end of Jalan Merak
  addB({ x: -150, z: -52, w: 18, h: 12, d: 14, color: '#f2e3c8', shop: 9, face: 0 });
  const claimed = [
    { x: 8, z: 13 }, { x: 53, z: 44 }, { x: -48, z: 44 }, { x: -150, z: -52 },
  ];
  const nearClaimed = (x, z) => claimed.some((c) => Math.abs(c.x - x) < 15 && Math.abs(c.z - z) < 14);
  xCells.forEach(([x0, x1], xi) => {
    zCells.forEach(([z0, z1], zi) => {
      if (xi === 1 && zi === 2) return;                    // hideout yard
      if (xi === 1 && zi === 3) return;                    // Taman Ombak park
      if (zi === 4 && xi >= 1 && xi <= 2) return;          // Pasar Ikan strand strip
      const spots = [];
      const wCell = x1 - x0, dCell = z1 - z0;
      if (wCell > 30 && dCell > 30) {
        spots.push([x0 + wCell * 0.27, z0 + dCell * 0.27, 2], [x0 + wCell * 0.73, z0 + dCell * 0.27, 2],
                   [x0 + wCell * 0.27, z0 + dCell * 0.73, 0], [x0 + wCell * 0.73, z0 + dCell * 0.73, 0]);
      } else {
        spots.push([(x0 + x1) / 2, (z0 + z1) / 2, zi % 2 ? 0 : 2]);
      }
      for (const [bx, bz, face] of spots) {
        if (nearClaimed(bx, bz)) continue;
        const w = Math.min(wCell * 0.42, rng.range(11, 17));
        const d = Math.min(dCell * 0.42, rng.range(10, 15));
        const h = rng.range(7, 21) * (zi === 0 ? 1.15 : 1);
        const onStrand = zi === 3;
        const shop = (onStrand || zi === 4) && rng() < 0.75 ? rng.int(0, SHOPS.length - 1) : null;
        addB({ x: bx, z: bz, w, h, d, color: PALETTE[rng.int(0, PALETTE.length - 1)], shop, face });
      }
    });
  });

  // hideout yard dressing: crates, a drum, one palm — a place to go quiet
  {
    const crateM = std(0xa9743f, 0.9);
    box(1.1, 1.1, 1.1, crateM, -112, 0.55, -6, scene); box(0.9, 0.9, 0.9, crateM, -110.8, 0.45, -5.2, scene);
    box(0.9, 0.9, 0.9, crateM, -112.2, 1.55, -6.1, scene);
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.95, 10), std(0x7a4436, 0.7, { metalness: 0.3 }));
    drum.position.set(-97, 0.48, 5); drum.castShadow = true; scene.add(drum);
    const p = veg.palm(7.4, 55); p.position.set(-104, 0.14, 8); scene.add(p);
    colliders.push({ minX: -112.7, maxX: -111.4, minZ: -6.6, maxZ: -5.4 });
  }
  // Taman Ombak park: grass, broadleafs, benches, lamps
  {
    slab(-126, -82, 34, 70, grassM);
    for (const [tx, tz] of [[-118, 42], [-92, 44], [-116, 62], [-90, 60], [-104, 52]]) {
      const t = veg.broadleaf(rng.range(0.95, 1.2));
      t.position.set(tx, 0.14, tz); t.rotation.y = rng() * 6.28; scene.add(t);
      colliders.push({ minX: tx - 0.3, maxX: tx + 0.3, minZ: tz - 0.3, maxZ: tz + 0.3 });
    }
    const benchM = std(0x6e5136, 0.9);
    for (const [bx, bz] of [[-110, 50], [-98, 56], [-104, 42]]) {
      box(1.9, 0.08, 0.5, benchM, bx, 0.5, bz, scene);
      box(0.08, 0.5, 0.5, benchM, bx - 0.8, 0.25, bz, scene);
      box(0.08, 0.5, 0.5, benchM, bx + 0.8, 0.25, bz, scene);
    }
  }

  // ---- palms along the strand and avenues; lamps; bins ----
  const palmAt = (x, z, seed) => {
    const p = veg.palm(6 + (Math.sin(seed * 12.9) * 0.5 + 0.5) * 3.6, seed);
    p.position.set(x, 0.1, z);
    p.rotation.y = seed * 1.7;
    scene.add(p);
    colliders.push({ minX: x - 0.28, maxX: x + 0.28, minZ: z - 0.28, maxZ: z + 0.28 });
  };
  let pseed = 3;
  for (let x = -156; x <= 84; x += 11.5) { palmAt(x, 76 - 7.6, pseed++); if (x % 23 < 11) palmAt(x + 5, 76 + 7.6, pseed++); }
  for (let x = -150; x <= 60; x += 17) { palmAt(x, -28 + 7.6, pseed++); palmAt(x + 8, 28 - 7.6, pseed++); }
  for (let z = -100; z <= 96; z += 19) { palmAt(-20 + 7.6, z, pseed++); }
  palmAt(-88, 112, pseed++); palmAt(-30, 112, pseed++); palmAt(30, 112, pseed++);
  palmAt(120, -96, pseed++); palmAt(126, 92, pseed++);
  // Street lamps, separated from the palms (owner note 2026-11-21: "pohon
  // terlalu menyatu sama lampu jalan"). Three things work together:
  //  (1) PLACEMENT is staggered to the palm rows — on the strand every lamp
  //      sits midway between two palms on its kerb, never beside a trunk or
  //      inside a crown; lamp counts are unchanged (11 + 11 + 7 + 7).
  //  (2) LAMPS READ AS LAMPS — pole is readable grey-teal (was near-black
  //      0x23262a), the head is a brighter warm orb, and all heads share one
  //      merged additive halo shell plus one merged fake light pool on the
  //      ground beneath (two extra draw calls for all 36 lamps, no lights).
  //  (3) HEIGHT — heads at 4.65 m, clearly below the lowest palm crowns
  //      (6 m) instead of brushing their drooping fronds at 5.25 m.
  const lampM = std(0x41565c, 0.55, { metalness: 0.45 });
  const lampGlowM = new THREE.MeshStandardMaterial({ color: 0xfff3d0, emissive: 0xffbe78, emissiveIntensity: 2.6 });
  const lampHeads = [];
  const lampAt = (x, z, flip) => {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 4.8, 7), lampM);
    pole.position.set(x, 2.4, z); pole.castShadow = true; scene.add(pole);
    const arm = box(0.08, 0.08, 1.4, lampM, x, 4.75, z + flip * 0.65, scene);
    arm.castShadow = false;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.19, 10, 10), lampGlowM);
    head.position.set(x, 4.65, z + flip * 1.3); scene.add(head);
    lampHeads.push([x, z + flip * 1.3]);
    colliders.push({ minX: x - 0.12, maxX: x + 0.12, minZ: z - 0.12, maxZ: z + 0.12 });
  };
  // Strand (avenue z=76): south palms every 11.5 from -156, north every 23
  // from -151 -> lamps on the gap midpoints (-150.25 + 23k / -139.5 + 23k).
  for (let x = -150.25; x <= 84; x += 23) lampAt(x, 76 - 6.4, 1);
  for (let x = -139.5; x <= 91; x += 23) lampAt(x, 76 + 6.4, -1);
  // Avenue -84: phase shifted +8 (was -140 + 32k) so no lamp hugs the
  // x=-20 street palm row — the old x=-12 lamp stood ~3.5 m from the palm
  // at (-12.4, -81). Avenue 28's north kerb has no palm row; unchanged.
  for (let x = -132; x <= 60; x += 32) lampAt(x, -84 + 6.4, -1);
  for (let x = -140; x <= 56; x += 32) lampAt(x + 16, 28 + 6.4, -1);
  { // merged halos + light pools for every lamp head
    const haloGeos = [], poolGeos = [];
    for (const [hx, hz] of lampHeads) {
      const s = new THREE.SphereGeometry(0.36, 10, 10); s.translate(hx, 4.65, hz); haloGeos.push(s);
      const p = new THREE.PlaneGeometry(7.4, 7.4); p.rotateX(-Math.PI / 2); p.translate(hx, 0.055, hz); poolGeos.push(p);
    }
    const halo = new THREE.Mesh(mergeGeoms(haloGeos),
      new THREE.MeshBasicMaterial({ color: 0xffa64d, transparent: true, opacity: 0.30, blending: THREE.AdditiveBlending, depthWrite: false }));
    halo.renderOrder = 6; scene.add(halo);
    lampHaloMat = halo.material;
    const pc = document.createElement('canvas'); pc.width = pc.height = 128;
    const pg = pc.getContext('2d');
    const grad = pg.createRadialGradient(64, 64, 4, 64, 64, 62);
    grad.addColorStop(0, 'rgba(255,196,116,0.45)');
    grad.addColorStop(0.45, 'rgba(255,166,84,0.17)');
    grad.addColorStop(1, 'rgba(255,150,70,0)');
    pg.fillStyle = grad; pg.fillRect(0, 0, 128, 128);
    const poolTex = new THREE.CanvasTexture(pc); poolTex.colorSpace = THREE.SRGBColorSpace;
    const pools = new THREE.Mesh(mergeGeoms(poolGeos),
      new THREE.MeshBasicMaterial({ map: poolTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    pools.renderOrder = 5; scene.add(pools);
    lampPoolMat = pools.material;
  }
  const binM = std(0x39543e, 0.8);
  for (const [bx, bz] of [[-19.5, 82], [9.5, 70], [31, 82], [-70, 22], [44, 34]]) {
    const bin = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.26, 0.75, 10), binM);
    bin.position.set(bx, 0.5, bz); bin.castShadow = true; scene.add(bin);
    colliders.push({ minX: bx - 0.3, maxX: bx + 0.3, minZ: bz - 0.3, maxZ: bz + 0.3 });
  }

  // ---- Pasar Ikan: stalls with striped canopies, fish crates, scales ----
  {
    const stallM = std(0x8a6a4a, 0.9);
    const canopyCols = ['#b6492f', '#14666b', '#c9862b', '#5c7a3a'];
    for (let i = 0; i < 6; i++) {
      const sx = -70 + i * 9.5, sz = 95;
      box(2.6, 0.08, 1.4, stallM, sx, 1.0, sz, scene);
      for (const [lx, lz] of [[-1.2, -0.6], [1.2, -0.6], [-1.2, 0.6], [1.2, 0.6]])
        box(0.07, 1.0, 0.07, stallM, sx + lx, 0.5, sz + lz, scene);
      const can = box(3.1, 0.05, 2.0, new THREE.MeshStandardMaterial({ map: awningTexture(canopyCols[i % 4]), roughness: 0.9 }), sx, 2.25, sz, scene);
      can.rotation.x = 0.16;
      for (const px of [-0.9, 0, 0.9]) {
        const fx = box(0.55, 0.18, 0.4, std(0xb9c4c9, 0.5, { metalness: 0.4 }), sx + px, 1.13, sz, scene);
        fx.castShadow = false;
        const fish = box(0.4, 0.07, 0.13, std(0xdfe9ec, 0.35, { metalness: 0.6 }), sx + px, 1.26, sz, scene);
        fish.rotation.y = rng() * 0.8; fish.castShadow = false;
      }
      colliders.push({ minX: sx - 1.4, maxX: sx + 1.4, minZ: sz - 0.8, maxZ: sz + 0.8 });
    }
  }

  // ---- Pelangi Pier: deck, warehouse, cranes, containers, the Cahaya Pagi ----
  const deck = box(452, 0.5, 26, std(0x7d7268, 1), 53, -0.23, 116, scene);
  deck.castShadow = false;
  addB({ x: -104, z: 114, w: 22, h: 6.5, d: 10, color: '#8a7360', shop: null, face: 2 });
  const craneM = std(0xb6542e, 0.6, { metalness: 0.35 });
  for (const cx of [-124, -36, 44]) {
    for (const [lx, lz] of [[-3.4, -2.2], [3.4, -2.2], [-3.4, 2.2], [3.4, 2.2]])
      box(0.55, 13, 0.55, craneM, cx + lx, 6.5, 114 + lz, scene);
    box(8.4, 1.0, 5.6, craneM, cx, 13.2, 114, scene);
    const jib = box(17, 0.7, 0.7, craneM, cx + 4.5, 14.6, 114, scene);
    jib.rotation.z = 0.1;
    box(0.16, 5.5, 0.16, craneM, cx + 11.5, 11.8, 114, scene);
    box(1.4, 1.1, 1.4, std(0x5c545c, 0.8), cx + 11.5, 8.9, 114, scene);
    colliders.push({ minX: cx - 3.8, maxX: cx + 3.8, minZ: 111.4, maxZ: 116.6 });
  }
  const contCols = [0x9c4a2f, 0x2e6e6a, 0x3a5a8c, 0x8c7433, 0x6e3a5c];
  for (let i = 0; i < 9; i++) {
    const cx = -150 + i * 22 + rng.range(-3, 3), cz = 121 + (i % 2) * 3.4;
    const cont = box(6.1, 2.6, 2.45, std(contCols[i % 5], 0.75, { metalness: 0.3 }), cx, 1.55, cz, scene);
    cont.rotation.y = (i % 3 - 1) * 0.05;
    if (i % 3 === 0) box(6.1, 2.6, 2.45, std(contCols[(i + 2) % 5], 0.75, { metalness: 0.3 }), cx, 4.15, cz, scene);
    colliders.push({ minX: cx - 3.2, maxX: cx + 3.2, minZ: cz - 1.4, maxZ: cz + 1.4 });
  }
  { // the boat herself: the Cahaya Pagi — a proper little fishing boat.
    // Hull is lofted from cross-sections (transom stern, parallel mid-body,
    // tapered raked bow, sheer rising to the stem), then dressed with a cap
    // rail, wheelhouse, mast + rigging and working-deck gear.
    const boat = new THREE.Group();
    const hullM = std(0xdad2c2, 0.6), trimM = std(0x14666b, 0.55), woodM = std(0x8a6a4a, 0.85);
    const deckM = std(0x7a6a55, 0.95), darkM = std(0x2e3438, 0.5, { metalness: 0.5 });
    const winM = std(0x1d2b33, 0.25, { metalness: 0.5 });
    // stations stern -> bow: [z, halfBeam, keelY, sheerY]
    const STA = [
      [-8.0, 2.02, 0.30, 1.52], [-6.0, 2.28, -0.28, 1.46], [-3.0, 2.32, -0.48, 1.47],
      [0.0, 2.30, -0.52, 1.52], [3.0, 2.18, -0.38, 1.62], [5.5, 1.86, 0.02, 1.78],
      [7.2, 1.30, 0.55, 1.94], [8.3, 0.55, 1.15, 2.06], [8.8, 0.05, 1.62, 2.10],
    ];
    const prof = ([, hb, keel, sheer]) => { // port gunwale -> keel -> starboard gunwale
      const mid = sheer - (sheer - keel) * 0.45, low = keel + (sheer - keel) * 0.22;
      return [[-hb, sheer], [-hb * 0.97, mid], [-hb * 0.78, low], [0, keel],
              [hb * 0.78, low], [hb * 0.97, mid], [hb, sheer]];
    };
    const SEC = STA.map((s) => prof(s).map(([x, y]) => [x, y, s[0]]));
    { // hull skin: quad strips between stations + a fanned transom
      const pos = [];
      const tri = (a, b, c) => pos.push(...a, ...b, ...c);
      for (let i = 0; i < SEC.length - 1; i++)
        for (let j = 0; j < 6; j++) {
          tri(SEC[i][j], SEC[i][j + 1], SEC[i + 1][j]);
          tri(SEC[i][j + 1], SEC[i + 1][j + 1], SEC[i + 1][j]);
        }
      const cen = [0, (STA[0][3] + STA[0][2]) / 2, STA[0][0]];
      for (let j = 0; j < 6; j++) tri(cen, SEC[0][j + 1], SEC[0][j]);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.computeVertexNormals();
      const hull = new THREE.Mesh(g, hullM);
      hull.castShadow = true; hull.receiveShadow = true; boat.add(hull);
    }
    { // weathered deck strip, just below the sheer
      const pos = [];
      const tri = (a, b, c) => pos.push(...a, ...b, ...c);
      const dp = STA.map(([z, hb, , sheer]) => [[-hb * 0.98, sheer - 0.38, z], [hb * 0.98, sheer - 0.38, z]]);
      for (let i = 0; i < dp.length - 1; i++) {
        tri(dp[i][0], dp[i + 1][0], dp[i][1]);
        tri(dp[i][1], dp[i + 1][0], dp[i + 1][1]);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.computeVertexNormals();
      const deck2 = new THREE.Mesh(g, deckM);
      deck2.receiveShadow = true; boat.add(deck2);
    }
    // teal cap rail following the sheer, both sides
    const railSeg = (a, b) => {
      const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const L = Math.hypot(d[0], d[1], d[2]);
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.1, L + 0.06), trimM);
      m.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + 0.03, (a[2] + b[2]) / 2);
      m.rotation.order = 'YXZ';
      m.rotation.y = Math.atan2(d[0], d[2]);
      m.rotation.x = -Math.asin(d[1] / L);
      m.castShadow = true; boat.add(m);
    };
    for (let i = 0; i < STA.length - 1; i++)
      for (const s of [-1, 1])
        railSeg([s * STA[i][1], STA[i][3], STA[i][0]], [s * STA[i + 1][1], STA[i + 1][3], STA[i + 1][0]]);
    // wheelhouse: window band all round, teal roof with an overhang
    box(3.1, 1.95, 3.3, hullM, 0, 2.07, -3.2, boat);
    box(3.24, 0.62, 3.44, winM, 0, 2.62, -3.2, boat);
    box(3.6, 0.16, 3.9, trimM, 0, 3.12, -3.2, boat);
    box(0.7, 0.28, 0.9, hullM, 0.6, 3.34, -3.6, boat); // roof vent
    // fish hold hatch with a teal coaming, between wheelhouse and mast
    box(3.5, 0.12, 3.8, trimM, 0, 1.2, 0.2, boat);
    box(3.3, 0.32, 3.6, woodM, 0, 1.36, 0.2, boat);
    // net reel aft: flanged drum wound with dark net, plus a rope coil + crates
    const reelM = std(0x2e4a3a, 0.95);
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 2.0, 12), reelM);
    drum.rotation.z = Math.PI / 2; drum.position.set(0, 1.78, -6.2); drum.castShadow = true; boat.add(drum);
    for (const fx of [-1.18, 1.18]) {
      const fl = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 0.1, 14), woodM);
      fl.rotation.z = Math.PI / 2; fl.position.set(fx, 1.78, -6.2); fl.castShadow = true; boat.add(fl);
      box(0.14, 0.72, 0.5, darkM, fx, 1.42, -6.2, boat);
    }
    const coil = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.13, 8, 20), std(0x9a8563, 1));
    coil.rotation.x = Math.PI / 2; coil.position.set(1.45, 1.14, -5.1); coil.castShadow = true; boat.add(coil);
    box(0.9, 0.9, 0.9, woodM, -1.3, 1.53, -7.0, boat);
    const crate2 = box(0.7, 0.7, 0.7, woodM, -1.25, 2.32, -7.0, boat); crate2.rotation.y = 0.4;
    // anchor windlass on the foredeck
    box(0.85, 0.42, 0.6, darkM, 0, 1.62, 6.6, boat);
    // mast + aft-raked working boom
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.11, 7.4, 7), woodM);
    mast.position.set(0, 4.9, 2.6); mast.castShadow = true; boat.add(mast);
    box(1.5, 0.07, 0.07, woodM, 0, 7.6, 2.6, boat); // cross-tree
    const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.06, 3.7, 7), woodM);
    boom.position.set(0, 4.2, 0.55); boom.rotation.x = -1.90; boom.castShadow = true; boat.add(boom);
    { // rigging: forestay, backstay, shrouds, boom lift
      const top = [0, 8.55, 2.6];
      const pts = [
        top, [0, 2.1, 8.7], top, [0, 1.75, -7.95],
        top, [-2.24, 1.62, 0.8], top, [2.24, 1.62, 0.8],
        top, [0, 3.6, -1.2],
      ].map((p) => new THREE.Vector3(...p));
      const rig = new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0x23282c }));
      boat.add(rig);
    }
    const name = new THREE.Mesh(new THREE.PlaneGeometry(4.0, 0.78),
      new THREE.MeshBasicMaterial({ map: signTexture('CAHAYA PAGI', '#123a4a', '#ffd98a') }));
    name.position.set(0, 1.02, -8.06); name.rotation.y = Math.PI; boat.add(name);
    boat.position.set(20, 0.1, 143); boat.rotation.y = 0.22;
    scene.add(boat);
  }
  // ---- harbour gulls: one small flock circling the bay SW of the pier,
  // plus a few perched birds. Two-triangle wings, one shared unlit material;
  // the flock fades out on the night factor (gulls roost after dark).
  const gullGroup = new THREE.Group(); scene.add(gullGroup);
  const gullM = new THREE.MeshBasicMaterial({ color: 0xe9eef2, side: THREE.DoubleSide, transparent: true });
  const gullBodyG = new THREE.BoxGeometry(0.09, 0.07, 0.46);
  const wingGeo = (s) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(
      [0, 0, 0.14, s * 0.62, 0, -0.02, 0, 0, -0.18], 3));
    g.computeVertexNormals();
    return g;
  };
  const wingLG = wingGeo(-1), wingRG = wingGeo(1);
  const makeGull = () => {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(gullBodyG, gullM));
    const wl = new THREE.Mesh(wingLG, gullM), wr = new THREE.Mesh(wingRG, gullM);
    g.add(wl, wr);
    g.userData = { wl, wr };
    gullGroup.add(g);
    return g;
  };
  const GULL_C = { x: -12, y: 19.5, z: 168 }; // over the bay, SW of the pier
  const gullFlock = [];
  for (let i = 0; i < 8; i++) {
    const g = makeGull();
    gullFlock.push({
      g,
      a0: i * (Math.PI / 4) + Math.sin(i * 12.99) * 0.35,
      r: 30 + (i % 4) * 3.5 + Math.sin(i * 78.23) * 2.5,
      h: (i % 3 - 1) * 1.6,
      flap: 6.2 + (i % 3) * 0.7, ph: i * 1.37,
    });
  }
  for (const [px, py, pz, yaw] of [[-36, 13.78, 114, 0.7], [44, 13.78, 112.5, -1.9], [-98, 6.58, 110, 2.6]]) {
    const g = makeGull(); // perched: wings swept back and folded, still
    g.position.set(px, py, pz); g.rotation.y = yaw;
    g.userData.wl.rotation.set(0, -0.85, 0.15);
    g.userData.wr.rotation.set(0, 0.85, -0.15);
  }

  // waterline: stops vehicles at the deck edge. Tagged `water` so the
  // on-foot player may pass it and swim (play.js filters it out for feet).
  colliders.push({ minX: -170, maxX: 276, minZ: 127.4, maxZ: 129, water: true });

  // ---- Sable Point Naval Air Station ----
  const oliveM = std(0x5c6248, 0.95), oliveD = std(0x494f3a, 0.95), concM = std(0x8d8578, 1);
  const apron = box(46, 0.12, 78, concM, 205, -0.01, 20, scene); apron.castShadow = false;
  const poolSlab = box(34, 0.12, 26, concM, 148, -0.01, 40, scene); poolSlab.castShadow = false;
  // runway with painted markings (one long canvas texture)
  {
    const c = document.createElement('canvas'); c.width = 128; c.height = 1024;
    const g = c.getContext('2d');
    g.fillStyle = '#3f3a3e'; g.fillRect(0, 0, 128, 1024);
    g.fillStyle = '#e8e2d2';
    for (let y = 30; y < 1024; y += 90) g.fillRect(60, y, 8, 44);           // centreline
    g.fillRect(5, 0, 5, 1024); g.fillRect(118, 0, 5, 1024);                 // edge lines
    for (const y of [150, 190, 792, 832]) { g.fillRect(28, y, 15, 42); g.fillRect(85, y, 15, 42); } // touchdown zones
    for (const y of [8, 976]) for (let i = 0; i < 4; i++) g.fillRect(14 + i * 27, y, 16, 34); // thresholds
    g.fillStyle = 'rgba(255,255,255,0.75)'; g.font = '800 54px sans-serif'; g.textAlign = 'center';
    g.fillText('09', 64, 130); g.fillText('27', 64, 940);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    const rw = new THREE.Mesh(new THREE.PlaneGeometry(15, 196), new THREE.MeshStandardMaterial({ map: t, roughness: 0.95 }));
    rw.rotation.x = -Math.PI / 2; rw.position.set(232, 0.04, -4);
    rw.receiveShadow = true; scene.add(rw);
  }
  // hangar with arched roof
  {
    const hangar = new THREE.Group();
    box(30, 7.5, 24, oliveD, 0, 3.75, 0, hangar);
    const roof = new THREE.Mesh(new THREE.CylinderGeometry(12.4, 12.4, 30, 14, 1, false, 0, Math.PI), oliveM);
    roof.rotation.z = Math.PI / 2; roof.rotation.y = Math.PI / 2;
    roof.position.y = 7.4; roof.castShadow = true; hangar.add(roof);
    box(20, 6.4, 0.3, std(0x2c2f26, 0.9), 0, 3.2, 12.05, hangar);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(13, 1.7),
      new THREE.MeshBasicMaterial({ map: signTexture('SABLE POINT NAS', '#2c2f26', '#ffd98a') }));
    sign.position.set(0, 8.6, 12.2); hangar.add(sign);
    hangar.position.set(150, 0, -64);
    scene.add(hangar);
    const hc = { minX: 134, maxX: 166, minZ: -77, maxZ: -51 };
    colliders.push(hc); los.push(hc);
  }
  // watchtower by the south fence
  {
    const tw = new THREE.Group();
    for (const [lx, lz] of [[-1.6, -1.6], [1.6, -1.6], [-1.6, 1.6], [1.6, 1.6]])
      box(0.32, 11, 0.32, oliveD, lx, 5.5, lz, tw);
    box(5.4, 0.4, 5.4, oliveD, 0, 11.1, 0, tw);
    box(4.6, 2.4, 4.6, std(0x39424a, 0.4, { metalness: 0.3 }), 0, 12.5, 0, tw);
    const roof2 = new THREE.Mesh(new THREE.ConeGeometry(4.1, 1.5, 4), oliveM);
    roof2.position.y = 14.5; roof2.rotation.y = Math.PI / 4; roof2.castShadow = true; tw.add(roof2);
    tw.position.set(112, 0, 92);
    scene.add(tw);
    colliders.push({ minX: 110, maxX: 114, minZ: 90, maxZ: 94 });
  }
  // HQ + armoury + motor-pool sheds
  addBaseBlock(120, -20, 20, 6, 12, 'HQ · SABLE POINT');
  addBaseBlock(168, 66, 18, 5.5, 11, 'ARMOURY');
  addBaseBlock(126, 58, 16, 5, 10, 'MOTOR POOL');
  function addBaseBlock(bx, bz, w, h, d, label) {
    const b = box(w, h, d, oliveM, bx, h / 2, bz, scene);
    b.castShadow = true;
    box(w + 0.4, 0.3, d + 0.4, oliveD, bx, h + 0.15, bz, scene);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(w * 0.8, 9), 1.15),
      new THREE.MeshBasicMaterial({ map: signTexture(label, '#2c2f26', '#e8e2d2') }));
    sign.position.set(bx, h - 1.1, bz + d / 2 + 0.06); scene.add(sign);
    const bc = { minX: bx - w / 2, maxX: bx + w / 2, minZ: bz - d / 2, maxZ: bz + d / 2 };
    colliders.push(bc); los.push(bc);
  }
  // fuel drums + crates at the motor pool
  for (let i = 0; i < 7; i++) {
    const dx = 136 + (i % 4) * 1.1, dz = 30 + Math.floor(i / 4) * 1.1;
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.92, 10), std(i % 2 ? 0x6e5136 : 0x4c5a48, 0.6, { metalness: 0.35 }));
    drum.position.set(dx, 0.52, dz); drum.castShadow = true; scene.add(drum);
  }
  colliders.push({ minX: 135.6, maxX: 140.4, minZ: 29.6, maxZ: 31.6 });
  // windsock (animated in update)
  const sock = new THREE.Group();
  {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 7, 7), std(0xb9bcbe, 0.5, { metalness: 0.5 }));
    pole.position.y = 3.5; sock.add(pole);
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.42, 2.0, 8, 1, true),
      new THREE.MeshStandardMaterial({ color: 0xff7a26, roughness: 0.8, side: THREE.DoubleSide }));
    cone.rotation.z = Math.PI / 2 - 0.18; cone.position.set(1.1, 6.8, 0);
    cone.name = 'sockCone'; sock.add(cone);
    sock.position.set(196, 0, -30);
    scene.add(sock);
  }
  // perimeter fence + the gate on Jalan Ombak
  const fenceMat = new THREE.MeshStandardMaterial({ color: 0x3c4147, roughness: 0.6, metalness: 0.6, transparent: true, opacity: 0.55, side: THREE.DoubleSide });
  const postM = std(0x2c2f26, 0.6, { metalness: 0.5 });
  function fenceRun(x0, z0, x1, z1) {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const mid = [(x0 + x1) / 2, (z0 + z1) / 2];
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(len, 2.6), fenceMat);
    panel.position.set(mid[0], 1.5, mid[1]);
    panel.rotation.y = Math.atan2(x1 - x0, z1 - z0) + Math.PI / 2;
    scene.add(panel);
    const rail = box(len, 0.09, 0.09, postM, mid[0], 2.86, mid[1], scene);
    rail.rotation.y = panel.rotation.y; rail.castShadow = false;
    const n = Math.floor(len / 6);
    for (let i = 0; i <= n; i++) {
      const px = x0 + (x1 - x0) * (i / n), pz = z0 + (z1 - z0) * (i / n);
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 3, 6), postM);
      post.position.set(px, 1.5, pz); scene.add(post);
    }
    colliders.push({
      minX: Math.min(x0, x1) - 0.25, maxX: Math.max(x0, x1) + 0.25,
      minZ: Math.min(z0, z1) - 0.25, maxZ: Math.max(z0, z1) + 0.25,
    });
  }
  fenceRun(BASE.minX, BASE.minZ, BASE.minX, GATE.z - 6);
  fenceRun(BASE.minX, GATE.z + 6, BASE.minX, BASE.maxZ);
  fenceRun(BASE.minX, BASE.minZ, BASE.maxX, BASE.minZ);
  fenceRun(BASE.minX, BASE.maxZ, BASE.maxX, BASE.maxZ);
  fenceRun(BASE.maxX, BASE.minZ, BASE.maxX, BASE.maxZ);
  const gateGroup = new THREE.Group();
  {
    // group is rotated so local +X runs along world Z (across the road gap);
    // leaves are centred at local x = ∓3 and slide outward along local X.
    for (const sd of [-1, 1]) {
      const leaf = new THREE.Mesh(new THREE.PlaneGeometry(5.8, 2.6), fenceMat);
      leaf.position.set(sd * 3, 1.5, 0);
      leaf.name = sd < 0 ? 'gateL' : 'gateR';
      gateGroup.add(leaf);
      const frame = box(5.8, 0.09, 0.09, postM, sd * 3, 2.86, 0, gateGroup);
      frame.castShadow = false;
    }
    const gSign = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 1.0),
      new THREE.MeshBasicMaterial({ map: signTexture('SABLE POINT NAS · RESTRICTED', '#5c1f16', '#ffd9d2') }));
    gSign.position.set(0, 3.6, 0.45); gSign.rotation.y = Math.PI; gateGroup.add(gSign);
    gateGroup.position.set(GATE.x, 0, GATE.z);
    gateGroup.rotation.y = Math.PI / 2;
    scene.add(gateGroup);
  }
  const gateCollider = { minX: GATE.x - 0.3, maxX: GATE.x + 0.3, minZ: GATE.z - 6, maxZ: GATE.z + 6 };
  colliders.push(gateCollider);
  let gateOpen01 = 0, gateTarget = 0;
  const gate = {
    setOpen(open) { gateTarget = open ? 1 : 0; },
    get isOpen() { return gateOpen01 > 0.7; },
  };

  // world bounds (soft walls at the land edge)
  colliders.push({ minX: -400, maxX: -166, minZ: -400, maxZ: 400 });
  colliders.push({ minX: 272, maxX: 700, minZ: -400, maxZ: 400 });
  colliders.push({ minX: -400, maxX: 700, minZ: -400, maxZ: -116 });

  // ---- mission markers (ring + light pillar), pulsed in update ----
  const markers = [];
  function spawnMarker(x, z, color = 0xffb347) {
    const g = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.7, 2.15, 40),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.12; g.add(ring);
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.7, 26, 20, 1, true),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.13, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
    beam.position.y = 13; g.add(beam);
    g.position.set(x, 0, z);
    g.userData = { ring, beam };
    scene.add(g);
    markers.push(g);
    return g;
  }

  const places = {
    spawn: { x: -6, z: 86, heading: Math.PI },
    workshop: { x: 8, z: 21.5 },
    workshopCar: { x: 14, z: 33.5, heading: Math.PI / 2 },
    market: { x: -48, z: 93 },
    hotel: { x: 53, z: 54 },
    pier: { x: -88, z: 114 },
    warehouse: { x: -104, z: 108 },
    hideout: { x: -104, z: 0 },
    hospital: { x: -150, z: -42 },
    park: { x: -104, z: 52 },
    gate: { x: GATE.x, z: GATE.z },
    gateIn: { x: 104, z: 76 },
    apron: { x: 206, z: 24 },
    jetPark: { x: 206, z: 24, heading: -Math.PI / 2 },
    runwayS: { x: 232, z: 84, heading: Math.PI },
    tankPool: { x: 152, z: 42, heading: Math.PI / 2 },
    boat: { x: 20, z: 132 },
    strand: { x: 0, z: 76 },
  };

  const AVE_NAMES = { '-84': 'JALAN KALA', '-28': 'JALAN MERAK', '28': 'JALAN CEMARA', '76': 'JALAN OMBAK' };
  const ST_NAMES = { '-132': 'JALAN PELABUHAN', '-76': 'JALAN NELAYAN', '-20': 'JALAN CENDANA', '36': 'JALAN TIMUR' };
  function locationAt(x, z) {
    if (x >= BASE.minX - 2) return { name: 'SABLE POINT NAS', sub: 'RESTRICTED AREA · GARRISON' };
    if (z >= 104) return { name: 'PELANGI PIER', sub: 'HARBOUR · PORT SARAYA' };
    if (z > 82 && x > -78 && x < -18) return { name: 'PASAR IKAN', sub: 'FISH MARKET · THE STRAND' };
    if (x > -128 && x < -80 && z > 32 && z < 72) return { name: 'TAMAN OMBAK', sub: 'PARK · PORT SARAYA' };
    let best = null, bd = 1e9;
    for (const az of AVENUES) { const d = Math.abs(z - az); if (d < bd) { bd = d; best = AVE_NAMES[String(az)]; } }
    for (const sx of STREETS) { const d = Math.abs(x - sx); if (d < bd) { bd = d; best = ST_NAMES[String(sx)]; } }
    return { name: best || 'PORT SARAYA', sub: 'PORT SARAYA' };
  }

  // traffic road segments (axis, fixed coord, from, to)
  const roads = [];
  for (const z of AVENUES) roads.push({ axis: 'x', at: z, from: -160, to: 88 });
  roads.push({ axis: 'x', at: 76, from: 88, to: 196 });        // base connector
  for (const x of STREETS) roads.push({ axis: 'z', at: x, from: -108, to: 98 });

  let t = 0;
  function update(dt, focus) {
    t += dt;
    waterTex.offset.set(t * 0.004, t * 0.0025);
    const cone = sock.getObjectByName('sockCone');
    if (cone) cone.rotation.y = Math.sin(t * 0.7) * 0.4;
    for (const m of markers) {
      const p = 1 + Math.sin(t * 3.2) * 0.07;
      m.userData.ring.scale.setScalar(p);
      m.userData.beam.material.opacity = 0.10 + Math.sin(t * 3.2) * 0.035;
    }
    // harbour gulls: slow circle over the bay, two-triangle wing flap;
    // they fade out as the night factor rises (roosting after dark)
    const gullOp = Math.max(0, 1 - api.nightF * 1.7);
    gullM.opacity = gullOp;
    gullGroup.visible = gullOp > 0.02;
    if (gullGroup.visible) {
      const w = (Math.PI * 2) / 55; // one slow circuit in ~55 s
      for (const b of gullFlock) {
        const a = b.a0 + t * w;
        const px = GULL_C.x + Math.cos(a) * b.r, pz = GULL_C.z + Math.sin(a) * b.r;
        const py = GULL_C.y + b.h + Math.sin(t * 0.5 + b.ph) * 1.8;
        b.g.position.set(px, py, pz);
        b.g.lookAt(px - Math.sin(a), py, pz + Math.cos(a)); // along the tangent
        b.g.rotateZ(0.22); // banked into the turn
        const f = Math.sin(t * b.flap + b.ph) * 0.6;
        b.g.userData.wl.rotation.z = -f;
        b.g.userData.wr.rotation.z = f;
      }
    }
    // gate leaves slide apart along local z
    if (gateOpen01 !== gateTarget) {
      gateOpen01 = gateTarget > gateOpen01 ? Math.min(gateTarget, gateOpen01 + dt * 0.7) : Math.max(gateTarget, gateOpen01 - dt * 0.7);
      const l = gateGroup.getObjectByName('gateL'), r = gateGroup.getObjectByName('gateR');
      if (l) l.position.x = -3 - gateOpen01 * 4.6;
      if (r) r.position.x = 3 + gateOpen01 * 4.6;
      if (gateOpen01 > 0.55) {
        const i = colliders.indexOf(gateCollider);
        if (i >= 0) colliders.splice(i, 1);
      } else if (!colliders.includes(gateCollider)) colliders.push(gateCollider);
    }
    // the sun's shadow frustum follows the action in setClock (it needs the
    // same focus); just remember where the action is
    if (focus) lastFocus = focus;
  }

  // ------------------------------------------------------------------
  // Day-night cycle. One lerped phase sample per frame drives everything:
  // sky gradient, fog, hemisphere + sun + fill, the sun/moon ball, stars,
  // street-lamp glow, facade window emissives. Keyframes carry colours and
  // intensities; the light DIRECTION comes from a sun-path orbit (sunrise
  // 05:30 in the east, sunset 18:30 in the west) blended into a fixed
  // moonlight direction by the phase's `night` factor. The 17.7 keyframe
  // is the golden-hour look the game shipped with.
  // ------------------------------------------------------------------
  const PHASES = [
    { h: 0.0, sky: ['#04060f', '#081020', '#0e1a30', '#14243f', '#1a2c4a'], fog: '#0c1424', hSky: '#2c4a73', hGnd: '#0a0d13', hInt: 0.52, sun: '#93b4e8', sunInt: 0.42, fill: '#5a76a8', fillInt: 0.06, night: 1 },
    { h: 4.7, sky: ['#04060f', '#081020', '#0e1a30', '#14243f', '#1a2c4a'], fog: '#0c1424', hSky: '#2c4a73', hGnd: '#0a0d13', hInt: 0.52, sun: '#93b4e8', sunInt: 0.42, fill: '#5a76a8', fillInt: 0.06, night: 1 },
    { h: 5.8, sky: ['#0a1030', '#1c2048', '#3a2c50', '#5c3450', '#7a4458'], fog: '#2c2238', hSky: '#3a4a78', hGnd: '#14101c', hInt: 0.52, sun: '#b0a8d8', sunInt: 0.3, fill: '#6a6aa8', fillInt: 0.08, night: 0.85 },
    { h: 6.8, sky: ['#2c3a6e', '#7a4a6e', '#c65a44', '#f08c46', '#ffd98a'], fog: '#8c5a4a', hSky: '#e8a878', hGnd: '#2c2030', hInt: 0.78, sun: '#ffbe78', sunInt: 1.9, fill: '#ffb088', fillInt: 0.3, night: 0.35 },
    { h: 8.0, sky: ['#2f66b8', '#5f97d4', '#93bde6', '#c8e2f4', '#fdf0d8'], fog: '#b4c6d2', hSky: '#bcd8f2', hGnd: '#4a5a48', hInt: 1.0, sun: '#ffdca8', sunInt: 2.6, fill: '#ffe0b8', fillInt: 0.4, night: 0 },
    { h: 12.5, sky: ['#2a68cc', '#5b9fe4', '#8fc0ee', '#cde9f9', '#f2faff'], fog: '#c2d4e0', hSky: '#c4e2ff', hGnd: '#5c6c54', hInt: 1.12, sun: '#fff2dc', sunInt: 3.1, fill: '#fff0d0', fillInt: 0.45, night: 0 },
    { h: 16.5, sky: ['#2e5fae', '#5f8fce', '#93b4de', '#d3e2ee', '#fdeeda'], fog: '#bfc2bc', hSky: '#bcd2ea', hGnd: '#554e42', hInt: 1.05, sun: '#ffe3b0', sunInt: 2.8, fill: '#ffd9a8', fillInt: 0.45, night: 0 },
    { h: 17.7, sky: ['#2c1e4e', '#7a3060', '#c65a3a', '#f08c46', '#ffc978'], fog: '#cf7040', hSky: '#ffd2a0', hGnd: '#453248', hInt: 1.05, sun: '#ffa257', sunInt: 2.7, fill: '#ffc9a0', fillInt: 0.5, night: 0.12 },
    { h: 18.9, sky: ['#181238', '#3c2050', '#7c3247', '#cf5f3a', '#f49a52'], fog: '#6e3c40', hSky: '#c88a72', hGnd: '#241a2c', hInt: 0.62, sun: '#ff8a4a', sunInt: 1.1, fill: '#e88a68', fillInt: 0.22, night: 0.55 },
    { h: 19.8, sky: ['#060a1c', '#0c1630', '#122441', '#182c4e', '#1e3458'], fog: '#101a2e', hSky: '#33507e', hGnd: '#0c0f16', hInt: 0.52, sun: '#93b4e8', sunInt: 0.42, fill: '#5a76a8', fillInt: 0.06, night: 1 },
    { h: 24.0, sky: ['#04060f', '#081020', '#0e1a30', '#14243f', '#1a2c4a'], fog: '#0c1424', hSky: '#2c4a73', hGnd: '#0a0d13', hInt: 0.52, sun: '#93b4e8', sunInt: 0.42, fill: '#5a76a8', fillInt: 0.06, night: 1 },
  ];
  const _c0 = new THREE.Color(), _c1 = new THREE.Color();
  const lerpCol = (a, b, f, target) => target.copy(_c0.set(a)).lerp(_c1.set(b), f);
  const _dir = new THREE.Vector3(), _sunVec = new THREE.Vector3(), _moonVec = new THREE.Vector3(0.45, 0.8, -0.35).normalize();
  const _stops = [new THREE.Color(), new THREE.Color(), new THREE.Color(), new THREE.Color(), new THREE.Color()];
  const _stopStr = ['#000', '#000', '#000', '#000', '#000'];
  let lastFocus = null, lastSkyH = -1;
  function setClock(minutes) {
    const h = (((minutes / 60) % 24) + 24) % 24;
    let i = 0;
    while (i < PHASES.length - 2 && PHASES[i + 1].h <= h) i++;
    const A = PHASES[i], B = PHASES[i + 1];
    const f = Math.min(1, Math.max(0, (h - A.h) / (B.h - A.h)));
    const night = A.night + (B.night - A.night) * f;
    api.nightF = night;
    // sky + fog + ambient + lights
    if (Math.abs(h - lastSkyH) > 0.004 || lastSkyH < 0) {
      lastSkyH = h;
      for (let s = 0; s < 5; s++) { lerpCol(A.sky[s], B.sky[s], f, _stops[s]); _stopStr[s] = '#' + _stops[s].getHexString(); }
      sky.paint(_stopStr);
    }
    lerpCol(A.fog, B.fog, f, scene.fog.color);
    lerpCol(A.hSky, B.hSky, f, hemi.color);
    lerpCol(A.hGnd, B.hGnd, f, hemi.groundColor);
    hemi.intensity = A.hInt + (B.hInt - A.hInt) * f;
    lerpCol(A.sun, B.sun, f, sun.color);
    sun.intensity = A.sunInt + (B.sunInt - A.sunInt) * f;
    lerpCol(A.fill, B.fill, f, fill.color);
    fill.intensity = A.fillInt + (B.fillInt - A.fillInt) * f;
    // light direction: sun path by day, moonlight by night
    const a = Math.PI * (h - 5.5) / 13;
    _sunVec.set(Math.cos(a), Math.max(0.07, 0.16 + 0.66 * Math.sin(a)), 0.5).normalize();
    _dir.copy(_sunVec).lerp(_moonVec, night).normalize();
    const fx = lastFocus ? lastFocus.x : 0, fz = lastFocus ? lastFocus.z : 76;
    sun.position.set(fx + _dir.x * 240, _dir.y * 240, fz + _dir.z * 240);
    sun.target.position.set(fx, 0, fz);
    // the sun/moon ball + halo ride the same direction
    sunBall.position.set(40 + _dir.x * 430, Math.max(14, _dir.y * 430), 10 + _dir.z * 430);
    sunHalo.position.copy(sunBall.position);
    lerpCol('#ffca7a', '#dfe9ff', night, sunBall.material.color);
    sunBall.scale.setScalar(46 + (18 - 46) * night);
    lerpCol('#ff9a50', '#7a9cc8', night, sunHalo.material.color);
    sunHalo.material.opacity = 0.5 + (0.10 - 0.5) * night;
    // night dressing
    starMat.opacity = night * 0.9;
    lampGlowM.emissiveIntensity = 0.35 + night * 3.05;
    if (lampHaloMat) lampHaloMat.opacity = 0.04 + night * 0.41;
    if (lampPoolMat) lampPoolMat.opacity = 0.15 + night * 0.85;
    const winGlow = night * 0.95;
    for (const m of facadeMats) m.emissiveIntensity = winGlow;
  }

  const api = { colliders, los, places, roads, gate, spawnMarker, locationAt, update, sun, setClock, nightF: 0.12 };
  setClock(17 * 60 + 42);
  return api;
}


