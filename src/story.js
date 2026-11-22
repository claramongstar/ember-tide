// EMBER TIDE's story: five jobs for Raka and the Saraya crew, from a first
// fare across town to stealing the sky itself. A small data-driven step
// engine: each mission is dialogue + a list of steps (go here, take that,
// lose them, steal this), and the engine drives the HUD card, the world
// marker and the minimap while play.js handles everything physical.

import { makeCharacter } from './actors.js';
import { dist2d, clamp } from './util.js';

const D = (who, text, dur) => ({ who, text, dur });

export const MISSIONS = [
  {
    tag: 'MISSION 1 · STORY JOB', title: 'FIRST FARE',
    obj: 'Dario has the <b>Ember GT</b> fuelled at <b>Bengkel Dario</b>. Sinta needs a lift to <b>Pelangi Pier</b> — and the Port Authority is already watching the strand.',
    reward: 250,
    intro: [
      D('mira', 'Raka — auction is in seven days and we are short. Real short. Start earning: Dario has a fare for you.', 5),
      D('dario', 'Ember GT is fuelled and angry, cousin. Try to bring her back with the paint she left with.', 4.6),
      D('sinta', 'I am the fare. Pier, fast, no questions. And take my pistol — the strand is not friendly today.', 4.6),
    ],
    steps: [
      { type: 'goto', at: 'workshop', r: 5, label: 'Meet Dario at Bengkel Dario' },
      { type: 'enterNamed', name: 'EMBER GT', label: 'Get in the Ember GT' },
      { type: 'goto', at: 'pier', r: 7, label: 'Take Sinta to Pelangi Pier', vehicle: true },
    ],
    outro: [D('sinta', 'Not bad, dock boy. The harbour pays better than the docks ever did. Stay by the phone.', 4.6)],
  },
  {
    tag: 'MISSION 2 · STORY JOB', title: 'PAPER TRAIL',
    obj: 'Three of Mira\'s debtors at <b>Pasar Ikan</b> owe the crew. Collect the <b>envelopes</b> from the stalls — quietly, if the word means anything to you.',
    reward: 400,
    intro: [
      D('mira', 'Market day, Raka. Three stalls, three envelopes, all overdue. The fish wives talk — do it smooth.', 4.8),
    ],
    steps: [
      { type: 'collect', points: [[-66, 92.5], [-47, 92.5], [-28, 92.5]], r: 3, label: 'Collect the envelopes at Pasar Ikan' },
      { type: 'loseTail', at: 'hideout', r: 6, label: 'Lose the tail, then reach the hideout yard' },
    ],
    outro: [D('mira', 'All three. You have a talent for other people\'s money, Raka. The boat fund breathes again.', 4.6)],
  },
  {
    tag: 'MISSION 3 · STORY JOB', title: 'HOT CARGO',
    obj: 'A crate came in on the night boat that nobody signed for. Take it from the <b>pier warehouse</b> to a buyer at <b>Hotel Pelangi</b> — and do not let the Authority look inside.',
    reward: 650,
    intro: [
      D('sinta', 'Warehouse, west end of the pier. One crate, no paperwork, very nervous buyer. Drive like you mean it.', 4.8),
    ],
    steps: [
      { type: 'goto', at: 'warehouse', r: 5.5, label: 'Pick up the crate at the pier warehouse' },
      { type: 'goto', at: 'hotel', r: 7, label: 'Deliver to the buyer at Hotel Pelangi', vehicle: true, timer: 150, heat: 2.2 },
    ],
    outro: [D('mira', 'Buyer paid in full and asked no questions. Whatever was in that crate, Raka — we never saw it.', 4.8)],
  },
  {
    tag: 'MISSION 4 · STORY JOB', title: 'DRESS REHEARSAL',
    obj: 'Tomorrow we rob a garrison. Today we case it: walk the <b>Sable Point</b> fence, mark the patrol gaps, and bring the map home to <b>Dario</b>.',
    reward: 800,
    intro: [
      D('dario', 'Three spots on the fence I need eyes on. North ditch, mid gate road, south tower. Walk it like a tourist.', 5),
      D('sinta', 'And Raka — I lifted a service carbine from the armoury stores. Consider it a rehearsal gift.', 4.6),
    ],
    steps: [
      { type: 'collect', points: [[86, -40], [86, 20], [86, 96]], r: 4, label: 'Case the Sable Point fence (3 vantage points)' },
      { type: 'goto', at: 'workshop', r: 5.5, label: 'Bring the fence map back to Dario' },
    ],
    outro: [D('dario', 'Ninety seconds at shift change. That is our door, Raka. Tomorrow we walk through it.', 4.8)],
  },
  {
    tag: 'MISSION 5 · ENDGAME JOB', title: 'STEAL THE SKY',
    obj: 'Auction morning. Through the <b>Sable Point</b> gate in the shift-change chaos, take the <b>Badak</b> or the <b>Kestrel</b>, and reach <b>Pelangi Pier</b> before the gavel falls on the <i>Cahaya Pagi</i>.',
    reward: 5000,
    intro: [
      D('mira', 'This is it. Gate opens for the shift change, Sinta holds it ninety seconds. Tank or jet, Raka — pick your sky.', 5.2),
      D('sinta', 'I will be at the gate in a borrowed uniform. Whatever happens after — do not stop.', 4.6),
    ],
    steps: [
      { type: 'goto', at: 'gate', r: 8, label: 'Reach the Sable Point gate' },
      { type: 'steal', label: 'Take the Badak tank or the Kestrel jet' },
      { type: 'escape', at: 'boat', r: 11, label: 'Escape to the Cahaya Pagi at Pelangi Pier' },
    ],
    outro: [
      D('mira', 'The gavel never fell, Raka. The Cahaya Pagi is yours — the harbour is yours. Port Saraya, forever.', 5.4),
      D('dario', 'You stole the sky and brought it home for dinner. Your father would have paid money to see that.', 5),
    ],
  },
];

