// The EMBER TIDE HUD: the dense, panelled interface the v3 preview proved
// out — mission card, location strap, money/clock/wanted, weapon and crew
// cards, minimap, health/armour, dialogue box, speedometer, banners and
// toasts. Pure DOM/canvas: the simulation feeds it state, it never reaches
// back into the game.

import { clockText, moneyText, distText, clamp } from './util.js';
import { AVENUES, STREETS, BASE, PIER_Z } from './world.js';

const $ = (id) => document.getElementById(id);

export const CREW = [
  { id: 'mira', name: 'MIRA', role: 'FIXER', color: '#ffb347', letter: 'M' },
  { id: 'dario', name: 'DARIO', role: 'MECHANIC', color: '#17c3c3', letter: 'D' },
  { id: 'sinta', name: 'SINTA', role: 'LOOKOUT', color: '#ff8a7a', letter: 'S' },
];
const HEAT_TEXT = {
  1: 'PORT AUTHORITY — SEARCHING',
  2: 'PORT AUTHORITY — PURSUIT',
  3: 'PORT AUTHORITY — ARMED RESPONSE',
  4: 'BASE SECURITY — SABLE POINT ALERTED',
  5: 'MILITARY RESPONSE — SABLE POINT DEPLOYED',
};
const WEAPONS = {
  fists: { name: 'FISTS', lab: 'UNARMED' },
  pistol: { name: '9MM PISTOL', lab: "SINTA'S — BORROWED" },
  carbine: { name: 'SERVICE CARBINE', lab: 'SABLE POINT ARMOURY' },
};

export class Hud {
  constructor() {
    this.el = {
      hud: $('hud'), missionTag: $('missionTag'), missionTitle: $('missionTitle'),
      missionObj: $('missionObj'), missionNext: $('missionNext'), missionProg: $('missionProg'),
      missionSub: $('missionSub'), locName: $('locName'), locSub: $('locSub'),
      money: $('money'), clock: $('clock'), wanted: $('wanted'), heat: $('heat'),
      wname: $('wname'), wammo: $('wammo'), wlab: $('wlab'), crew: $('crew'),
      hpFill: $('hpFill'), hpVal: $('hpVal'), arFill: $('arFill'), arVal: $('arVal'),
      dialog: $('dialog'), dialogAvatar: $('dialogAvatar'), dialogName: $('dialogName'), dialogText: $('dialogText'),
      speedo: $('speedo'), speedVal: $('speedVal'), speedCar: $('speedCar'), speedBar: $('speedBar'), speedSub: $('speedSub'),
      banner: $('banner'), bannerBig: $('bannerBig'), bannerSmall: $('bannerSmall'),
      toast: $('toast'), cross: $('cross'), minimap: $('minimap'), prompt: $('prompt'),
    };
    this.crewStatus = new Map(CREW.map((c) => [c.id, { text: '—', dot: '#58d977' }]));
    this._buildCrew();
    this.dialogQueue = [];
    this.dialogT = 0;
    this.bannerT = 0;
    this.toastT = 0;
    this.locName = '';
    this.promptShown = undefined;        // last prompt text rendered (undefined = never)
    this.mapAcc = 0;                     // minimap redraw throttle accumulator
    this.mapCtx = this.el.minimap.getContext('2d');
    this._buildMapBase();
  }
  _buildCrew() {
    this.el.crew.innerHTML = CREW.map((c) => `
      <div class="mate">
        <div class="avatar" style="background:${c.color}">${c.letter}</div>
        <div class="who"><div class="nm">${c.name}</div><div class="rl">${c.role}</div></div>
        <div class="st" id="crew-${c.id}"><span class="dot" style="background:#58d977"></span>—</div>
      </div>`).join('');
  }
  setCrewStatus(id, text, dot = '#58d977') {
    const el = document.getElementById(`crew-${id}`);
    if (el) el.innerHTML = `<span class="dot" style="background:${dot}"></span>${text}`;
  }
  show() { this.el.hud.classList.remove('hidden'); }
  hide() { this.el.hud.classList.add('hidden'); }