export class Story {
  constructor(sim, world, hud, events) {
    this.sim = sim;
    this.world = world;
    this.hud = hud;
    this.events = events;
    this.idx = 0;
    this.stepIdx = 0;
    this.done = false;
    this.active = false;
    this.marker = null;
    this.collectLeft = [];
    this.timer = null;
    this.crew = {};
    this.ammoCd = 0;
    this.trespassCd = 0;
    this.gateOpened = false;
  }

  async initCrew() {
    const P = this.world.places;
    const defs = [
      ['mira', 'woman', 1.7, -43.5, 90.5, Math.PI],
      ['dario', 'worker', 1.76, 4.6, 19.5, 0.4],
      ['sinta', 'casual', 1.72, 11.5, 20.5, -0.7],
    ];
    for (const [id, model, h, x, z, face] of defs) {
      const ch = await makeCharacter(model, h);
      ch.group.position.set(x, 0, z);
      ch.group.rotation.y = face;
      this.sim.scene.add(ch.group);
      this.crew[id] = ch;
    }
    void P;
    this.hud.setCrewStatus('mira', 'Pasar Ikan');
    this.hud.setCrewStatus('dario', 'Workshop');
    this.hud.setCrewStatus('sinta', 'With Dario');
  }
  crewBlips() {
    return Object.values(this.crew).map((ch) => ({ x: ch.group.position.x, z: ch.group.position.z }));
  }
  animateCrew(dt) {
    for (const ch of Object.values(this.crew)) ch.update(dt);
  }

  start(idx, { silent = false } = {}) {
    this.idx = idx;
    this.stepIdx = 0;
    this.active = true;
    const m = MISSIONS[idx];
    if (!m) { this.finishStory(); return; }
    if (!silent) for (const d of m.intro) this.hud.dialogue(d.who, d.text, d.dur);
    this._enterStep();
  }
  _enterStep() {
    const m = MISSIONS[this.idx];
    const step = m.steps[this.stepIdx];
    this.timer = step.timer || null;
    if (step.type === 'collect') this.collectLeft = step.points.map((p) => ({ x: p[0], z: p[1], got: false }));
    if (step.heat) this.sim.wanted = Math.max(this.sim.wanted, step.heat);
    this._refreshCard();
    this._moveMarker();
  }
  _stepTarget() {
    const step = MISSIONS[this.idx].steps[this.stepIdx];
    if (step.type === 'collect') {
      const pp = this.sim.playerPos();
      let best = null, bd = 1e9;
      for (const c of this.collectLeft) {
        if (c.got) continue;
        const d = dist2d(pp.x, pp.z, c.x, c.z);
        if (d < bd) { bd = d; best = c; }
      }
      return best;
    }
    if (step.at) { const p = this.world.places[step.at]; return { x: p.x, z: p.z }; }
    if (step.type === 'enterNamed') {
      const v = this.sim.vehicles.find((k) => k.name === step.name);
      return v ? { x: v.pos.x, z: v.pos.z } : null;
    }
    if (step.type === 'steal') return { x: this.world.places.apron.x, z: this.world.places.apron.z };
    return null;
  }
  _moveMarker() {
    const t = this._stepTarget();
    if (!this.marker) this.marker = this.world.spawnMarker(0, 0, 0xffb347);
    if (t) { this.marker.visible = true; this.marker.position.set(t.x, 0, t.z); }
    else this.marker.visible = false;
  }
  _refreshCard() {
    const m = MISSIONS[this.idx];
    const step = m.steps[this.stepIdx];
    const total = MISSIONS.length;
    this.hud.setMission({
      tag: m.tag,
      title: m.title,
      obj: m.obj,
      next: `▸ NEXT — ${step.label}`,
      prog: (this.idx + this.stepIdx / m.steps.length) / total,
      sub: `JOB ${this.idx + 1} OF ${total} · STEP ${this.stepIdx + 1} / ${m.steps.length}`,
    });
  }
  _completeMission() {
    const m = MISSIONS[this.idx];
    const p = this.sim.player;
    p.money += m.reward;
    this.hud.banner('JOB DONE', `${m.title} · +$${m.reward.toLocaleString('en-US')}`);
    for (const d of m.outro) this.hud.dialogue(d.who, d.text, d.dur);
    if (this.idx === 0) { // Sinta's pistol becomes Raka's
      p.ammo.pistol = Math.max(p.ammo.pistol, 60);
      if (p.weapon === 'fists') p.weapon = 'pistol';
      this.hud.toast('Sinta\'s 9MM is yours now — CLICK or F to shoot');
      this.hud.setCrewStatus('sinta', 'Pelangi Pier');
      this._moveCrew('sinta', -84, 110, Math.PI);
    }
    if (this.idx === 3) { // the armoury carbine + a vest
      p.ammo.carbine = Math.max(p.ammo.carbine, 120);
      p.armour = Math.max(p.armour, 60);
      this.hud.toast('SERVICE CARBINE acquired — press 2 · armour fitted');
    }
    this.events.emit('save', {});
    this.idx++;
    if (this.idx >= MISSIONS.length) { this.finishStory(); return; }
    this.start(this.idx);
  }
  finishStory() {
    this.done = true;
    this.active = false;
    if (this.marker) this.marker.visible = false;
    this.world.gate.setOpen(false);
    this.sim.clearWanted();
    this.hud.banner('EMBER TIDE', 'THE CAHAYA PAGI SAILS · FREE ROAM');
    this.hud.setMission({
      tag: 'FREE ROAM', title: 'PORT SARAYA',
      obj: 'The boat is yours, the harbour is yours. Run fares in your head, joyride the strand, or go back to Sable Point and steal the sky again.',
      next: '', prog: 1, sub: 'STORY COMPLETE · THE CITY IS OPEN',
    });
    this.hud.setCrewStatus('mira', 'On the pier', '#58d977');
    this.hud.setCrewStatus('dario', 'Workshop', '#58d977');
    this.hud.setCrewStatus('sinta', 'On the pier', '#58d977');
    this.events.emit('save', {});
  }
  _moveCrew(id, x, z, face) {
    const ch = this.crew[id];
    if (!ch) return;
    ch.group.position.set(x, 0, z);
    ch.group.rotation.y = face;
  }

  restartMission() {
    if (this.done) return;
    this.start(this.idx, { silent: true });
    this.hud.toast('Job restarted from the top');
  }