  setMission({ tag, title, obj, next, prog, sub }) {
    if (tag !== undefined) this.el.missionTag.textContent = tag;
    if (title !== undefined) this.el.missionTitle.textContent = title;
    if (obj !== undefined) this.el.missionObj.innerHTML = obj;
    if (next !== undefined) this.el.missionNext.textContent = next;
    if (prog !== undefined) this.el.missionProg.style.width = `${Math.round(clamp(prog, 0, 1) * 100)}%`;
    if (sub !== undefined) this.el.missionSub.textContent = sub;
  }
  setLocation(name, sub) {
    if (name === this.locName) return;
    this.locName = name;
    this.el.locName.textContent = name;
    this.el.locSub.textContent = sub;
  }
  dialogue(who, text, dur = 4.2) {
    const c = CREW.find((k) => k.id === who) || CREW[0];
    this.dialogQueue.push({ c, text, dur });
  }
  /** Interaction prompt pill ("E — ENTER CAR"). Driven by the sim's
   *  proximity test every frame; only touches the DOM when it changes. */
  setPrompt(text) {
    if (text === this.promptShown) return;
    this.promptShown = text;
    if (text) {
      this.el.prompt.textContent = text;
      this.el.prompt.classList.remove('hidden');
    } else this.el.prompt.classList.add('hidden');
  }
  toast(text, dur = 3.2) {
    this.el.toast.textContent = text;
    this.el.toast.classList.remove('hidden');
    this.toastT = dur;
  }
  banner(big, small = '', dur = 3.4) {
    this.el.bannerBig.textContent = big;
    this.el.bannerSmall.textContent = small;
    this.el.banner.classList.remove('hidden');
    this.bannerT = dur;
  }

  // ------------------------------------------------------------ minimap --
  _mapScale() { return { s: 356 / 452, ox: 170, oz: 122 }; }
  _mx(x) { const { s, ox } = this._mapScale(); return (x + ox) * s; }
  _mz(z) { const { s, oz } = this._mapScale(); return (z + oz) * s - 26; }
  _buildMapBase() {
    const c = document.createElement('canvas');
    c.width = c.height = 356;
    const g = c.getContext('2d');
    g.fillStyle = '#274b3a'; g.fillRect(0, 0, 356, 356);                    // land
    g.fillStyle = '#14424f'; g.fillRect(0, this._mz(PIER_Z), 356, 356 - this._mz(PIER_Z)); // sea
    g.fillStyle = '#3d4a35'; g.fillRect(this._mx(BASE.minX), this._mz(BASE.minZ), (BASE.maxX - BASE.minX) * 0.787, (BASE.maxZ - BASE.minZ) * 0.787); // base
    g.strokeStyle = '#585058'; g.lineWidth = 5;
    for (const z of AVENUES) { g.beginPath(); g.moveTo(this._mx(-164), this._mz(z)); g.lineTo(this._mx(196), this._mz(z)); g.stroke(); }
    for (const x of STREETS) { g.beginPath(); g.moveTo(this._mx(x), this._mz(-114)); g.lineTo(this._mx(x), this._mz(104)); g.stroke(); }
    g.strokeStyle = '#6a7076'; g.lineWidth = 3;                              // runway
    g.beginPath(); g.moveTo(this._mx(232), this._mz(-100)); g.lineTo(this._mx(232), this._mz(92)); g.stroke();
    g.fillStyle = '#c9862b'; g.fillRect(this._mx(-112), this._mz(108), 26, 7); // pier warehouse
    this.mapBase = c;
  }
  drawMap(state) {
    const g = this.mapCtx;
    g.clearRect(0, 0, 356, 356);
    g.drawImage(this.mapBase, 0, 0);
    const dot = (x, z, color, r = 4) => {
      g.fillStyle = color;
      g.beginPath(); g.arc(this._mx(x), this._mz(z), r, 0, 6.29); g.fill();
    };
    if (state.marker) {
      const pulse = 5 + Math.sin(state.t * 5) * 1.6;
      dot(state.marker.x, state.marker.z, '#ffb347', pulse);
      g.strokeStyle = '#ffb347'; g.lineWidth = 2;
      g.beginPath(); g.arc(this._mx(state.marker.x), this._mz(state.marker.z), pulse + 5, 0, 6.29); g.stroke();
    }
    for (const v of state.vehicles) {
      if (v.driver === 'police') dot(v.pos.x, v.pos.z, '#5aa2ff', 3.6);
      else if (v.kind === 'tank' && v.driver === 'column') dot(v.pos.x, v.pos.z, '#ff5348', 4.4);
    }
    for (const c of state.crewBlips || []) dot(c.x, c.z, '#17c3c3', 3.2);
    // player arrow
    const px = this._mx(state.player.x), pz = this._mz(state.player.z);
    g.save();
    g.translate(px, pz);
    g.rotate(state.player.heading);
    g.fillStyle = '#ffffff';
    g.beginPath(); g.moveTo(0, -8); g.lineTo(5.4, 6); g.lineTo(0, 3); g.lineTo(-5.4, 6); g.closePath(); g.fill();
    g.restore();
  }