  // ------------------------------------------------------------ per-frame --
  update(dt) {
    for (const ch of Object.values(this.crew)) ch.update(dt);
    this.ammoCd -= dt;
    this.trespassCd -= dt;
    const sim = this.sim, p = sim.player;
    if (!p) return;
    const pp = sim.playerPos();

    // Dario tops up shells and patches the vest at the workshop kerb
    const w = this.world.places.workshop;
    if (this.ammoCd <= 0 && dist2d(pp.x, pp.z, w.x, w.z) < 7 && !p.vehicle) {
      let topped = false;
      if (p.ammo.pistol > 0 && p.ammo.pistol < 60) { p.ammo.pistol = 60; topped = true; }
      if (p.ammo.carbine > 0 && p.ammo.carbine < 120) { p.ammo.carbine = 120; topped = true; }
      if (topped) { this.hud.toast('Dario topped up your ammo'); this.ammoCd = 20; }
    }
    // wandering into Sable Point early is a very bad idea
    if (!this.done && this.idx < 4 && pp.x > 94 && this.trespassCd <= 0) {
      sim.crime(1.4, pp.x, pp.z);
      this.hud.toast('RESTRICTED — Sable Point security does not ask twice');
      this.trespassCd = 5;
    }
    if (!this.active || this.done) return;
    const m = MISSIONS[this.idx];
    const step = m.steps[this.stepIdx];
    if (!step) return;

    // mission 5: Sinta holds the gate — it opens as Raka approaches
    if (this.idx === 4 && this.stepIdx === 0) {
      if (!this.gateOpened) this._moveCrew('sinta', 88.5, 69, Math.PI / 2);
      const dGate = dist2d(pp.x, pp.z, this.world.places.gate.x, this.world.places.gate.z);
      if (dGate < 30 && !this.gateOpened) {
        this.gateOpened = true;
        this.world.gate.setOpen(true);
        this.hud.setCrewStatus('sinta', 'Holding the gate', '#ff5348');
        this.hud.dialogue('sinta', 'Gate is ours for ninety seconds. GO, Raka — pick your sky!', 4.4);
      }
    }
    if (this.timer !== null) {
      this.timer -= dt;
      if (this.timer <= 0) {
        this.hud.toast('Too slow — the buyer walked. Back to the last step');
        this._enterStep();
        return;
      }
    }

    let complete = false;
    if (step.type === 'goto' || step.type === 'escape') {
      const t = this._stepTarget();
      const inVehicleOk = !step.vehicle || !!p.vehicle;
      if (t && inVehicleOk && dist2d(pp.x, pp.z, t.x, t.z) < step.r) complete = true;
      if (step.type === 'escape' && complete) {
        sim.clearWanted();
        this.world.gate.setOpen(false);
      }
    } else if (step.type === 'collect') {
      let changed = false;
      for (const c of this.collectLeft) {
        if (!c.got && dist2d(pp.x, pp.z, c.x, c.z) < step.r) {
          c.got = true; changed = true;
          p.money += 25;
          this.hud.toast(`Envelope collected · ${this.collectLeft.filter((k) => k.got).length} / ${this.collectLeft.length}`);
          if (this.idx === 1 && this.collectLeft.every((k) => k.got)) {
            sim.wanted = Math.max(sim.wanted, 2.15);
            this.hud.dialogue('sinta', 'Raka — a patrol just clocked you at the market. Lose them, then the hideout yard!', 4.6);
          }
        }
      }
      if (changed) this._moveMarker();
      if (this.collectLeft.every((k) => k.got)) complete = true;
    } else if (step.type === 'loseTail') {
      const t = this._stepTarget();
      if (t && dist2d(pp.x, pp.z, t.x, t.z) < step.r && sim.stars === 0) complete = true;
    } else if (step.type === 'enterNamed') {
      if (p.vehicle && p.vehicle.name === step.name) complete = true;
      else this._moveMarker();
    } else if (step.type === 'steal') {
      if (p.vehicle && (p.vehicle === sim.poolTank || p.vehicle === sim.parkedJet)) {
        complete = true;
        sim.wanted = Math.max(sim.wanted, 5.2);
        this.hud.dialogue('mira', 'That is the sound of a garrison waking up, Raka. Pier. NOW.', 4.4);
        this.hud.setCrewStatus('dario', 'Listening in', '#ffb347');
      }
    }
    // live distance readout on the mission card
    const t = this._stepTarget();
    if (t && this.active) {
      const d = dist2d(pp.x, pp.z, t.x, t.z);
      const timerTxt = this.timer !== null ? ` · ${Math.max(0, Math.ceil(this.timer))}S` : '';
      this.hud.setMission({ sub: `JOB ${this.idx + 1} OF ${MISSIONS.length} · ${Math.round(d)} M${timerTxt}` });
    }
    if (complete) {
      this.stepIdx++;
      if (this.stepIdx >= m.steps.length) this._completeMission();
      else { this._enterStep(); this.hud.toast('Checkpoint reached'); }
    }
  }

  serialize() { return { idx: this.idx, done: this.done }; }
  restore(data) {
    if (!data) return;
    this.done = !!data.done;
    this.idx = clamp(data.idx || 0, 0, MISSIONS.length);
  }
}