  // ------------------------------------------------------------ per-frame --
  update(dt, s) {
    // s: { money, clockMin, stars, health, armour, weapon, ammo, vehicle, speedKmh, player, vehicles, marker, crewBlips, t }
    this.el.money.textContent = moneyText(s.money);
    this.el.clock.textContent = clockText(s.clockMin);
    let stars = '';
    for (let i = 1; i <= 5; i++) stars += i <= s.stars ? '★' : `<span class="off">★</span>`;
    this.el.wanted.innerHTML = stars;
    if (s.stars > 0) {
      this.el.heat.style.display = 'inline-block';
      this.el.heat.textContent = HEAT_TEXT[s.stars] || '';
    } else this.el.heat.style.display = 'none';
    this.el.hpFill.style.width = `${clamp(s.health, 0, 100)}%`;
    this.el.hpVal.textContent = Math.ceil(Math.max(0, s.health));
    this.el.arFill.style.width = `${clamp(s.armour, 0, 100)}%`;
    this.el.arVal.textContent = Math.ceil(Math.max(0, s.armour));
    const w = WEAPONS[s.weapon] || WEAPONS.fists;
    this.el.wname.textContent = w.name;
    this.el.wlab.textContent = w.lab;
    this.el.wammo.innerHTML = s.weapon === 'fists' ? '' : `${s.ammo} <span>/ ∞</span>`;
    // dialogue queue
    if (this.dialogT > 0) {
      this.dialogT -= dt;
      if (this.dialogT <= 0) this.el.dialog.classList.add('hidden');
    } else if (this.dialogQueue.length) {
      const d = this.dialogQueue.shift();
      this.el.dialogAvatar.textContent = d.c.letter;
      this.el.dialogAvatar.style.background = d.c.color;
      this.el.dialogName.textContent = `${d.c.name} — ${d.c.role}`;
      this.el.dialogText.textContent = d.text;
      this.el.dialog.classList.remove('hidden');
      this.dialogT = d.dur;
    }
    if (this.bannerT > 0) { this.bannerT -= dt; if (this.bannerT <= 0) this.el.banner.classList.add('hidden'); }
    if (this.toastT > 0) { this.toastT -= dt; if (this.toastT <= 0) this.el.toast.classList.add('hidden'); }
    // speedometer + crosshair
    if (s.vehicle) {
      this.el.speedo.classList.remove('hidden');
      this.el.speedVal.textContent = Math.round(Math.abs(s.speedKmh));
      this.el.speedCar.textContent = s.vehicle.name;
      this.el.speedBar.style.width = `${clamp(Math.abs(s.speedKmh) / 1.4, 0, 100)}%`;
      this.el.speedSub.textContent = s.vehicle.kind === 'tank' ? 'ARMOUR 100%' : s.vehicle.kind === 'jet' ? 'KESTREL FJ-9 · SABLE POINT' : `PAINTWORK ${Math.max(0, Math.round(s.vehicle.health))}%`;
    } else this.el.speedo.classList.add('hidden');
    if (s.weapon !== 'fists' && !s.vehicle) this.el.cross.classList.remove('hidden');
    else if (s.vehicle && s.vehicle.kind === 'tank') this.el.cross.classList.remove('hidden');
    else this.el.cross.classList.add('hidden');
    this.setPrompt(s.prompt || null);
    // the minimap is a 356² canvas redraw: 20 Hz is indistinguishable from
    // 60 Hz for a map, and the saved fill helps weak integrated GPUs
    this.mapAcc += dt;
    if (this.mapAcc >= 0.05) { this.mapAcc = 0; this.drawMap(s); }
    void distText;
  }
}
