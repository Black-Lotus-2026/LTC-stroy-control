'use strict';
/* Строй-контроль · прототип «Сверка».
   План — золотой чертёж, факт — белые чернила. Всё, что движется, движется пружинами:
   анимация стартует с текущего значения, наследует скорость жеста и может быть перехвачена. */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const RM = matchMedia('(prefers-reduced-motion: reduce)');
const MOBILE = matchMedia('(max-width: 860px)');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const H = (h, m = 0, s = 0) => h * 3600 + m * 60 + s;
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (t) => `${pad(Math.floor(t / 3600) % 24)}:${pad(Math.floor(t / 60) % 60)}`;
const hhmmss = (t) => `${hhmm(t)}:${pad(Math.floor(t) % 60)}`;
function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
function durShort(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec} с`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} ч ${r} мин` : `${h} ч`;
}
function durWords(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec} ${plural(sec, 'секунду', 'секунды', 'секунд')}`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} ${plural(m, 'минуту', 'минуты', 'минут')}`;
  const h = Math.floor(m / 60), r = m % 60;
  return `${h} ${plural(h, 'час', 'часа', 'часов')}` + (r ? ` ${r} ${plural(r, 'минуту', 'минуты', 'минут')}` : '');
}
const MONTHS_G = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_S = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const D = (s) => new Date(s + 'T00:00:00');
const dayMs = 864e5;
const fmtDay = (d) => `${d.getDate()} ${MONTHS_G[d.getMonth()]}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ── Springs ─────────────────────────────────────────────
   Apple's two designer parameters: damping ratio and response (s).
   k = (2π/response)², c = 4π·ζ/response, mass = 1. */
const Loop = {
  set: new Set(), raf: 0, last: 0,
  add(s) { this.set.add(s); if (!this.raf) { this.last = performance.now(); this.raf = requestAnimationFrame(this.tick); } },
  tick: (now) => {
    const dt = Math.min(0.05, (now - Loop.last) / 1000); Loop.last = now;
    for (const s of [...Loop.set]) s._step(dt);
    Loop.raf = Loop.set.size ? requestAnimationFrame(Loop.tick) : 0;
  },
};
class Spring {
  constructor(value = 0, { response = 0.35, damping = 1, onUpdate, onRest, rest = 0.01 } = {}) {
    Object.assign(this, { x: value, v: 0, target: value, response, damping, onUpdate, onRest, rest });
  }
  to(target, opts = {}) {
    if (opts.response) this.response = opts.response;
    if (opts.damping) this.damping = opts.damping;
    if (opts.velocity !== undefined) this.v = opts.velocity;
    if (opts.onRest !== undefined) this.onRest = opts.onRest;
    this.target = target;
    if (RM.matches || opts.instant) { this.set(target); this.onRest?.(); return this; }
    Loop.add(this);
    return this;
  }
  set(value) { this.x = value; this.target = value; this.v = 0; Loop.set.delete(this); this.onUpdate?.(value); return this; }
  stop() { Loop.set.delete(this); this.v = 0; return this; }
  get moving() { return Loop.set.has(this); }
  _step(dt) {
    const k = (2 * Math.PI / this.response) ** 2, c = 4 * Math.PI * this.damping / this.response;
    const n = Math.max(1, Math.ceil(dt / (1 / 240))), h = dt / n;
    for (let i = 0; i < n; i++) { const a = -k * (this.x - this.target) - c * this.v; this.v += a * h; this.x += this.v * h; }
    if (Math.abs(this.v) < this.rest * 8 && Math.abs(this.x - this.target) < this.rest) {
      this.x = this.target; this.v = 0; Loop.set.delete(this); this.onUpdate?.(this.x); const cb = this.onRest; cb?.(); return;
    }
    this.onUpdate?.(this.x);
  }
}
// Watchdog: if frames stop (hidden tab, thumbnail capture), settle every spring at its target
// so the page is never left frozen mid-transition.
setInterval(() => {
  if (!Loop.set.size || performance.now() - Loop.last < 600) return;
  for (const s of [...Loop.set]) { s.x = s.target; s.v = 0; Loop.set.delete(s); s.onUpdate?.(s.x); s.onRest?.(); }
  cancelAnimationFrame(Loop.raf); Loop.raf = 0;
}, 400);
/* Momentum projection, exactly as in Designing Fluid Interfaces sample code */
const project = (v, d = 0.998) => (v / 1000) * d / (1 - d);
const rubber = (over, dim, c = 0.55) => (over * dim * c) / (dim + c * Math.abs(over));
class Velocity {
  constructor() { this.s = []; }
  add(x, y) { const t = performance.now(); this.s.push({ x, y, t }); while (this.s.length && t - this.s[0].t > 100) this.s.shift(); }
  get() {
    if (this.s.length < 2) return { x: 0, y: 0 };
    const a = this.s[0], b = this.s[this.s.length - 1], dt = Math.max(1, b.t - a.t) / 1000;
    return { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt };
  }
}

/* ── Machinery line-art (viewBox 64×40) ───────────────── */
const SIL = {
  excavator: '<path d="M7 31.5h26a3.5 3.5 0 0 1 0 7H7a3.5 3.5 0 0 1 0-7z"/><path d="M5 31.5V24h21l3 7.5"/><path d="M5 27.5h4"/><path d="M15 24V14h8l3 10"/><path d="M28 22L41 6.5l3.5.5L51 17.5"/><path d="M49 16.5l6 3.5-1.6 6-7-1.6z"/>',
  bulldozer: '<path d="M15 31.5h28a3.5 3.5 0 0 1 0 7H15a3.5 3.5 0 0 1 0-7z"/><path d="M17 31.5V22h25v9.5"/><path d="M24 22V12h11l2 10"/><path d="M17 26h-6"/><path d="M11 17.5c-2.6 6.5-2.6 14 0 21H6.5c-2-7-2-14 0-21z"/><path d="M42 26l6 2.5v3"/>',
  dump_truck: '<circle cx="15" cy="34" r="4"/><circle cx="41" cy="34" r="4"/><circle cx="51" cy="34" r="4"/><path d="M5 30h6M19 30h18M55 30h4"/><path d="M47 30V17h7l4.5 6.5V30"/><path d="M50 17v6.5h8.5"/><path d="M6 28l2.4-14H45v14z"/><path d="M19 15.5v11M31 15.5v11"/>',
  truck_crane: '<circle cx="12" cy="34.5" r="3.5"/><circle cx="21" cy="34.5" r="3.5"/><circle cx="43" cy="34.5" r="3.5"/><circle cx="52" cy="34.5" r="3.5"/><path d="M5 31h54"/><path d="M47 31v-10h7l4.5 5V31"/><path d="M13 31v-5h14v5"/><path d="M17 26L45.5 5l2.5 2.5L21 28"/><path d="M47 6.5V18"/><path d="M45.3 18h3.4M47 18v2.3a1.6 1.6 0 1 1-3.2 0"/>',
  tower_crane: '<path d="M24 39V7.5M30 39V7.5"/><path d="M24 35.5l6-4-6-4 6-4-6-4 6-4-6-4 6-4"/><path d="M20 39h14"/><path d="M24 7.5L27 1l3 6.5"/><path d="M4 7.5h58M30 10.5h28l4-3M4 10.5h20"/><path d="M6.5 10.5v4.5h9v-4.5"/><path d="M27 1L62 7.5M27 1L4 7.5"/><path d="M49 10.5v12"/><path d="M47.3 22.5h3.4M49 22.5v2.3a1.6 1.6 0 1 1-3.2 0"/>',
  concrete_mixer: '<circle cx="14" cy="34" r="4"/><circle cx="40" cy="34" r="4"/><circle cx="50" cy="34" r="4"/><path d="M5 30h5M18 30h18M54 30h5"/><path d="M46 30V18h7l5 6v6"/><path d="M49 18v6h9"/><path d="M8 26.5C6.5 18 13 12.5 26 12.5c9 0 15.5 3 17.5 8.5l-2 6c-8 2.6-25 2.8-33.5-.5z"/><path d="M17 13.7l4 13.8M28.5 12.8l3 15"/>',
  loader: '<circle cx="20" cy="32" r="6"/><circle cx="46" cy="32" r="6"/><path d="M14 26h40v-6H44V9H33l-2 11h-8"/><path d="M36 9v7h8"/><path d="M23 21.5L12 26"/><path d="M3.5 19.5l9-1 2 10.5-9 2c-2-4-2.4-7.5-2-11.5z"/><path d="M54 20l4.5 2v6H54"/>',
  roller: '<circle cx="14" cy="30" r="8"/><path d="M5 20.5h18v5"/><path d="M23 26V18h29v8h-2"/><path d="M34 18V8h12l2 10"/><path d="M37 8v6.5h10"/><circle cx="47" cy="32" r="6"/>',
  grader: '<circle cx="8" cy="34" r="3.8"/><circle cx="44" cy="34" r="3.8"/><circle cx="54" cy="34" r="3.8"/><path d="M8 30.2V24h30"/><path d="M38 30V22h22v8"/><path d="M42 22V11h11l2 11"/><path d="M45 11v6h9"/><path d="M17 34.5l17-3.5"/><path d="M26 24v7"/>',
  backhoe_loader: '<circle cx="22" cy="31" r="7"/><circle cx="48" cy="33" r="5"/><path d="M14 26h40v-6H38V9H28l-2 11h-7"/><path d="M31 9v6.5h8"/><path d="M54 22l6-1.2 2 9.2-7 1"/><path d="M15 23L8 9 3 17.5"/><path d="M3 17.5l4.2 4-2 4-4-3z"/><path d="M14 26v6h3.5"/>',
  concrete_pump: '<circle cx="12" cy="34.5" r="3.5"/><circle cx="21" cy="34.5" r="3.5"/><circle cx="42" cy="34.5" r="3.5"/><circle cx="51" cy="34.5" r="3.5"/><path d="M5 31h54"/><path d="M46 31V20h7l5 5v6"/><path d="M10 31v-4h31v4"/><path d="M14 27L42 18.5 14 11.5 38.5 5"/><path d="M38.5 5l3 3.5"/><circle cx="14" cy="27" r="1.6"/>',
};
const sil = (code, cls = 'ink', attrs = '') => `<svg class="mach ${cls}" viewBox="0 0 64 40" aria-hidden="true" ${attrs}>${SIL[code] || ''}</svg>`;

const M = {
  excavator: { name: 'Экскаватор', lower: 'экскаватор' },
  bulldozer: { name: 'Бульдозер', lower: 'бульдозер' },
  dump_truck: { name: 'Самосвал', lower: 'самосвал', plural: 'самосвалов' },
  truck_crane: { name: 'Автокран', lower: 'автокран' },
  tower_crane: { name: 'Башенный кран', lower: 'башенный кран' },
  concrete_mixer: { name: 'Автобетоносмеситель', lower: 'автобетоносмеситель' },
  loader: { name: 'Погрузчик', lower: 'погрузчик' },
  roller: { name: 'Каток', lower: 'каток' },
  grader: { name: 'Автогрейдер', lower: 'автогрейдер' },
  backhoe_loader: { name: 'Экскаватор-погрузчик', lower: 'экскаватор-погрузчик' },
  concrete_pump: { name: 'Бетононасос', lower: 'бетононасос' },
};
const CODES = Object.keys(M);
const LV = {
  req: { label: 'Обязательна', group: 'Обязательная' },
  rec: { label: 'Рекомендуется', group: 'Рекомендуемая' },
  ok: { label: 'Допустима', group: 'Допустимая' },
  no: { label: 'Не характерна', group: 'Не характерная' },
  skip: { label: 'Не учитывается', group: 'Не учитывается' },
};
const LV_ORDER = ['req', 'rec', 'ok', 'no', 'skip'];
const levelFromP = (p) => (p >= 0.8 ? 'req' : p >= 0.5 ? 'rec' : p >= 0.2 ? 'ok' : 'no');

/* ── Plan (the project's demo plan) ───────────────────── */
const PLAN = [
  { n: 1, name: 'Подготовка территории и площадки', start: '2026-04-18', end: '2026-05-01' },
  { n: 2, name: 'Выемка грунта котлована', start: '2026-05-02', end: '2026-05-22', catalog: 'Жильё → Выемка грунта котлована', src: 'https://docs.cntd.ru/document/435746879', srcLabel: 'docs.cntd.ru' },
  { n: 3, name: 'Бетонная подготовка и фундаментная плита', start: '2026-05-23', end: '2026-06-16', catalog: 'Жильё → Устройство фундаментной плиты', src: 'https://files.stroyinf.ru/Data1/44/44831/index.htm', srcLabel: 'files.stroyinf.ru' },
  { n: 4, name: 'Монолитные конструкции подземной части', start: '2026-06-17', end: '2026-07-16' },
  { n: 5, name: 'Монолитный каркас 1–9 этажей', start: '2026-07-17', end: '2026-09-14' },
  { n: 6, name: 'Кладка наружных стен и перегородок', start: '2026-09-15', end: '2026-10-24' },
  { n: 7, name: 'Кровля и гидроизоляция', start: '2026-10-25', end: '2026-11-18' },
  { n: 8, name: 'Фасад и оконные блоки', start: '2026-11-19', end: '2026-12-23' },
  { n: 9, name: 'Благоустройство территории', start: '2026-12-24', end: '2027-01-12' },
];
PLAN.forEach((s) => { s.s = D(s.start); s.e = D(s.end); s.days = Math.round((s.e - s.s) / dayMs) + 1; });
const PLAN_FROM = D('2026-04-15'), PLAN_TO = D('2027-01-20');

// p = доля этапов справочника, где техника встречается (вероятностный профиль проекта)
const BASE_RULES = {
  1: { bulldozer: 0.9, dump_truck: 0.82, excavator: 0.62, grader: 0.55, loader: 0.4 },
  2: { excavator: 0.95, dump_truck: 0.92, bulldozer: 0.88, loader: 0.41, backhoe_loader: 0.35, truck_crane: 0.12, grader: 0.1, roller: 0.08, concrete_mixer: 0.06, concrete_pump: 0.05, tower_crane: 0.07 },
  3: { concrete_pump: 0.9, tower_crane: 0.86, concrete_mixer: 0.7, truck_crane: 0.58, loader: 0.3, backhoe_loader: 0.25, excavator: 0.18, dump_truck: 0.14, bulldozer: 0.1, roller: 0.05, grader: 0.04 },
  4: { tower_crane: 0.95, concrete_pump: 0.9, concrete_mixer: 0.88, truck_crane: 0.6, loader: 0.3 },
  5: { tower_crane: 0.97, concrete_mixer: 0.9, concrete_pump: 0.85, truck_crane: 0.55 },
  6: { tower_crane: 0.95, concrete_mixer: 0.9, loader: 0.8, dump_truck: 0.72, truck_crane: 0.65 },
  7: { tower_crane: 0.9, truck_crane: 0.6, loader: 0.3 },
  8: { truck_crane: 0.62, tower_crane: 0.55, loader: 0.35 },
  9: { roller: 0.9, dump_truck: 0.85, grader: 0.6, loader: 0.6, excavator: 0.3, backhoe_loader: 0.45 },
};
const DEFAULTS = { warnAfter: 300, errAfter: 1800, oopAfter: 60, window: 30, conf: 60, shiftFrom: H(7), shiftTo: H(19), startGrace: 1800 };
const WARN_STEPS = [60, 120, 180, 300, 600, 900, 1200, 1800];
const ERR_STEPS = [600, 900, 1200, 1800, 2700, 3600, 5400];
const OOP_STEPS = [30, 60, 120, 300, 600];

/* ── Camera frames (illustrative) and their detections ─ */
const IMG = { 'cam1-truck': 'assets/cam1-truck.webp', cam1: 'assets/cam1.webp', cam2: 'assets/cam2.webp', cam3: 'assets/cam3.webp' };
const BOXES = {
  'cam1-truck': [
    { code: 'excavator', x: 0.175, y: 0.38, w: 0.275, h: 0.32, c: 0.93 },
    { code: 'dump_truck', x: 0.512, y: 0.5, w: 0.215, h: 0.235, c: 0.89 },
    { code: 'tower_crane', x: 0.528, y: 0.0, w: 0.05, h: 0.37, c: 0.86 },
  ],
  cam1: [
    { code: 'excavator', x: 0.175, y: 0.38, w: 0.275, h: 0.32, c: 0.93 },
    { code: 'tower_crane', x: 0.528, y: 0.0, w: 0.05, h: 0.37, c: 0.86 },
  ],
  cam2: [{ code: 'tower_crane', x: 0.186, y: 0.0, w: 0.086, h: 0.64, c: 0.94 }],
  cam3: [{ code: 'excavator', x: 0.318, y: 0.236, w: 0.5, h: 0.582, c: 0.91 }],
};
const CAMS = [
  { id: 'c1', n: 1, name: 'Котлован · общий план', url: 'rtsp://10.20.1.11/main' },
  { id: 'c2', n: 2, name: 'Кран и склад', url: 'rtsp://10.20.1.12/main' },
  { id: 'c3', n: 3, name: 'Котлован · запад', url: 'rtsp://10.20.1.13/main' },
];
const INF = Infinity;

/* ── Scenarios ──────────────────────────────────────────── */
const decidedMorning = () => [
  { id: 'INC-0509', kind: 'camera', sev: 'info', cam: 'c3', from: H(7, 41), born: H(7, 41, 30), to: H(7, 47), status: 'auto', decidedAt: H(7, 47), note: 'Сигнал восстановился сам' },
  { id: 'INC-0514', kind: 'missing', sev: 'warn', code: 'dump_truck', from: H(9, 5), born: H(9, 10), to: H(9, 13), status: 'confirmed', decidedAt: H(9, 24), note: 'Машины стояли на въезде, подтверждено прорабом' },
];
const SCN = {
  truck: {
    label: 'Нет самосвала', hint: 'Пример из ТЗ: экскаватор работает, самосвалов нет', date: '2026-05-05', now: H(10, 47, 32), replayFrom: H(10, 39, 30), model: true, off: {},
    presence: { excavator: [[H(7, 2), INF]], dump_truck: [[H(7, 20), H(9, 5)], [H(9, 13), H(10, 41, 4)]], tower_crane: [[0, INF]] },
    events: () => [...decidedMorning(), { id: 'INC-0517', kind: 'missing', sev: 'warn', code: 'dump_truck', from: H(10, 41, 4), born: H(10, 46, 4), to: null, status: 'pending' }],
  },
  ok: {
    label: 'Всё по плану', hint: 'Вся обязательная техника на месте', date: '2026-05-05', now: H(10, 47, 32), replayFrom: H(9, 0), model: true, off: {},
    presence: { excavator: [[H(7, 2), INF]], dump_truck: [[H(7, 20), H(9, 5)], [H(9, 13), INF]], tower_crane: [[0, INF]] },
    events: () => decidedMorning(),
  },
  camoff: {
    label: 'Камера без сигнала', hint: 'Вывод ограничен, система не додумывает', date: '2026-05-05', now: H(10, 47, 32), replayFrom: H(10, 33), model: true, off: { c3: H(10, 35, 10) },
    presence: { excavator: [[H(7, 2), INF]], dump_truck: [[H(7, 20), H(9, 5)], [H(9, 13), H(10, 41, 4)]], tower_crane: [[0, INF]] },
    events: () => [...decidedMorning(),
      { id: 'INC-0516', kind: 'camera', sev: 'warn', cam: 'c3', from: H(10, 35, 10), born: H(10, 36, 10), to: null, status: 'pending' },
      { id: 'INC-0517', kind: 'missing', sev: 'warn', code: 'dump_truck', from: H(10, 41, 4), born: H(10, 46, 4), to: null, status: 'pending', limited: true }],
  },
  model: {
    label: 'Распознавание недоступно', hint: 'Нет анализа, значит нет выводов', date: '2026-05-05', now: H(10, 47, 32), replayFrom: H(10, 30), model: false, modelSince: H(10, 32, 40), off: {},
    presence: { excavator: [[H(7, 2), INF]], dump_truck: [[H(7, 20), H(9, 5)], [H(9, 13), H(10, 41, 4)]], tower_crane: [[0, INF]] },
    events: () => decidedMorning(),
  },
  lag: {
    label: 'Отставание от графика', hint: 'Техника не того этапа на площадке', date: '2026-05-24', now: H(11, 20, 5), replayFrom: H(7, 30), model: true, off: {},
    presence: { excavator: [[H(7, 4), INF]], dump_truck: [[H(7, 31), INF]], tower_crane: [[0, INF]] },
    infer: { stage: 2, days: 2 },
    events: () => [
      { id: 'INC-0601', kind: 'missing', sev: 'err', code: 'concrete_pump', from: H(7, 30), born: H(7, 35), to: null, status: 'pending' },
      { id: 'INC-0602', kind: 'oop', sev: 'err', codes: ['excavator', 'dump_truck'], from: H(7, 31), born: H(7, 32), to: null, status: 'pending' },
    ],
  },
  setup: { label: 'Новый объект', hint: 'Первый запуск: план, источник, проверка', date: '2026-05-05', now: H(10, 47, 32), setup: true, model: true, off: {}, presence: {}, events: () => [] },
};
const SCN_ORDER = ['truck', 'ok', 'camoff', 'model', 'lag', 'setup'];

/* ── State ─────────────────────────────────────────────── */
const S = {
  key: 'truck', scn: null, t: 0, now: 0, live: true, replaying: false,
  cam: 'c1', boxes: true, events: [], rules: {}, settings: { ...DEFAULTS },
  prev: null, booted: false, focus: null, doneOpen: false,
  dockOpen: false, planSel: null, setupState: null,
};
function loadScenario(key, { boot = true } = {}) {
  S.key = key; S.scn = SCN[key];
  S.now = S.scn.now; S.t = S.now; S.live = true; S.replaying = false;
  S.events = S.scn.events().map((e) => ({ ...e }));
  S.cam = 'c1'; S.prev = null; S.focus = null;
  S.rules = {}; // overrides per stage: {stageN: {code: {lvl, warnAfter, errAfter, oopAfter, note, by}}}
  S.rules[2] = {
    bulldozer: { lvl: 'rec', note: 'Планировка дна котлована по ППР начнётся 15 мая', at: '3 мая' },
    tower_crane: { lvl: 'skip', note: 'Стационарный кран, смонтирован 20 апреля', at: '20 апреля' },
  };
  S.planSel = null;
  S.setupState = key === 'setup' ? { plan: false, source: false, check: 0, camForm: false } : null;
  $('#scnLabel').textContent = S.scn.label;
  renderAll({ boot });
}

/* ── Model: what the system knows at time t ───────────── */
const scnDate = () => D(S.scn.date);
function stageForDate(d) { return PLAN.find((s) => d >= s.s && d <= s.e) || null; }
function ruleFor(stageN, code) {
  const p = BASE_RULES[stageN]?.[code] ?? 0.03;
  const base = levelFromP(p);
  const o = S.rules[stageN]?.[code];
  const st = S.settings;
  return {
    code, p, base, lvl: o?.lvl ?? base, edited: !!o, note: o?.note, at: o?.at,
    warnAfter: o?.warnAfter ?? st.warnAfter, errAfter: o?.errAfter ?? st.errAfter, oopAfter: o?.oopAfter ?? st.oopAfter,
  };
}
function intervals(code) { return S.scn.presence[code] || []; }
function presentAt(code, t) { return intervals(code).some(([a, b]) => t >= a && t < b); }
function lastSeenBefore(code, t) {
  let best = null;
  for (const [a, b] of intervals(code)) if (a <= t) best = Math.min(b, t);
  return best;
}
function camOff(id, t) { const s = S.scn.off[id]; return s != null && t >= s; }
function frameKey(id, t) { if (id === 'c1') return presentAt('dump_truck', t) ? 'cam1-truck' : 'cam1'; return id === 'c2' ? 'cam2' : 'cam3'; }
function camFrameTime(id, t) { return camOff(id, t) ? S.scn.off[id] : t; }

function evaluate(t) {
  const sc = S.scn, st = S.settings;
  const stage = stageForDate(scnDate());
  const inShift = t >= st.shiftFrom && t <= st.shiftTo;
  const model = sc.model || (sc.modelSince != null && t < sc.modelSince);
  const cams = CAMS.map((c) => {
    const off = camOff(c.id, t);
    const ft = camFrameTime(c.id, t);
    return { ...c, off, offFor: off ? t - sc.off[c.id] : 0, img: frameKey(c.id, ft), ft };
  });
  const det = {};
  if (model) for (const c of cams) {
    if (c.off) continue;
    for (const b of BOXES[c.img]) if (presentAt(b.code, t) && b.c * 100 >= st.conf) (det[b.code] ||= []).push({ cam: c.id, c: b.c });
  }
  const liveCams = cams.filter((c) => !c.off);
  const slots = [], oop = [], stationary = [], allowed = [];
  if (stage) {
    const rules = CODES.map((code) => ruleFor(stage.n, code));
    for (const r of rules) {
      if (r.lvl === 'req' || r.lvl === 'rec') {
        const s = { ...r, cams: det[r.code] || [] };
        if (!model) s.state = 'unknown';
        else if (s.cams.length) s.state = 'seen';
        else if (!inShift) s.state = 'offshift';
        else if (lastSeenBefore(r.code, t) == null && t < st.shiftFrom + st.startGrace) s.state = 'gathering';
        else {
          const ls = lastSeenBefore(r.code, t);
          const graceEnd = st.shiftFrom + st.startGrace;
          s.since = Math.max(ls ?? graceEnd, graceEnd);
          s.neverToday = ls == null;
          s.missFor = Math.max(0, t - s.since);
          if (r.lvl === 'req') {
            s.sev = s.missFor >= r.errAfter ? 'err' : s.missFor >= r.warnAfter ? 'warn' : null;
            s.state = s.sev ? 'missing' : 'waiting';
          } else { s.state = 'missing'; s.sev = 'info'; }
          s.limited = liveCams.length < cams.length;
        }
        slots.push(s);
      } else if (r.lvl === 'no' && det[r.code]) oop.push({ ...r, cams: det[r.code] });
      else if (r.lvl === 'skip') stationary.push({ ...r, cams: det[r.code] || [] });
      else if (r.lvl === 'ok') allowed.push({ ...r, cams: det[r.code] || [] });
    }
    slots.sort((a, b) => LV_ORDER.indexOf(a.lvl) - LV_ORDER.indexOf(b.lvl) || b.p - a.p);
  }
  const events = S.events.filter((e) => e.born <= t).map((e) => {
    const pending = e.status === 'pending' || (e.decidedAt != null && e.decidedAt > t);
    const end = e.to != null && e.to <= t ? e.to : t;
    let sev = e.sev;
    if (e.kind === 'missing' && e.code) { const r = stage ? ruleFor(stage.n, e.code) : null; if (r && end - e.from >= r.errAfter) sev = 'err'; }
    return { ...e, pending, dur: end - e.from, sevNow: sev, ongoing: e.to == null || e.to > t };
  });
  return { t, stage, model, cams, det, slots, oop, stationary, allowed, events, inShift, liveCams };
}

function eventTitle(e, words = false) {
  const d = words ? durWords(e.dur) : durShort(e.dur);
  if (e.kind === 'missing') return `${M[e.code].name} не замечен ${d}`;
  if (e.kind === 'camera') { const c = CAMS.find((x) => x.id === e.cam); return `Камера «${c.name}» без сигнала ${d}`; }
  if (e.kind === 'oop') return `${e.codes.map((c, i) => (i ? M[c].lower : M[c].name)).join(' и ')} не по этапу`;
  return e.id;
}
const CONSEQ = {
  dump_truck: 'Без самосвалов грунт из котлована не вывозится, темп этапа может снизиться.',
  excavator: 'Без экскаватора разработка грунта не ведётся.',
  concrete_pump: 'Без бетононасоса бетонирование плиты не ведётся.',
  tower_crane: 'Без крана подача материалов на захватки невозможна.',
};
const sevWord = { warn: 'Предупреждение', err: 'Отклонение', info: 'Сведения' };

function verdictOf(ev) {
  const sc = S.scn;
  if (sc.setup) return null;
  if (!ev.stage) return { tone: 'none', title: 'На эту дату нет этапа плана', sub: 'Сверка не выполняется: календарный план не покрывает выбранный день.' };
  if (!ev.model) {
    const since = sc.modelSince ? ` с ${hhmm(sc.modelSince)}` : '';
    return { tone: 'nodata', title: 'Распознавание остановлено', sub: `Модель на сервере не отвечает${since}. Кадры с камер приходят, но техника на них не определяется, поэтому новые отклонения не создаются.`, actions: [{ label: 'Состояние сервера', act: 'settings:sources' }] };
  }
  const pending = ev.events.filter((e) => e.pending).sort((a, b) => (b.sevNow === 'err') - (a.sevNow === 'err') || b.born - a.born);
  const off = ev.cams.filter((c) => c.off);
  const seenReq = ev.slots.filter((s) => s.state === 'seen').map((s) => M[s.code].lower);
  if (!ev.inShift) return { tone: 'none', title: ev.t < S.settings.shiftFrom ? 'Смена ещё не началась' : 'Смена закончилась', sub: `Отсутствие техники вне смены (${hhmm(S.settings.shiftFrom)}–${hhmm(S.settings.shiftTo)}) не считается отклонением.` };
  if (sc.infer && pending.length) {
    const st = PLAN.find((p) => p.n === sc.infer.stage);
    return {
      tone: 'err', title: 'Похоже, котлован ещё не завершён',
      sub: `По плану с 23 мая идёт «${ev.stage.name}», но на площадке <strong>экскаватор и самосвал</strong>, а бетононасоса нет. Такой набор техники соответствует этапу ${st.n} «${st.name}». Возможное отставание: ${sc.infer.days} дня.`,
      actions: [{ label: 'Разобрать', act: 'case', id: pending[0].id, primary: true }, { label: 'Открыть план', act: 'plan' }],
    };
  }
  if (off.length && pending.some((e) => e.kind === 'camera')) {
    const c = off[0];
    const miss = pending.find((e) => e.kind === 'missing');
    return {
      tone: 'warn', title: `Камера «${c.name}» без сигнала ${durWords(c.offFor)}`,
      sub: `Работают ${ev.liveCams.length} из ${ev.cams.length} камер.` + (miss ? ` ${M[miss.code].name} не замечен на них ${durShort(miss.dur)}, но часть котлована сейчас не видна, поэтому вывод ограничен.` : ' Зона этой камеры не просматривается.'),
      actions: [{ label: 'Проверить камеру', act: 'settings:sources', primary: true }, ...(miss ? [{ label: 'Событие', act: 'case', id: miss.id }] : [])],
    };
  }
  if (pending.length) {
    const e = pending[0];
    const others = pending.length - 1;
    let sub = '';
    if (e.kind === 'missing') {
      const seen = seenReq.filter((n) => n !== M[e.code].lower);
      sub = (seen.length ? `<strong>${seen.map((s, i) => (i ? s : s[0].toUpperCase() + s.slice(1))).join(', ')}</strong> на месте, ${M[e.code].lower} не виден с ${hhmm(e.from)}. ` : '') + (CONSEQ[e.code] || 'Техника обязательна для этапа.');
    }
    if (others > 0) sub += ` Ещё ${others} ${plural(others, 'событие ждёт', 'события ждут', 'событий ждут')} решения.`;
    return { tone: e.sevNow, title: eventTitle(e, true), sub, actions: [{ label: 'Разобрать', act: 'case', id: e.id, primary: true }] };
  }
  // a confirmed deviation is still a deviation until the machine is back
  const held = ev.events.filter((e) => !e.pending && e.ongoing && (e.status === 'confirmed' || e.status === 'later')).sort((a, b) => b.born - a.born)[0];
  if (held) {
    return {
      tone: held.sevNow, title: eventTitle(held, true),
      sub: `${held.status === 'confirmed' ? 'Отклонение подтверждено' : 'Решение отложено'} в ${hhmm(held.decidedAt)}. Ситуация продолжается, система закроет событие, когда ${held.kind === 'missing' ? `${M[held.code].lower} появится на камерах` : 'сигнал восстановится'}.`,
      actions: [{ label: 'Открыть', act: 'case', id: held.id }],
    };
  }
  const waiting = ev.slots.find((s) => s.state === 'waiting');
  if (waiting) {
    const left = waiting.warnAfter - waiting.missFor;
    return { tone: 'ok', title: 'Работы идут по плану', sub: `${M[waiting.code].name} не виден ${durShort(waiting.missFor)}. Если не появится ещё ${durShort(left)}, система предупредит.` };
  }
  return { tone: 'ok', title: 'Работы идут по плану', sub: seenReq.length ? `Обязательная техника этапа замечена за последние ${S.settings.window} секунд: ${seenReq.join(', ')}.` : 'Обязательной техники для этапа нет.' };
}

/* ── Rendering ─────────────────────────────────────────── */
const GLYPH = {
  ok: '<circle cx="22" cy="22" r="13" fill="var(--ok)"/><path d="M15.5 22.4l4.4 4.3 8.6-9" fill="none" stroke="#0c0e11" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>',
  warn: '<path d="M22 6.5 38.5 35.5h-33z" fill="var(--warn)" stroke="var(--warn)" stroke-width="3" stroke-linejoin="round"/><path d="M22 16.5v9" stroke="#0c0e11" stroke-width="2.8" stroke-linecap="round"/><circle cx="22" cy="30.4" r="1.7" fill="#0c0e11"/>',
  err: '<path d="M22 5.5 38.5 22 22 38.5 5.5 22z" fill="var(--err)" stroke="var(--err)" stroke-width="3" stroke-linejoin="round"/><path d="M22 14.5v9" stroke="#0c0e11" stroke-width="2.8" stroke-linecap="round"/><circle cx="22" cy="28.6" r="1.7" fill="#0c0e11"/>',
  nodata: '<defs><pattern id="hp" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="1.4" height="5" fill="var(--fg-3)"/></pattern></defs><circle cx="22" cy="22" r="13.5" fill="url(#hp)" stroke="var(--fg-3)" stroke-width="1.5"/>',
  none: '<circle cx="22" cy="22" r="13" fill="none" stroke="var(--fg-3)" stroke-width="1.5" stroke-dasharray="3 3"/>',
};
const SEV_ICON = { warn: '<svg viewBox="0 0 14 14"><path d="M7 1.6 13 12.4H1z" fill="currentColor"/></svg>', err: '<svg viewBox="0 0 14 14"><path d="M7 1 13 7 7 13 1 7z" fill="currentColor"/></svg>', info: '<svg viewBox="0 0 14 14"><circle cx="7" cy="7" r="5" fill="currentColor"/></svg>' };

let lastVerdictKey = '';
function renderVerdict(ev, animate) {
  const v = verdictOf(ev);
  const wrap = $('#vTitleWrap'), glyph = $('#vGlyph');
  if (!v) return;
  const key = v.tone + '|' + v.title.replace(/\d+/g, '#');
  const titleEl = $('#vTitle');
  if (key !== lastVerdictKey && lastVerdictKey && animate && !RM.matches) {
    // old line leaves upward, new arrives from below: newer state = later = lower
    const old = titleEl.cloneNode(true); old.id = ''; old.classList.add('morph-out'); wrap.appendChild(old);
    titleEl.innerHTML = esc(v.title);
    const sp = new Spring(0, { response: 0.5, damping: 1, rest: 0.002, onUpdate: (p) => {
      old.style.transform = `translateY(${-p * 18}px)`; old.style.opacity = String(1 - p); old.style.filter = `blur(${p * 6}px)`;
      titleEl.style.transform = `translateY(${(1 - p) * 22}px)`; titleEl.style.opacity = String(p); titleEl.style.filter = `blur(${(1 - p) * 6}px)`;
    }, onRest: () => { old.remove(); titleEl.style.filter = ''; } });
    sp.to(1);
    const gs = new Spring(0.6, { response: 0.45, damping: 0.62, rest: 0.002, onUpdate: (s) => { glyph.style.transform = `scale(${s})`; } });
    glyph.innerHTML = `<svg viewBox="0 0 44 44">${GLYPH[v.tone] || GLYPH.none}</svg>`; gs.to(1);
  } else {
    if (titleEl.textContent !== v.title) titleEl.textContent = v.title;
    if (glyph.dataset.tone !== v.tone) glyph.innerHTML = `<svg viewBox="0 0 44 44">${GLYPH[v.tone] || GLYPH.none}</svg>`;
  }
  glyph.dataset.tone = v.tone;
  lastVerdictKey = key;
  const sub = $('#vSub'); if (sub.innerHTML !== v.sub) sub.innerHTML = v.sub;
  const actKey = JSON.stringify(v.actions || []);
  const acts = $('#vActions');
  if (acts.dataset.k !== actKey) {
    acts.dataset.k = actKey;
    acts.innerHTML = (v.actions || []).map((a, i) => `<button type="button" class="btn ${a.primary ? 'primary' : ''}" data-act="${a.act}" ${a.id ? `data-id="${a.id}"` : ''}>${esc(a.label)}</button>`).join('');
  }
}

/* frame */
let frameKeyShown = '';
function renderFrame(ev) {
  const c = ev.cams.find((x) => x.id === S.cam) || ev.cams[0];
  const img1 = $('#fImg'), img2 = $('#fImg2'), frame = $('#frame');
  const k = c.img;
  if (k !== frameKeyShown) {
    if (!frameKeyShown || RM.matches) { img1.src = IMG[k]; img2.style.opacity = '0'; }
    else {
      img2.src = IMG[k]; img2.style.transition = 'none'; img2.style.opacity = '0';
      requestAnimationFrame(() => { img2.style.transition = 'opacity 420ms ease-out'; img2.style.opacity = '1'; });
      clearTimeout(renderFrame.tm);
      renderFrame.tm = setTimeout(() => { img1.src = IMG[k]; img2.style.transition = 'none'; img2.style.opacity = '0'; }, 460);
    }
    frameKeyShown = k;
  }
  // staleness: frame loses colour as it ages
  const stale = c.off ? clamp(c.offFor / 600, 0.25, 0.92) : 0;
  const filt = stale ? `saturate(${1 - stale}) brightness(${1 - stale * 0.35})` : '';
  img1.style.filter = filt; img2.style.filter = filt;
  $('#fCam').textContent = c.name;
  $('#fCamSub').textContent = `Камера ${c.n} · ${c.off ? 'нет сигнала' : 'кадр 1280×720'}`;
  $('#fTime').textContent = c.off ? `последний кадр ${hhmmss(c.ft)}` : hhmmss(ev.t - 1);
  const live = $('#fLive');
  live.className = 'chip-mat' + (c.off ? ' off' : S.live ? '' : ' rec');
  live.lastElementChild.textContent = c.off ? `Нет сигнала ${durShort(c.offFor)}` : S.live ? 'Прямой эфир' : `Запись · ${hhmm(ev.t)}`;
  // boxes
  const boxes = $('#boxes');
  const list = !ev.model || c.off ? [] : BOXES[c.img].filter((b) => presentAt(b.code, ev.t) && b.c * 100 >= S.settings.conf);
  const stg = ev.stage;
  const bk = list.map((b) => b.code).join(',') + '|' + (stg?.n || 0) + '|' + JSON.stringify(S.rules[stg?.n] || {});
  if (boxes.dataset.k !== bk) {
    const prevCodes = new Set((boxes.dataset.k || '').split('|')[0].split(','));
    boxes.dataset.k = bk;
    boxes.innerHTML = list.map((b) => {
      const r = stg ? ruleFor(stg.n, b.code) : { lvl: 'ok' };
      const cls = r.lvl === 'no' ? 'oop' : r.lvl === 'skip' ? 'stationary' : '';
      const tag = r.lvl === 'no' ? ' · не по этапу' : r.lvl === 'skip' ? ' · не учитывается' : '';
      return `<div class="box ${cls}${b.y < 0.08 ? ' lbl-in' : ''}" data-m="${b.code}" style="left:${b.x * 100}%;top:${b.y * 100}%;width:${b.w * 100}%;height:${b.h * 100}%"><b>${M[b.code].name}${tag}<i>${b.c.toFixed(2).replace('.', ',')}</i></b></div>`;
    }).join('');
    // lock-on: brackets settle from slightly larger, only for new boxes
    $$('.box', boxes).forEach((el) => {
      if (prevCodes.has(el.dataset.m) || RM.matches) return;
      const sp = new Spring(0, { response: 0.38, damping: 0.9, rest: 0.002, onUpdate: (p) => { el.style.transform = `scale(${1.18 - 0.18 * p})`; el.style.opacity = String(Math.min(1, p * 1.4)); } });
      sp.to(1);
    });
  }
  $('#fCount').textContent = !ev.model ? 'Распознавание недоступно' : c.off ? 'Анализ по камере невозможен' : `${list.length} ${plural(list.length, 'объект', 'объекта', 'объектов')} на кадре`;
  const fs = $('#fState');
  let on = false, tt = '', pp = '';
  if (c.off) { on = true; tt = 'Нет сигнала с камеры'; pp = `Последний кадр получен в ${hhmmss(c.ft)}. Для зоны этой камеры вывод об отсутствии техники не делается.`; }
  fs.dataset.on = String(on); $('#fStateT').textContent = tt; $('#fStateP').textContent = pp;
  frame.dataset.boxes = S.boxes ? 'on' : 'off';
}

function ageRing(c, t) {
  // ring = age of the freshest frame relative to the observation window
  const age = c.off ? c.offFor : (t % 2) + 0.4;
  const frac = clamp(age / S.settings.window, 0, 1);
  const col = c.off ? 'var(--fg-3)' : age > S.settings.window * 0.5 ? 'var(--warn)' : 'var(--ok)';
  const L = 2 * Math.PI * 7;
  return `<svg class="t-age" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="7" stroke="rgba(255,255,255,.18)"/><circle cx="9" cy="9" r="7" stroke="${col}" stroke-dasharray="${L}" stroke-dashoffset="${L * frac}" transform="rotate(-90 9 9)" stroke-linecap="round"/></svg>`;
}
function renderStrip(ev) {
  const strip = $('#strip');
  if (!strip.dataset.built) {
    strip.dataset.built = '1';
    strip.innerHTML = ev.cams.map((c) => `<button type="button" class="tile" data-cam="${c.id}" aria-pressed="false"><img alt="" draggable="false"><span class="t-off"></span><span class="t-flag"></span><span class="t-name">${c.n} · ${esc(c.name)}</span><span class="t-ring"></span></button>`).join('') +
      `<div class="strip-meta"><span id="stripLive"></span><span id="stripWin"></span><span class="proto-line">Кадры в макете иллюстративные</span></div><div class="frame-tools"><button type="button" class="toggle" id="boxToggle" role="switch" aria-checked="true"><span class="sw"></span>Рамки</button></div>`;
  }
  for (const c of ev.cams) {
    const tile = $(`.tile[data-cam="${c.id}"]`, strip);
    const img = $('img', tile);
    if (img.dataset.k !== c.img) { img.dataset.k = c.img; img.src = IMG[c.img]; }
    const stale = c.off ? clamp(c.offFor / 600, 0.25, 0.92) : 0;
    img.style.filter = stale ? `saturate(${1 - stale}) brightness(${1 - stale * 0.35})` : '';
    tile.setAttribute('aria-pressed', String(c.id === S.cam));
    tile.dataset.off = String(c.off);
    $('.t-flag', tile).textContent = c.off ? `Нет сигнала ${durShort(c.offFor)}` : '';
    $('.t-ring', tile).innerHTML = ageRing(c, ev.t);
    tile.setAttribute('aria-label', `${c.name}${c.off ? ', нет сигнала' : ''}`);
  }
  const live = ev.cams.filter((c) => !c.off).length;
  $('#stripLive').innerHTML = `<b>${live} из ${ev.cams.length}</b> камер дают кадры`;
  $('#stripWin').textContent = `Окно сверки ${S.settings.window} с · порог ${S.settings.conf}%`;
  $('#boxToggle').setAttribute('aria-checked', String(S.boxes));
}

function slotStateHTML(s) {
  if (s.state === 'seen') {
    const cams = s.cams.map((c) => CAMS.find((x) => x.id === c.cam).n);
    return `замечен · ${cams.length > 1 ? 'камеры' : 'камера'} ${cams.join(', ')}`;
  }
  if (s.state === 'unknown') return 'нет данных';
  if (s.state === 'offshift') return 'вне смены';
  if (s.state === 'gathering') return `сбор техники до ${hhmm(S.settings.shiftFrom + S.settings.startGrace)}`;
  if (s.state === 'waiting') return `не виден <span class="mono">${durShort(s.missFor)}</span>`;
  if (s.state === 'missing') {
    if (s.lvl === 'rec') return `не замечен${s.neverToday ? ' за смену' : ` ${durShort(s.missFor)}`}`;
    return `нет <span class="mono">${durShort(s.missFor)}</span>${s.limited ? ' · 2 из 3 камер' : ''}`;
  }
  return '';
}
function slotArc(s) {
  if (!(s.state === 'waiting' || (s.state === 'missing' && s.lvl === 'req'))) return '';
  // arc fills toward the next threshold: warning, then deviation
  const toWarn = s.missFor < s.warnAfter;
  const frac = toWarn ? s.missFor / s.warnAfter : clamp((s.missFor - s.warnAfter) / (s.errAfter - s.warnAfter), 0, 1);
  const col = toWarn ? 'var(--fg-3)' : s.sev === 'err' ? 'var(--err)' : 'var(--warn)';
  const L = 2 * Math.PI * 9;
  return `<svg class="s-arc" viewBox="0 0 22 22" aria-hidden="true"><circle cx="11" cy="11" r="9" stroke="rgba(255,255,255,.1)"/><circle cx="11" cy="11" r="9" stroke="${col}" stroke-dasharray="${L}" stroke-dashoffset="${L * (1 - frac)}" transform="rotate(-90 11 11)" stroke-linecap="round"/></svg>`;
}
function renderRecon(ev, { boot = false } = {}) {
  const el = $('#recon');
  const st = ev.stage;
  if (!st) { el.innerHTML = `<div class="recon-head"><div><span class="kicker">Сверка</span><h2 id="reconTitle">Нет активного этапа</h2><p>На ${fmtDay(scnDate())} в плане нет работ.</p></div></div>`; el.dataset.k = ''; return; }
  const d = scnDate();
  const day = Math.round((d - st.s) / dayMs) + 1;
  const struct = st.n + '|' + ev.slots.map((s) => s.code + s.lvl + s.edited).join(',');
  if (el.dataset.k !== struct) {
    el.dataset.k = struct;
    el.innerHTML = `
      <div class="recon-head">
        <div><span class="kicker">Сверка · этап ${st.n} из ${PLAN.length}</span><h2 id="reconTitle">${esc(st.name)}</h2><p>${fmtDay(st.s)} – ${fmtDay(st.e)}</p></div>
        <div class="stage-day"><span class="kicker">День</span><div style="font:400 22px/1.1 var(--f-display);margin-top:4px">${day}<span style="color:var(--fg-3);font-size:14px"> из ${st.days}</span></div></div>
      </div>
      <div class="stage-progress" aria-hidden="true"><i style="width:${(day / st.days) * 100}%"></i></div>
      <div class="slots" id="slots">${ev.slots.map((s, i) => `
        <button type="button" class="slot" data-code="${s.code}" aria-label="${M[s.code].name}, ${LV[s.lvl].label.toLowerCase()}">
          <span class="s-icon">${sil(s.code, 'ghost' + (boot ? ' draw' : ''), `style="--d:${i * 90}ms"`)}</span>
          <span class="s-body"><span class="s-name">${M[s.code].name}<span class="s-req">${LV[s.lvl].label.toLowerCase()}${s.edited ? ' · <span class="edited">изменено</span>' : ''}</span></span>
          <span class="s-state"></span></span><span class="s-arcw"></span>
        </button>`).join('')}
      </div>
      <div class="extra">
        <div class="extra-row"><span>Не по этапу</span><div class="oop-tray" id="oopTray"></div></div>
        <div class="extra-row" id="allowedRow"></div>
        <div class="extra-row" id="skipRow"></div>
      </div>
      <div id="inferBox"></div>`;
  }
  // per-slot state (cheap updates)
  for (const s of ev.slots) {
    const b = $(`.slot[data-code="${s.code}"]`, el);
    if (!b) continue;
    const icon = $('.s-icon', b);
    const wantInk = s.state === 'seen';
    const holdGhost = b.dataset.hold === '1';
    if (!holdGhost) {
      const cur = icon.firstElementChild.classList.contains('ink');
      if (wantInk !== cur) icon.innerHTML = sil(s.code, wantInk ? 'ink' : s.state === 'unknown' ? 'dim' : 'ghost');
    }
    if (holdGhost) continue; // a token is in flight to this slot; it updates on landing
    b.dataset.state = s.state;
    if (s.sev) b.dataset.sev = s.sev; else delete b.dataset.sev;
    const sh = slotStateHTML(s);
    const se = $('.s-state', b); if (se.innerHTML !== sh) se.innerHTML = sh;
    const ah = slotArc(s); const aw = $('.s-arcw', b); if (aw.innerHTML !== ah) aw.innerHTML = ah;
  }
  const tray = $('#oopTray', el);
  const oh = ev.oop.length ? ev.oop.map((o) => `<button type="button" class="oop-chip" data-code="${o.code}">${sil(o.code, 'oop')}${M[o.code].name}</button>`).join('') : '<span class="oop-none">нет</span>';
  if (tray.innerHTML !== oh) tray.innerHTML = oh;
  const ar = ev.allowed.length ? `<span>Допустимы</span><span>${ev.allowed.map((a) => `<button type="button" data-code="${a.code}">${M[a.code].lower}</button>`).join(', ')}</span>` : '';
  const arEl = $('#allowedRow', el); if (arEl.innerHTML !== ar) arEl.innerHTML = ar;
  const sr = ev.stationary.length ? `<span>Не учитываются</span><span>${ev.stationary.map((a) => `<button type="button" data-code="${a.code}">${M[a.code].lower}</button>${a.note ? ' (стационарный)' : ''}`).join(', ')}</span>` : '';
  const srEl = $('#skipRow', el); if (srEl.innerHTML !== sr) srEl.innerHTML = sr;
  const inf = S.scn.infer && ev.oop.length ? (() => { const p = PLAN.find((x) => x.n === S.scn.infer.stage); return `<div class="infer"><strong>Набор техники похож на этап ${p.n}</strong>Экскаватор и самосвал характерны для «${p.name}», который по плану закончился ${fmtDay(p.e)}.</div>`; })() : '';
  const ib = $('#inferBox', el); if (ib.innerHTML !== inf) ib.innerHTML = inf;
}

function renderQueue(ev, { births = [] } = {}) {
  const el = $('#queue');
  const pending = ev.events.filter((e) => e.pending).sort((a, b) => (b.sevNow === 'err') - (a.sevNow === 'err') || b.born - a.born);
  const done = ev.events.filter((e) => !e.pending).sort((a, b) => b.born - a.born);
  if (!el.dataset.built) {
    el.dataset.built = '1';
    el.innerHTML = `<div class="queue-head"><span class="kicker" id="queueTitle">Требуют решения<span class="count" id="qCount">0</span></span><button type="button" class="btn ghost small" data-act="journal">Журнал</button></div>
      <div class="q-list" id="qList"></div><div class="q-done" id="qDone"></div>`;
  }
  const list = $('#qList', el);
  const before = new Map($$('.q-item', list).map((n) => [n.dataset.id, n.getBoundingClientRect()]));
  const ids = pending.map((e) => e.id).join(',');
  if (list.dataset.ids !== ids) {
    list.dataset.ids = ids;
    const keep = new Map($$('.q-item', list).map((n) => [n.dataset.id, n]));
    list.innerHTML = '';
    if (!pending.length) list.innerHTML = `<div class="q-empty">${ev.model ? 'Новых отклонений нет. Решённые за смену — ниже.' : 'Пока распознавание недоступно, новые отклонения не создаются.'}</div>`;
    for (const e of pending) {
      let n = keep.get(e.id);
      if (!n) {
        n = document.createElement('div'); n.className = 'q-item'; n.dataset.id = e.id;
        n.innerHTML = `<div class="q-under" aria-hidden="true"><span class="u-confirm">Подтвердить</span><span class="u-false">Ложное</span></div>
          <button type="button" class="q-card" data-id="${e.id}"><span class="sev"></span><span class="q-main"><span class="q-title"><span class="q-t"></span><span class="mono">${hhmm(e.born)}</span></span><span class="q-sub"></span></span><span class="q-thumb"><img alt="" src="${IMG[e.kind === 'camera' ? 'cam3' : 'cam1']}" style="${e.kind === 'camera' ? 'filter:saturate(.15) brightness(.7)' : ''}"></span></button>`;
        bindSwipe(n);
      }
      list.appendChild(n);
    }
    // FLIP: survivors slide from where they were; births arrive from their origin
    for (const n of $$('.q-item', list)) {
      const was = before.get(n.dataset.id);
      const now = n.getBoundingClientRect();
      const card = $('.q-card', n);
      if (was) {
        const dy = was.top - now.top;
        if (dy && !RM.matches) { const sp = new Spring(dy, { response: 0.4, damping: 0.9, onUpdate: (y) => { n.style.transform = y ? `translateY(${y}px)` : ''; } }); sp.to(0); }
      } else if (!RM.matches && (births.includes(n.dataset.id) || S.booting)) {
        const origin = births.includes(n.dataset.id) ? birthOrigin(n.dataset.id) : null;
        const dx = origin ? origin.left + origin.width / 2 - (now.left + now.width / 2) : 0;
        const dy = origin ? origin.top + origin.height / 2 - (now.top + now.height / 2) : 16;
        const sp = new Spring(0, { response: 0.55, damping: 0.78, rest: 0.002, onUpdate: (p) => {
          const s = lerp(origin ? 0.35 : 0.96, 1, p);
          card.style.transform = p < 1 ? `translate(${dx * (1 - p)}px,${dy * (1 - p)}px) scale(${s})` : '';
          card.style.opacity = String(clamp(p * 1.6, 0, 1));
        } });
        sp.to(1);
      }
    }
  }
  for (const e of pending) {
    const n = $(`.q-item[data-id="${e.id}"]`, list); if (!n) continue;
    const card = $('.q-card', n); card.dataset.sev = e.sevNow;
    const t = eventTitle(e); const qt = $('.q-t', n); if (qt.textContent !== t) qt.textContent = t;
    const sub = `${S.scn.setup ? '' : 'Котлован'} · ${e.kind === 'camera' ? 'проверьте питание и сеть' : e.limited ? '2 из 3 камер, вывод ограничен' : `${sevWord[e.sevNow]} · ${e.ongoing ? 'продолжается' : 'завершилось'}`}`;
    const qs = $('.q-sub', n); if (qs.textContent !== sub) qs.textContent = sub;
    card.setAttribute('aria-label', `${sevWord[e.sevNow]}: ${t}. Открыть разбор`);
  }
  rollNumber($('#qCount', el), pending.length);
  const dn = $('#qDone', el);
  const dk = done.map((e) => e.id + e.status).join(',') + S.doneOpen;
  if (dn.dataset.k !== dk) {
    dn.dataset.k = dk;
    dn.innerHTML = done.length ? `<button type="button" data-act="toggle-done" aria-expanded="${S.doneOpen}"><span>Решено за смену · ${done.length}</span><span>${S.doneOpen ? 'Скрыть' : 'Показать'}</span></button>
      ${S.doneOpen ? `<ul>${done.map((e) => `<li><span class="mono">${hhmm(e.born)}</span><span><b>${esc(eventTitle(e))}</b><br>${{ confirmed: 'Подтверждено', false: 'Ложное срабатывание', later: 'Отложено', auto: 'Закрыто системой' }[e.status] || ''}${e.note ? ` · ${esc(e.note)}` : ''}</span></li>`).join('')}</ul>` : ''}` : '';
  }
  if (!$('.q-hint', el) && pending.length && !MOBILE.matches) el.insertAdjacentHTML('beforeend', '<div class="q-hint">Смахните карточку вправо, чтобы подтвердить, влево, если ложное</div>');
  if ($('.q-hint', el) && !pending.length) $('.q-hint', el).remove();
}
function birthOrigin(id) {
  const e = S.events.find((x) => x.id === id);
  if (e?.code) { const slot = $(`.slot[data-code="${e.code}"]`); if (slot) return slot.getBoundingClientRect(); }
  if (e?.cam) { const tile = $(`.tile[data-cam="${e.cam}"]`); if (tile) return tile.getBoundingClientRect(); }
  return null;
}
function rollNumber(el, n) {
  const cur = el.dataset.n;
  if (cur === String(n)) return;
  el.dataset.n = String(n);
  if (cur == null || RM.matches) { el.textContent = n; return; }
  const up = n > Number(cur);
  el.style.display = 'inline-block'; el.style.overflow = 'hidden'; el.style.verticalAlign = 'bottom'; el.style.height = '1em';
  el.innerHTML = `<span style="display:block">${cur}</span><span style="display:block">${n}</span>`;
  const col = el.firstElementChild, nxt = el.lastElementChild;
  const sp = new Spring(0, { response: 0.42, damping: 0.85, rest: 0.002, onUpdate: (p) => {
    col.style.transform = `translateY(${(up ? -100 : 100) * p}%)`;
    nxt.style.transform = `translateY(${(up ? 0 : 0) - 100 + (up ? 0 : 0)}%) translateY(${(up ? 1 - p : -(1 - p)) * 100}%)`;
  }, onRest: () => { el.textContent = n; el.removeAttribute('style'); } });
  sp.to(1);
}

/* ── Dock: day ruler + folded plan ────────────────────── */
const DAY_FROM = H(6), DAY_TO = H(20);
let dockGeo = null;
function tToX(t, w) { return ((t - DAY_FROM) / (DAY_TO - DAY_FROM)) * w; }
function xToT(x, w) { return DAY_FROM + (x / w) * (DAY_TO - DAY_FROM); }
function renderDock(ev) {
  const lead = $('#dockLead');
  const st = ev.stage;
  if (S.scn.setup && !S.setupState?.plan) {
    lead.innerHTML = `<span class="kicker">План работ</span><strong>Не загружен</strong><button type="button" data-act="setup-plan">Загрузить на шаге 2</button>`;
  } else {
    const d = scnDate();
    const day = st ? Math.round((d - st.s) / dayMs) + 1 : 0;
    const lh = `<span class="kicker">Этап ${st?.n ?? '—'} из ${PLAN.length}${st ? ` · день ${day}/${st.days}` : ''}</span><strong title="${esc(st?.name || '')}">${esc(st?.name || 'Нет этапа')}</strong><button type="button" data-act="plan" aria-controls="planFull"><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 6.5 5 3.5 8 6.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg><span>План работ</span></button>`;
    if (lead.dataset.k !== lh) { lead.dataset.k = lh; lead.innerHTML = lh; }
  }
  renderDay(ev);
  renderTools();
}
function renderTools() {
  const tools = $('#dockTools');
  const h = (S.scn.setup ? '' : `<button type="button" class="btn small replay" data-act="replay" title="Проиграть последние минуты ускоренно"><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 1.5v7l6-3.5z" fill="currentColor"/></svg><span>Повтор ×60</span></button>`) +
    (!S.live && !S.scn.setup ? `<button type="button" class="btn small plan" data-act="live">К прямому эфиру</button>` : '');
  if (tools.dataset.k !== h) { tools.dataset.k = h; tools.innerHTML = h; }
}
function renderDay(ev) {
  const day = $('#day');
  const w = day.clientWidth || 600;
  const now = S.now;
  const evs = ev.events;
  const struct = [w, S.key, now > 0, evs.map((e) => e.id + e.pending).join(','), S.scn.setup && !S.setupState?.plan].join('|');
  if (day.dataset.k !== struct) {
    day.dataset.k = struct;
    const hrs = [];
    for (let h = 6; h <= 20; h++) hrs.push(`<span class="${h % 3 === 0 ? 'major' : ''}" style="left:${tToX(H(h), w)}px">${pad(h)}</span>`);
    const recFrom = S.settings.shiftFrom;
    const gaps = Object.entries(S.scn.off).map(([id, s]) => `<span class="d-gap" style="left:${tToX(s, w)}px;width:${Math.max(2, tToX(now, w) - tToX(s, w))}px" title="Камера ${CAMS.find((c) => c.id === id).n} без сигнала"></span>`).join('');
    const marks = S.scn.setup ? '' : S.events.map((e) => `<span class="d-ev" data-id="${e.id}" data-sev="${e.sev}" data-done="${e.status !== 'pending'}" style="left:${tToX(e.born, w)}px" title="${hhmm(e.born)}"></span>`).join('');
    day.innerHTML = `<div class="d-track"></div>
      <div class="d-shift" style="left:${tToX(S.settings.shiftFrom, w)}px;width:${tToX(S.settings.shiftTo, w) - tToX(S.settings.shiftFrom, w)}px"></div>
      ${S.scn.setup ? '' : `<div class="d-rec" style="left:${tToX(recFrom, w)}px;width:${tToX(now, w) - tToX(recFrom, w)}px"></div>`}${gaps}
      ${marks}<div class="d-nowmark" style="left:${tToX(now, w)}px"></div><div class="d-axis">${hrs.join('')}</div>
      <div class="d-head" id="dHead"><span></span></div>`;
  }
  // births of ticks
  const head = $('#dHead', day);
  head.style.transform = `translateX(${tToX(ev.t, w)}px)`;
  head.firstElementChild.textContent = S.live ? 'сейчас' : hhmm(ev.t);
  head.style.display = S.scn.setup ? 'none' : '';
  $$('.d-ev', day).forEach((m) => { const e = S.events.find((x) => x.id === m.dataset.id); m.style.opacity = e && e.born <= ev.t ? '1' : '.25'; });
  day.setAttribute('aria-valuenow', String(Math.round(ev.t)));
  day.setAttribute('aria-valuetext', S.live ? `Сейчас, ${hhmm(ev.t)}` : `Запись, ${hhmm(ev.t)}`);
}

/* folded plan → gantt geometry */
function planGeometry() {
  const body = $('#dockBody');
  const W = body.clientWidth;
  const gut = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--gut')) || 20;
  const mob = MOBILE.matches;
  const leftC = mob ? gut : gut + 252;
  const rightC = gut;
  const leftE = mob ? gut : gut + 252;
  const rightE = mob ? gut : gut + 380;
  const span = PLAN_TO - PLAN_FROM;
  const rowTop = mob ? 92 : 98, rowH = mob ? 54 : 44;
  return { W, gut, mob, leftC, rightC, leftE, rightE, span, rowTop, rowH, stripTop: mob ? 42 : 2 };
}
function buildPlan() {
  const pc = $('#planCanvas');
  const pf = $('#planFull');
  const today = scnDate();
  if (S.scn.setup && !S.setupState?.plan) { pc.innerHTML = ''; pf.innerHTML = ''; return; }
  pc.innerHTML = PLAN.map((s) => {
    const cls = today > s.e ? 'done' : today >= s.s ? 'active' : 'future';
    const prog = cls === 'active' ? (today - s.s) / (s.e - s.s) : 0;
    return `<div class="p-bar ${cls}" data-n="${s.n}">${cls === 'active' ? `<i class="p-fill" style="width:${prog * 100}%"></i>` : ''}</div>`;
  }).join('') + '<div class="p-now" id="pNow"></div>';
  pf.innerHTML = `
    <div class="pf-head"><div><span class="kicker">План работ · ${PLAN.length} этапов</span><h2>Многоквартирный жилой дом · корпус 2</h2><p>18 апреля 2026 – 12 января 2027 · сопоставлено со справочником: 9 из 9</p></div>
      <div class="pf-actions"><button type="button" class="btn small" data-act="toast:Импорт плана откроет предпросмотр сопоставления этапов">Загрузить .xlsx</button><button type="button" class="btn small" data-act="collapse-plan">Свернуть</button></div></div>
    <div class="pf-months" id="pfMonths"></div>
    <div class="pf-grid" id="pfGrid"><div class="pf-today" id="pfToday"><span>${fmtDay(today)}</span></div></div>
    <div class="pf-rows" id="pfRows">${PLAN.map((s) => {
      const cls = today > s.e ? 'завершён' : today >= s.s ? 'идёт сейчас' : '';
      return `<button type="button" class="pf-row" data-n="${s.n}"><span class="n">${s.n}</span><span class="t"><b>${esc(s.name)}</b><small class="${today >= s.s && today <= s.e ? 'active' : ''}">${fmtDay(s.s)} – ${fmtDay(s.e)} · ${s.days} дн.${cls ? ` · ${cls}` : ''}</small></span></button>`;
    }).join('')}</div>
    <div class="pf-demand" id="pfDemand"></div>
    <aside class="pf-detail" id="pfDetail"></aside>`;
  renderDemand();
  layoutPlan(dockP);
  renderPlanDetail();
}
const DEMAND_CODES = ['excavator', 'dump_truck', 'bulldozer', 'tower_crane', 'concrete_mixer', 'concrete_pump', 'truck_crane', 'loader', 'roller', 'grader'];
function renderDemand() {
  const dm = $('#pfDemand'); if (!dm) return;
  dm.innerHTML = `<div class="dm-head"><span class="kicker">Какая техника нужна по плану</span></div>
    <div class="dm-legend" id="dmLegend"><span><i style="background:var(--plan)"></i>обязательна</span><span><i style="background:rgba(207,157,61,.42)"></i>рекомендуется</span><span><i style="background:rgba(207,157,61,.12)"></i>допустима</span><span><i style="background:var(--hatch);box-shadow:inset 0 0 0 1px var(--line-2)"></i>не учитывается</span><span><i style="background:var(--fg);width:5px;height:5px;border-radius:50%"></i>изменено вручную</span></div>
    ${DEMAND_CODES.map((c) => `<div class="dm-row" data-code="${c}"><span>${sil(c, 'dim')}${M[c].name}</span>${PLAN.map((st) => { const r = ruleFor(st.n, c); return `<button type="button" class="dm-cell l-${r.lvl}${r.edited ? ' edited' : ''}" data-code="${c}" data-stage="${st.n}" aria-label="${M[c].name}, этап ${st.n}: ${LV[r.lvl].label.toLowerCase()}" title="${M[c].name} · этап ${st.n} · ${LV[r.lvl].label.toLowerCase()} · ${Math.round(r.p * 100)}%"></button>`; }).join('')}</div>`).join('')}`;
  layoutPlan(dockP);
}
function layoutPlan(p) {
  const g = dockGeo = planGeometry();
  const pc = $('#planCanvas'); if (!pc.firstElementChild) return;
  const bodyH = $('#dockBody').clientHeight;
  const left = lerp(g.leftC, g.leftE, easeOut(p)), right = lerp(g.rightC, g.rightE, easeOut(p));
  pc.style.left = left + 'px'; pc.style.right = right + 'px';
  const w = g.W - left - right;
  const x = (d) => ((d - PLAN_FROM) / g.span) * w;
  const today = scnDate();
  PLAN.forEach((s, i) => {
    const bar = $(`.p-bar[data-n="${s.n}"]`, pc);
    // складной метр: each segment drops from the strip into its row, staggered
    const pi = easeOut(clamp((p - i * 0.035) / (1 - 8 * 0.035), 0, 1));
    const rowY = g.mob ? g.rowTop + i * g.rowH + 38 : g.rowTop + i * g.rowH + 14;
    const top = lerp(g.stripTop, rowY, pi);
    const h = lerp(g.mob ? 4 : 6, g.mob ? 8 : 16, pi);
    const L = x(s.s), R = x(new Date(+s.e + dayMs));
    bar.style.transform = `translate(${L}px, ${top}px)`;
    bar.style.width = Math.max(2, R - L - 2) + 'px';
    bar.style.height = h + 'px';
    bar.style.borderRadius = (h > 8 ? 3 : 2) + 'px';
  });
  const now = $('#pNow');
  now.style.transform = `translateX(${x(today)}px)`; now.style.top = (g.stripTop - 3) + 'px';
  now.style.opacity = String(1 - clamp(p * 3, 0, 1));
  // fade layers
  const dayEl = $('#day');
  const fadeC = 1 - clamp(p / 0.25, 0, 1);
  dayEl.style.opacity = String(fadeC); dayEl.style.transform = `translateY(${p * 24}px)`; dayEl.style.pointerEvents = p > 0.1 ? 'none' : '';
  const lead = $('#dockLead'); lead.style.opacity = String(1 - clamp(p / 0.3, 0, 1)); lead.style.pointerEvents = p > 0.1 ? 'none' : '';
  const tools = $('#dockTools'); tools.style.opacity = String(fadeC); tools.style.pointerEvents = p > 0.1 ? 'none' : '';
  const head = $('.pf-head'); if (head) { const o = clamp((p - 0.35) / 0.4, 0, 1); head.style.opacity = String(o); head.style.transform = `translateY(${(1 - o) * 12}px)`; }
  const months = $('#pfMonths');
  if (months) {
    const o = clamp((p - 0.4) / 0.4, 0, 1);
    months.style.left = left + 'px'; months.style.right = right + 'px'; months.style.top = (g.rowTop - 26) + 'px'; months.style.opacity = String(o);
    const mk = `${Math.round(w)}`;
    if (months.dataset.k !== mk) {
      months.dataset.k = mk;
      let html = ''; const d = new Date(2026, 4, 1);
      while (d < PLAN_TO) { html += `<span style="left:${x(d)}px">${MONTHS_S[d.getMonth()]}${d.getMonth() === 0 ? ` ’${String(d.getFullYear()).slice(2)}` : ''}</span>`; d.setMonth(d.getMonth() + 1); }
      months.innerHTML = html;
    }
    months.style.height = (PLAN.length * g.rowH + 30) + 'px'; months.style.overflow = 'hidden';
  }
  const grid = $('#pfGrid');
  if (grid) {
    grid.style.left = left + 'px'; grid.style.right = right + 'px'; grid.style.top = (g.rowTop) + 'px'; grid.style.height = (PLAN.length * g.rowH) + 'px';
    const td = $('#pfToday'); td.style.left = x(today) + 'px'; td.style.top = '0'; td.style.height = (PLAN.length * g.rowH) + 'px';
    grid.style.opacity = String(clamp((p - 0.5) / 0.4, 0, 1));
  }
  const rows = $('#pfRows');
  if (rows) {
    rows.style.top = g.rowTop + 'px';
    $$('.pf-row', rows).forEach((r, i) => {
      const o = clamp((p - 0.45 - i * 0.03) / 0.3, 0, 1);
      r.style.top = (i * g.rowH) + 'px'; r.style.opacity = String(o); r.style.transform = `translateX(${(1 - o) * -10}px)`;
      r.setAttribute('aria-current', String(Number(r.dataset.n) === (S.planSel ?? stageForDate(today)?.n)));
      r.tabIndex = p > 0.5 ? 0 : -1;
    });
  }
  const dm = $('#pfDemand');
  if (dm && dm.firstElementChild) {
    dm.style.top = (g.rowTop + PLAN.length * g.rowH + 34) + 'px';
    const o = clamp((p - 0.62) / 0.38, 0, 1);
    dm.style.opacity = String(o); dm.style.visibility = o < 0.02 ? 'hidden' : 'visible'; dm.style.display = g.mob ? 'none' : '';
    $('#dmLegend').style.left = (left - g.gut) + 'px';
    $$('.dm-row', dm).forEach((row, i) => {
      row.style.top = (28 + i * 22) + 'px';
      $$('.dm-cell', row).forEach((cell, j) => {
        const st = PLAN[j]; const L = x(st.s), R = x(new Date(+st.e + dayMs));
        cell.style.left = (left - g.gut + L) + 'px'; cell.style.width = Math.max(2, R - L - 2) + 'px';
        cell.tabIndex = p > 0.5 ? 0 : -1;
      });
    });
  }
  const det = $('#pfDetail');
  if (det) {
    const o = clamp((p - 0.6) / 0.4, 0, 1);
    if (g.mob) { det.style.top = (g.rowTop + PLAN.length * g.rowH + 14) + 'px'; det.style.bottom = 'auto'; }
    else { det.style.top = (g.rowTop - 26) + 'px'; det.style.bottom = '14px'; }
    det.style.opacity = String(o); det.style.transform = `translateX(${(1 - o) * 30}px)`;
    det.style.visibility = o < 0.02 ? 'hidden' : 'visible';
  }
  $('#planFull').dataset.open = String(p > 0.5);
  $('#planFull').style.overflow = g.mob && p > 0.5 ? 'auto' : '';
  const btnArrow = $('#dockLead button svg'); if (btnArrow) btnArrow.style.transform = `rotate(${p * 180}deg)`;
  $('#grip').setAttribute('aria-expanded', String(p > 0.5));
  $('#grip').setAttribute('aria-label', p > 0.5 ? 'Свернуть план работ' : 'Развернуть план работ');
  void bodyH;
}
function renderPlanDetail() {
  const det = $('#pfDetail'); if (!det) return;
  const today = scnDate();
  const st = PLAN.find((p) => p.n === (S.planSel ?? stageForDate(today)?.n)) || PLAN[1];
  const rules = CODES.map((c) => ruleFor(st.n, c));
  const groups = LV_ORDER.map((lv) => ({ lv, items: rules.filter((r) => r.lvl === lv).sort((a, b) => b.p - a.p) })).filter((g) => g.items.length && !(g.lv === 'no' && g.items.length > 6 && false));
  det.innerHTML = `<span class="kicker">Этап ${st.n} · ${st.days} дн.</span><h3>${esc(st.name)}</h3>
    <div class="meta">${fmtDay(st.s)} – ${fmtDay(st.e)}${st.catalog ? `<br>Справочник: ${esc(st.catalog)} · <a class="link" href="${st.src}" target="_blank" rel="noopener">${st.srcLabel} ↗</a>` : '<br>Профиль по справочнику проекта'}</div>
    <div class="req-list">${groups.map((g) => `<div class="req-group"><span class="kicker">${LV[g.lv].group}${g.lv === 'no' ? ' · вне плана' : ''}</span>
      ${g.items.map((r) => `<button type="button" class="req" data-code="${r.code}" data-stage="${st.n}">${sil(r.code, g.lv === 'req' || g.lv === 'rec' ? 'ghost' : g.lv === 'no' ? 'dim' : 'dim')}<span class="r-name">${M[r.code].name}${r.edited ? `<small class="edited">изменено ${r.at || 'вами'}${r.note ? ` · ${esc(r.note)}` : ''}</small>` : ''}</span><span class="r-p">${Math.round(r.p * 100)}%</span><span class="r-bar"><i style="width:${r.p * 100}%"></i></span></button>`).join('')}</div>`).join('')}</div>`;
}

let dockP = 0;
const dockSpring = new Spring(0, { response: 0.46, damping: 0.86, rest: 0.3, onUpdate: (h) => applyDock(h) });
function dockLimits() {
  const min = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dock-min')) || 104;
  const max = Math.max(min + 200, $('#app').clientHeight - (MOBILE.matches ? 0 : 56) - (MOBILE.matches ? 0 : 6));
  return { min, max: MOBILE.matches ? innerHeight - 24 : max };
}
function applyDock(h) {
  const { min, max } = dockLimits();
  const dock = $('#dock');
  dock.style.height = h + 'px';
  dockP = clamp((h - min) / (max - min), 0, 1);
  layoutPlan(dockP);
  document.body.dataset.plan = dockP > 0.5 ? 'open' : '';
}
function setDock(open, velocity = 0) {
  const { min, max } = dockLimits();
  S.dockOpen = open;
  dockSpring.to(open ? max : min, { velocity, damping: velocity ? 0.8 : 0.92 });
  if (open) renderPlanDetail();
}

/* ── Tokens: the fact flies onto the plan ─────────────── */
function flyToken(code, from, toEl, { delay = 0, onLand } = {}) {
  if (RM.matches || !from || !toEl) { onLand?.(); return; }
  const to = toEl.getBoundingClientRect();
  const tok = document.createElement('div');
  tok.className = 'token';
  tok.innerHTML = `<div class="halo"></div>${sil(code, 'ink')}`;
  document.body.appendChild(tok);
  const x0 = from.left + from.width / 2 - 32, y0 = from.top + from.height / 2 - 20;
  const x1 = to.left + to.width / 2 - 32, y1 = to.top + to.height / 2 - 20;
  // arc control point lifts the path so the motion reads as a throw, not a slide
  const cx = lerp(x0, x1, 0.5), cy = Math.min(y0, y1) - Math.max(60, Math.abs(x1 - x0) * 0.18);
  const s0 = clamp(Math.min(from.width / 64, from.height / 40), 0.6, 2.6);
  tok.style.opacity = '0';
  tok.style.transform = `translate(${x0}px,${y0}px) scale(${s0})`;
  const run = () => {
    const sp = new Spring(0, { response: 0.62, damping: 0.86, rest: 0.002, onUpdate: (p) => {
      const q = clamp(p, 0, 1.08);
      const x = (1 - q) * (1 - q) * x0 + 2 * (1 - q) * q * cx + q * q * x1;
      const y = (1 - q) * (1 - q) * y0 + 2 * (1 - q) * q * cy + q * q * y1;
      tok.style.transform = `translate(${x}px,${y}px) scale(${lerp(s0, 1, clamp(p, 0, 1))})`;
      tok.style.opacity = String(clamp(p * 5, 0, 1));
    }, onRest: () => { tok.remove(); onLand?.(); } });
    sp.to(1);
  };
  delay ? setTimeout(run, delay) : run();
}
function liftOff(slotEl) {
  if (RM.matches || !slotEl) return;
  const r = $('.s-icon', slotEl).getBoundingClientRect();
  const tok = document.createElement('div');
  tok.className = 'token';
  tok.innerHTML = sil(slotEl.dataset.code, 'ink');
  document.body.appendChild(tok);
  const sp = new Spring(0, { response: 0.6, damping: 1, rest: 0.002, onUpdate: (p) => {
    tok.style.transform = `translate(${r.left}px,${r.top - p * 26}px) scale(${1 + p * 0.12})`;
    tok.style.opacity = String(1 - p); tok.style.filter = `blur(${p * 3}px)`;
  }, onRest: () => tok.remove() });
  sp.to(1);
}
function landSlot(code) {
  const b = $(`.slot[data-code="${code}"]`); if (!b) return;
  b.dataset.hold = '';
  const icon = $('.s-icon', b);
  icon.innerHTML = sil(code, 'ink');
  b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash');
  if (!RM.matches) {
    const sp = new Spring(0.86, { response: 0.4, damping: 0.55, rest: 0.002, onUpdate: (s) => { icon.style.transform = `scale(${s})`; } });
    sp.to(1);
  }
}
function boxRectFor(code) {
  const box = $(`#boxes .box[data-m="${code}"]`);
  if (box && S.boxes) return box.getBoundingClientRect();
  const ev = S.prev; if (!ev) return null;
  const cams = ev.det[code] || [];
  const tile = cams.length ? $(`.tile[data-cam="${cams[0].cam}"]`) : null;
  return tile ? tile.getBoundingClientRect() : null;
}

/* ── Main render loop ──────────────────────────────────── */
function render({ animate = false, boot = false } = {}) {
  const ev = evaluate(S.t);
  const prev = S.prev;
  renderTime(ev);
  renderVerdict(ev, animate && !boot);
  renderFrame(ev);
  renderStrip(ev);
  renderRecon(ev, { boot });
  // transitions between successive moments
  const births = [];
  if (prev && animate && prev.stage?.n === ev.stage?.n) {
    for (const s of ev.slots) {
      const p = prev.slots.find((x) => x.code === s.code);
      if (!p) continue;
      if (s.state === 'seen' && p.state !== 'seen') {
        const b = $(`.slot[data-code="${s.code}"]`);
        if (b) { b.dataset.hold = '1'; $('.s-icon', b).innerHTML = sil(s.code, 'ghost'); }
        requestAnimationFrame(() => flyToken(s.code, boxRectFor(s.code), $(`.slot[data-code="${s.code}"] .s-icon`), { onLand: () => landSlot(s.code) }));
      } else if (p.state === 'seen' && s.state !== 'seen') liftOff($(`.slot[data-code="${s.code}"]`));
    }
    for (const e of ev.events) if (e.pending && !prev.events.some((x) => x.id === e.id)) births.push(e.id);
  }
  renderQueue(ev, { births });
  renderDock(ev);
  if (births.length) pulseTicks(births);
  S.prev = ev;
  updateJump();
}
function pulseTicks(ids) {
  for (const id of ids) {
    const m = $(`.d-ev[data-id="${id}"]`); if (!m || RM.matches) continue;
    const sp = new Spring(0, { response: 0.45, damping: 0.5, rest: 0.002, onUpdate: (s) => { m.style.transform = `rotate(45deg) scale(${s})`; } });
    sp.to(1);
  }
}
function renderTime(ev) {
  const pill = $('#timePill');
  pill.dataset.live = String(S.live);
  $('#timeMode').textContent = S.live ? 'Сейчас' : S.replaying ? 'Повтор' : 'Запись';
  $('#timeVal').textContent = hhmmss(ev.t);
  $('#timeDate').textContent = fmtDay(scnDate());
}
function renderAll({ boot = false } = {}) {
  frameKeyShown = ''; lastVerdictKey = '';
  $('#recon').dataset.k = ''; $('#strip').dataset.built = ''; $('#queue').dataset.built = ''; $('#day').dataset.k = ''; $('#dockLead').dataset.k = '';
  $('#qList')?.removeAttribute('data-ids');
  const setup = !!S.scn.setup;
  $('#setup').hidden = !setup;
  $('#work').style.visibility = setup ? 'hidden' : '';
  $('#verdict').style.visibility = setup ? 'hidden' : '';
  $('#ctxZone').style.visibility = setup ? 'hidden' : '';
  $('.bar .slash').style.visibility = setup ? 'hidden' : '';
  $('#objName').textContent = setup ? 'Новый объект · корпус 3' : 'Многоквартирный жилой дом · корпус 2';
  if (setup) renderSetup();
  buildPlan();
  if (boot && !setup && !RM.matches) bootSequence();
  else render();
}

/* Boot: the drawing draws itself, then the observed machines land on it */
function bootSequence() {
  S.booting = true;
  const ev = evaluate(S.t);
  S.prev = ev; // ticks during boot compare against the real state, so flights are not repeated
  renderTime(ev);
  renderVerdict(ev, false);
  renderFrame(ev); renderStrip(ev);
  renderRecon(ev, { boot: true });
  for (const s of ev.slots) if (s.state === 'seen') { const b = $(`.slot[data-code="${s.code}"]`); b.dataset.hold = '1'; $('.s-icon', b).innerHTML = sil(s.code, 'ghost draw', `style="--d:${ev.slots.indexOf(s) * 90}ms"`); b.dataset.state = 'waiting'; $('.s-state', b).textContent = 'ищем на кадрах…'; }
  renderQueue(ev); renderDock(ev);
  S.booting = false;
  const vt = $('.v-text'), vg = $('#vGlyph');
  const sp = new Spring(0, { response: 0.6, damping: 1, rest: 0.002, onUpdate: (p) => { vt.style.opacity = String(p); vt.style.transform = p < 1 ? `translateY(${(1 - p) * 10}px)` : ''; vg.style.transform = p < 1 ? `scale(${0.7 + 0.3 * p})` : ''; vg.style.opacity = String(p); } });
  sp.set(0); sp.to(1);
  const seen = ev.slots.filter((s) => s.state === 'seen');
  const land = (code) => { landSlot(code); render(); };
  const wait = () => new Promise((r) => (document.readyState === 'complete' ? r() : addEventListener('load', r, { once: true })));
  wait().then(() => setTimeout(() => {
    seen.forEach((s, i) => flyToken(s.code, boxRectFor(s.code), $(`.slot[data-code="${s.code}"] .s-icon`), { delay: i * 160, onLand: () => land(s.code) }));
  }, 650));
  // whatever happens to frames, the slots end up in their true state
  setTimeout(() => { for (const s of seen) { const b = $(`.slot[data-code="${s.code}"]`); if (b?.dataset.hold === '1') land(s.code); } }, 3200);
}

/* ── Time: live clock, scrubbing, replay ──────────────── */
setInterval(() => {
  if (S.scn.setup) return;
  S.now += 1;
  if (S.live && !S.replaying) { S.t = S.now; render({ animate: true }); }
  else renderDayNowMark();
}, 1000);
function renderDayNowMark() {
  const day = $('#day'); const w = day.clientWidth; const m = $('.d-nowmark', day); if (m) m.style.left = tToX(S.now, w) + 'px';
  const rec = $('.d-rec', day); if (rec) rec.style.width = (tToX(S.now, w) - tToX(S.settings.shiftFrom, w)) + 'px';
}
function setTime(t, { animate = false } = {}) {
  S.t = clamp(t, DAY_FROM, S.now);
  S.live = S.t >= S.now - 0.5;
  if (S.live) S.t = S.now;
  render({ animate });
}
const timeSpring = new Spring(0, { response: 0.4, damping: 1, rest: 0.4, onUpdate: (t) => setTime(t) });
function goLive() {
  S.replaying = false;
  if (RM.matches) { setTime(S.now); return; }
  timeSpring.set(S.t);
  timeSpring.to(S.now, { onRest: () => setTime(S.now) });
}
let replayRaf = 0;
function replay() {
  if (S.scn.setup) return;
  cancelAnimationFrame(replayRaf);
  timeSpring.stop();
  closeAll();
  S.replaying = true; S.live = false;
  const from = S.scn.replayFrom, wall0 = performance.now();
  S.t = from; S.prev = null; render();
  // time follows the wall clock (×60); frames only repaint, so a throttled tab still finishes the replay
  const step = () => {
    if (!S.replaying) { clearInterval(replay.iv); return; }
    S.t = Math.min(S.now, from + ((performance.now() - wall0) / 1000) * 60);
    if (S.t >= S.now) { S.replaying = false; clearInterval(replay.iv); S.live = true; S.t = S.now; render({ animate: true }); return; }
    render({ animate: true });
  };
  const loop = () => { step(); if (S.replaying) replayRaf = requestAnimationFrame(loop); };
  replayRaf = requestAnimationFrame(loop);
  clearInterval(replay.iv); replay.iv = setInterval(step, 250);
}
function bindDay() {
  const day = $('#day');
  let drag = null;
  const vt = new Velocity();
  day.addEventListener('pointerdown', (e) => {
    if (S.scn.setup) return;
    S.replaying = false; timeSpring.stop();
    try { day.setPointerCapture(e.pointerId); } catch {}
    const r = day.getBoundingClientRect();
    drag = { r }; vt.s = []; vt.add(e.clientX, 0);
    // respond on press: playhead jumps under the finger immediately
    setTime(xToT(clamp(e.clientX - r.left, 0, r.width), r.width));
  });
  day.addEventListener('pointermove', (e) => {
    if (!drag) return;
    vt.add(e.clientX, 0);
    const { r } = drag;
    let x = e.clientX - r.left;
    const maxX = tToX(S.now, r.width);
    if (x > maxX) x = maxX + rubber(x - maxX, r.width * 0.3);
    if (x < 0) x = -rubber(-x, r.width * 0.3);
    setTime(xToT(clamp(x, 0, maxX), r.width));
  });
  const end = () => {
    if (!drag) return;
    const { r } = drag; drag = null;
    const vx = vt.get().x;
    const secPerPx = (DAY_TO - DAY_FROM) / r.width;
    const xNow = tToX(S.t, r.width);
    const xProj = xNow + project(vx, 0.99);
    // magnet: events and "now" pull the projected landing point
    const cands = [S.now, ...S.events.map((ev) => ev.born)].map((t) => ({ t, x: tToX(t, r.width) }));
    let target = xToT(clamp(xProj, 0, tToX(S.now, r.width)), r.width);
    const near = cands.reduce((a, c) => (Math.abs(c.x - xProj) < Math.abs(a.x - xProj) ? c : a), cands[0]);
    if (Math.abs(near.x - xProj) < 18) target = near.t;
    if (Math.abs(vx) < 40 && target !== near.t) return;
    timeSpring.set(S.t);
    timeSpring.to(target, { velocity: vx * secPerPx, onRest: () => setTime(target) });
  };
  day.addEventListener('pointerup', end);
  day.addEventListener('pointercancel', end);
  day.addEventListener('keydown', (e) => {
    const stepS = e.shiftKey ? 600 : 60;
    if (e.key === 'ArrowLeft') { e.preventDefault(); setTime(S.t - stepS); }
    if (e.key === 'ArrowRight') { e.preventDefault(); setTime(S.t + stepS); }
    if (e.key === 'End') { e.preventDefault(); goLive(); }
  });
}

/* ── Dock drag ─────────────────────────────────────────── */
function bindDock() {
  const grip = $('#grip');
  const dock = $('#dock');
  let drag = null; const vt = new Velocity();
  const start = (e) => {
    if (e.button) return;
    dockSpring.stop();
    drag = { y: e.clientY, h: dock.getBoundingClientRect().height, moved: false };
    vt.s = []; vt.add(0, e.clientY);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
    dock.classList.add('dragging');
  };
  const move = (e) => {
    if (!drag) return;
    vt.add(0, e.clientY);
    const dy = drag.y - e.clientY;
    if (Math.abs(dy) > 4) drag.moved = true;
    const { min, max } = dockLimits();
    let h = drag.h + dy;
    if (h > max) h = max + rubber(h - max, innerHeight);
    if (h < min) h = min - rubber(min - h, 200);
    dockSpring.set(h);
  };
  const end = () => {
    if (!drag) return;
    dock.classList.remove('dragging');
    const moved = drag.moved; drag = null;
    if (!moved) { setDock(!S.dockOpen); return; }
    const v = -vt.get().y;
    const { min, max } = dockLimits();
    const proj = dockSpring.x + project(v, 0.99);
    setDock(Math.abs(proj - max) < Math.abs(proj - min), v);
  };
  for (const el of [grip, $('#planCanvas')]) {
    el.addEventListener('pointerdown', start);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }
  grip.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDock(!S.dockOpen); } });
}

/* ── Swipe to decide ───────────────────────────────────── */
function bindSwipe(item) {
  const card = $('.q-card', item);
  const under = $('.q-under', item);
  let st = null; const vt = new Velocity();
  const x = new Spring(0, { response: 0.38, damping: 0.86, rest: 0.4, onUpdate: (v) => paint(v) });
  function paint(v) {
    card.style.transform = v ? `translateX(${v}px)` : '';
    const w = item.clientWidth;
    const k = clamp(Math.abs(v) / (w * 0.42), 0, 1);
    const right = v > 0;
    const sev = card.dataset.sev;
    under.style.background = right ? (sev === 'err' ? `rgba(255,90,85,${0.18 + 0.5 * k})` : `rgba(255,143,63,${0.18 + 0.5 * k})`) : `rgba(236,232,224,${0.06 + 0.12 * k})`;
    $('.u-confirm', under).style.opacity = right ? String(k) : '0';
    $('.u-false', under).style.opacity = !right ? String(k) : '0';
    $('.u-confirm', under).style.transform = `translateX(${(1 - k) * -10}px)`;
    $('.u-false', under).style.transform = `translateX(${(1 - k) * 10}px)`;
  }
  card.addEventListener('pointerdown', (e) => {
    if (e.button) return;
    x.stop();
    st = { x0: e.clientX, y0: e.clientY, base: x.x, lock: null, id: e.pointerId };
    vt.s = []; vt.add(e.clientX, e.clientY);
  });
  card.addEventListener('pointermove', (e) => {
    if (!st) return;
    vt.add(e.clientX, e.clientY);
    const dx = e.clientX - st.x0, dy = e.clientY - st.y0;
    if (!st.lock) {
      // hysteresis: commit to a direction only after ~10px
      if (Math.hypot(dx, dy) < 10) return;
      st.lock = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (st.lock === 'x') try { card.setPointerCapture(st.id); } catch {}
    }
    if (st.lock !== 'x') return;
    e.preventDefault();
    x.set(st.base + dx);
  });
  const end = () => {
    if (!st) return;
    const wasX = st.lock === 'x'; st = null;
    if (!wasX) return;
    card.dataset.swiped = '1'; setTimeout(() => { card.dataset.swiped = ''; }, 50);
    const v = vt.get().x;
    const w = item.clientWidth;
    const proj = x.x + project(v, 0.99);
    const id = item.dataset.id;
    if (proj > w * 0.45) { x.to(w + 40, { velocity: v, damping: 1, onRest: () => decide(id, 'confirmed', { from: 'swipe', dir: 1 }) }); }
    else if (proj < -w * 0.45) { x.to(-w - 40, { velocity: v, damping: 1, onRest: () => decide(id, 'false', { from: 'swipe', dir: -1 }) }); }
    else x.to(0, { velocity: v, damping: 0.75 });
  };
  card.addEventListener('pointerup', end);
  card.addEventListener('pointercancel', end);
}

/* ── Decisions + undo ──────────────────────────────────── */
let lastDecision = null;
function decide(id, status, { from = 'case', dir = 0, note = '' } = {}) {
  const e = S.events.find((x) => x.id === id); if (!e) return;
  lastDecision = { id, prev: { status: e.status, decidedAt: e.decidedAt, note: e.note }, dir };
  e.status = status; e.decidedAt = S.now; if (note) e.note = note;
  const item = $(`.q-item[data-id="${id}"]`);
  const finish = () => { render(); };
  if (item && from === 'swipe' && !RM.matches) {
    const h = item.getBoundingClientRect().height;
    const sp = new Spring(1, { response: 0.32, damping: 1, rest: 0.002, onUpdate: (p) => { item.style.height = h * p + 'px'; item.style.marginBottom = (p - 1) * 6 + 'px'; } , onRest: () => { item.remove(); $('#qList').dataset.ids = ''; finish(); } });
    item.style.overflow = 'hidden'; sp.to(0);
  } else finish();
  const words = { confirmed: 'Отклонение подтверждено', false: 'Отмечено как ложное', later: 'Отложено до конца смены' };
  showToast(`${words[status]} · ${id}`, { undo: true });
}
function undo() {
  if (!lastDecision) return;
  const e = S.events.find((x) => x.id === lastDecision.id);
  Object.assign(e, lastDecision.prev);
  const dir = lastDecision.dir; lastDecision = null;
  $('#qList').dataset.ids = '';
  render();
  // the card comes back from the side it was thrown to
  const item = $(`.q-item[data-id="${e.id}"]`);
  if (item && !RM.matches) {
    const card = $('.q-card', item); const w = item.clientWidth;
    const sp = new Spring((dir || 1) * (w + 40), { response: 0.45, damping: 0.85, onUpdate: (v) => { card.style.transform = v ? `translateX(${v}px)` : ''; } });
    sp.to(0);
  }
  hideToast();
}
let toastTm = 0;
const toastSpring = new Spring(0, { response: 0.42, damping: 0.86, rest: 0.002, onUpdate: (p) => { const t = $('#toast'); t.style.transform = `translateX(-50%) translateY(${(1 - p) * 24}px) scale(${0.96 + 0.04 * p})`; t.style.opacity = String(p); if (p < 0.01 && toastSpring.target === 0) t.hidden = true; } });
function showToast(text, { undo: u = false } = {}) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(text)}</span>${u ? '<button type="button" class="btn small" data-act="undo">Отменить</button>' : ''}<i class="t-bar"></i>`;
  t.hidden = false;
  toastSpring.to(1);
  const bar = $('.t-bar', t); const dur = u ? 6000 : 3200;
  bar.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], { duration: dur, easing: 'linear', fill: 'forwards' });
  clearTimeout(toastTm); toastTm = setTimeout(hideToast, dur);
}
function hideToast() { clearTimeout(toastTm); toastSpring.to(0); if (!RM.matches) return; $('#toast').hidden = true; }

/* ── Case file (разбор события) ───────────────────────── */
let caseState = null;
const caseSpring = new Spring(0, { response: 0.5, damping: 0.9, rest: 0.002, onUpdate: (p) => paintCase(p) });
function caseRect() {
  if (MOBILE.matches) return { left: 0, top: 0, width: innerWidth, height: innerHeight };
  const work = $('#work').getBoundingClientRect();
  const bar = 56 + 8;
  const gut = 20;
  return { left: gut, top: bar, width: innerWidth - gut * 2, height: innerHeight - bar - parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dock-min')) - 10, _w: work };
}
function paintCase(p) {
  const c = $('#case'); if (!caseState) return;
  const R = caseState.rect, o = caseState.origin;
  const q = clamp(p, 0, 1.04);
  // clip from the card's rectangle to the full panel: the panel grows out of the event that opened it
  const top = lerp(o.top - R.top, 0, q), left = lerp(o.left - R.left, 0, q);
  const right = lerp(R.left + R.width - (o.left + o.width), 0, q), bottom = lerp(R.top + R.height - (o.top + o.height), 0, q);
  const rad = lerp(7, MOBILE.matches ? 0 : 12, clamp(q, 0, 1));
  c.style.clipPath = `inset(${top}px ${right}px ${bottom}px ${left}px round ${rad}px)`;
  const scrim = $('#scrim'); scrim.style.opacity = String(clamp(p, 0, 1));
  const inner = clamp((p - 0.35) / 0.5, 0, 1);
  $$('.case-body, .case-ev', c).forEach((n) => { n.style.opacity = String(inner); });
  if (p <= 0.001 && caseState.closing) { c.hidden = true; scrim.dataset.on = 'false'; caseState?.returnFocus?.focus?.({ preventScroll: true }); caseState = null; }
}
function openCase(id, originEl) {
  const e = S.events.find((x) => x.id === id); if (!e) return;
  closePop(); closeMenu();
  const c = $('#case');
  const ev = evaluate(S.t);
  const ee = ev.events.find((x) => x.id === id) || { ...e, dur: (e.to ?? S.t) - e.from, sevNow: e.sev, pending: true };
  const R = caseRect();
  Object.assign(c.style, { left: R.left + 'px', top: R.top + 'px', width: R.width + 'px', height: R.height + 'px' });
  const o = (originEl || $(`.q-card[data-id="${id}"]`) || $('#vActions'))?.getBoundingClientRect() || { left: R.left + R.width / 2, top: R.top + R.height / 2, width: 1, height: 1 };
  caseState = { id, rect: R, origin: o, returnFocus: document.activeElement, cam: 'c1' };
  c.innerHTML = caseHTML(ee, ev);
  c.hidden = false;
  $('#scrim').dataset.on = 'true';
  wireCase(ee);
  if (RM.matches) { caseSpring.set(1); } else { caseSpring.set(caseSpring.x < 0.05 ? 0 : caseSpring.x); caseSpring.to(1); }
  // reasoning chain draws in order
  if (!RM.matches) $$('.step', c).forEach((s, i) => s.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 420, delay: 260 + i * 80, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'backwards' }));
  setTimeout(() => $('#caseTitle')?.focus({ preventScroll: true }), 60);
}
function closeCase() {
  if (!caseState) return;
  const card = $(`.q-card[data-id="${caseState.id}"]`);
  if (card) caseState.origin = card.getBoundingClientRect();
  else { const r = caseState.rect; caseState.origin = { left: r.left + r.width - 60, top: r.top + 40, width: 40, height: 40 }; }
  caseState.closing = true;
  caseSpring.to(0, { damping: 1 });
}
function evidenceFor(e) {
  const t = e.born;
  return CAMS.map((c) => ({ ...c, off: camOff(c.id, t), img: frameKey(c.id, camFrameTime(c.id, t)), at: camFrameTime(c.id, t) }));
}
function caseHTML(e, ev) {
  const st = ev.stage;
  const r = e.code && st ? ruleFor(st.n, e.code) : null;
  const evd = evidenceFor(e);
  const main = evd.find((x) => !x.off) || evd[0];
  const sev = e.sevNow || e.sev;
  const day = st ? Math.round((scnDate() - st.s) / dayMs) + 1 : 0;
  let steps = [];
  if (e.kind === 'missing') {
    const ls = e.from;
    const neverToday = intervals(e.code).length === 0;
    const frames = Math.round((e.dur / 2) * evd.filter((c) => !camOff(c.id, ev.t)).length);
    const others = ev.slots.filter((s) => s.state === 'seen' && s.code !== e.code);
    steps = [
      { tone: 'plan', h: 'План', p: `${fmtDay(scnDate())} идёт этап ${st.n} «${esc(st.name)}» <span class="dim">(${fmtDay(st.s)} – ${fmtDay(st.e)}, день ${day} из ${st.days})</span>.`, src: '<button type="button" class="link" data-act="plan">Открыть план</button>' },
      { tone: 'plan', h: 'Правило', p: `${M[e.code].name} — ${LV[r.lvl].label.toLowerCase()} техника этапа${r.edited ? ' <span class="dim">(изменено)</span>' : ''}. Предупреждение через ${durShort(r.warnAfter)} без наблюдения, отклонение через ${durShort(r.errAfter)}.`, src: `<span>Справочник: ${esc(st.catalog || 'проекта')} · ${Math.round(r.p * 100)}%</span>${st.src ? `<a class="link" href="${st.src}" target="_blank" rel="noopener">${st.srcLabel} ↗</a>` : ''}<button type="button" class="link" data-act="rule" data-code="${e.code}">Настроить</button>` },
      { tone: sev, h: 'Наблюдение', p: `${neverToday ? `За смену ${M[e.code].lower} ни разу не замечен. С окончания сбора техники в ${hhmm(ls)}` : `С ${hhmmss(ls)}`} ${neverToday ? 'его нет' : `${M[e.code].lower} не найден`} ни на одной камере: 0 из ~${frames} проверенных кадров.${others.length ? ` При этом ${others.map((s) => `${M[s.code].lower} замечен (${s.cams.length > 1 ? 'камеры' : 'камера'} ${s.cams.map((c) => CAMS.find((x) => x.id === c.cam).n).join(', ')}, уверенность ${Math.min(...s.cams.map((c) => c.c)).toFixed(2).replace('.', ',')}–${Math.max(...s.cams.map((c) => c.c)).toFixed(2).replace('.', ',')})`).join('; ')}.` : ''}`, last: !neverToday && e.code === 'dump_truck' ? { img: IMG['cam1-truck'], text: `Последний раз замечен в ${hhmmss(ls)} · камера 1` } : null },
      e.limited || evd.some((c) => c.off)
        ? { tone: 'warn', h: 'Качество данных', p: `Работают ${evd.filter((c) => !c.off).length} из ${evd.length} камер: «${evd.filter((c) => c.off).map((c) => c.name).join('», «')}» без сигнала с ${hhmm(S.scn.off.c3)}. Часть котлована не видна, поэтому вывод ограничен.` }
        : { tone: 'ok', h: 'Качество данных', p: `Все ${evd.length} камеры дают свежие кадры (не старше 4 с). Распознавание работает, порог уверенности ${S.settings.conf}%.` },
      { tone: sev, h: 'Вывод', p: sev === 'err' ? `Отклонение: ${M[e.code].lower} отсутствует дольше ${durShort(r.errAfter)}.` : `Предупреждение. ${e.ongoing ? `Станет отклонением через ${durShort(Math.max(0, r.errAfter - e.dur))}, если ${M[e.code].lower} не появится.` : 'Ситуация завершилась.'}` },
    ];
  } else if (e.kind === 'oop') {
    const inf = PLAN.find((p) => p.n === S.scn.infer?.stage);
    steps = [
      { tone: 'plan', h: 'План', p: `${fmtDay(scnDate())} идёт этап ${st.n} «${esc(st.name)}» <span class="dim">(с ${fmtDay(st.s)}, день ${day} из ${st.days})</span>.` },
      { tone: 'plan', h: 'Правило', p: `${e.codes.map((c) => `${M[c].name} — ${Math.round(ruleFor(st.n, c).p * 100)}%`).join(', ')}: для этого этапа не характерны (порог 20%).`, src: `<span>Справочник: ${esc(st.catalog)}</span><a class="link" href="${st.src}" target="_blank" rel="noopener">${st.srcLabel} ↗</a>` },
      { tone: 'err', h: 'Наблюдение', p: `С ${hhmm(e.from)} оба замечены на камерах 1 и 3, суммарно ${durShort(e.dur)}. Бетононасос за смену не замечен.` },
      { tone: 'ok', h: 'Качество данных', p: 'Все 3 камеры дают свежие кадры. Распознавание работает.' },
      { tone: 'err', h: 'Вывод', p: `Отклонение от плана. Набор техники соответствует этапу ${inf.n} «${esc(inf.name)}», который по плану закончился ${fmtDay(inf.e)}. Возможно отставание на ${S.scn.infer.days} дня или график не обновлён.` },
    ];
  } else if (e.kind === 'camera') {
    const cam = CAMS.find((c) => c.id === e.cam);
    steps = [
      { tone: 'warn', h: 'Источник', p: `Камера ${cam.n} «${esc(cam.name)}» не присылает кадры с ${hhmmss(e.from)}. Последний кадр сохранён.` },
      { tone: 'plan', h: 'Что это значит', p: 'Пока сигнала нет, для зоны камеры система не делает выводов об отсутствии техники. Остальные камеры продолжают сверку.' },
      { tone: 'ok', h: 'Что сделать', p: 'Проверьте питание и сетевое подключение камеры. Связь проверяется каждые 10 секунд.', src: '<button type="button" class="link" data-act="settings:sources">Источники</button>' },
    ];
  }
  const decided = !e.pending;
  return `
    <div class="case-ev">
      <div class="ev-main" id="evMain"><img id="evImg" src="${IMG[main.img]}" alt="Кадр камеры ${main.n} в ${hhmmss(main.at)}"><div class="boxes" id="evBoxes"></div><div class="ticks"></div>
        <div class="ev-cap"><span class="chip-mat" id="evCap">Камера ${main.n} · ${hhmmss(main.at)}</span><span class="chip-mat rec"><i class="dot"></i>В отчёт идёт этот кадр</span></div></div>
      <div class="ev-strip">${evd.map((c) => `<button type="button" data-cam="${c.id}" aria-pressed="${c.id === main.id}"><img src="${IMG[c.img]}" alt="" style="${c.off ? 'filter:saturate(.2) brightness(.7)' : ''}"><span>${c.n} · ${c.off ? 'нет сигнала' : hhmmss(c.at)}</span></button>`).join('')}</div>
    </div>
    <div class="case-body">
      <div class="case-top"><span class="sev-tag" data-sev="${sev}">${SEV_ICON[sev] || ''}${sevWord[sev]} · ${e.id} · Котлован · ${hhmm(e.born)}</span><button type="button" class="close-x" data-act="close-case" aria-label="Закрыть"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></div>
      <div><h2 id="caseTitle" tabindex="-1">${esc(e.kind === 'oop' ? `${eventTitle(e)} «${st.name}»` : eventTitle(e, true))}</h2><p class="lead">${e.kind === 'missing' ? esc(CONSEQ[e.code] || '') : e.kind === 'oop' ? 'Техника на площадке не соответствует текущему этапу плана.' : 'Зона камеры временно не контролируется.'}</p></div>
      <div><span class="kicker">Как система пришла к выводу</span>
        <div class="chain">${steps.map((s, i) => `<div class="step" data-tone="${s.tone}"><span class="n">${i + 1}</span><div><h4>${s.h}</h4><p>${s.p}</p>${s.src ? `<div class="src">${s.src}</div>` : ''}${s.last ? `<div class="last-seen"><img src="${s.last.img}" alt="">${s.last.text}</div>` : ''}</div></div>`).join('')}</div></div>
      <div class="decide">${decided ? `<div class="save-state" data-s="saved">Решение принято: ${{ confirmed: 'подтверждено', false: 'ложное срабатывание', later: 'отложено', auto: 'закрыто системой' }[e.status]}${e.note ? ` · ${esc(e.note)}` : ''}</div>` : `
        <textarea id="caseNote" placeholder="Комментарий для журнала, необязательно" aria-label="Комментарий"></textarea>
        <div class="decide-row">
          <button type="button" class="btn primary" data-decide="confirmed">Подтвердить <kbd>1</kbd></button>
          <button type="button" class="btn" data-decide="false">Ложное <kbd>2</kbd></button>
          <button type="button" class="btn ghost" data-decide="later">Отложить <kbd>3</kbd></button>
        </div>
        <div class="save-state" id="saveState">Решение сохранится в журнале с вашим именем и временем.</div>`}
      </div>
    </div>`;
}
function wireCase(e) {
  const c = $('#case');
  const show = (camId) => {
    const evd = evidenceFor(e); const cam = evd.find((x) => x.id === camId);
    $('#evImg', c).src = IMG[cam.img];
    $('#evCap', c).textContent = `Камера ${cam.n} · ${cam.off ? 'нет сигнала, последний кадр ' : ''}${hhmmss(cam.at)}`;
    $$('.ev-strip button', c).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.cam === camId)));
    const st = stageForDate(scnDate());
    $('#evBoxes', c).innerHTML = (cam.off || !evaluate(e.born).model ? [] : BOXES[cam.img].filter((b) => presentAt(b.code, e.born))).map((b) => {
      const r = st ? ruleFor(st.n, b.code) : { lvl: 'ok' };
      return `<div class="box ${r.lvl === 'no' ? 'oop' : r.lvl === 'skip' ? 'stationary' : ''}${b.y < 0.08 ? ' lbl-in' : ''}" style="left:${b.x * 100}%;top:${b.y * 100}%;width:${b.w * 100}%;height:${b.h * 100}%"><b>${M[b.code].name}<i>${b.c.toFixed(2).replace('.', ',')}</i></b></div>`;
    }).join('');
  };
  show((evidenceFor(e).find((x) => !x.off) || { id: 'c1' }).id);
  $$('.ev-strip button', c).forEach((b) => b.addEventListener('click', () => show(b.dataset.cam)));
  $$('[data-decide]', c).forEach((b) => b.addEventListener('click', () => commitCase(b.dataset.decide)));
}
function commitCase(status) {
  if (!caseState) return;
  const id = caseState.id;
  const s = $('#saveState'); if (!s) return;
  $$('[data-decide]').forEach((b) => (b.disabled = true));
  s.dataset.s = 'saving'; s.textContent = 'Сохраняем…';
  const note = $('#caseNote')?.value.trim();
  setTimeout(() => {
    s.dataset.s = 'saved'; s.textContent = `Сохранено в журнале · ${hhmm(S.now)}`;
    setTimeout(() => { closeCase(); setTimeout(() => decide(id, status, { note }), RM.matches ? 0 : 280); }, 520);
  }, 620);
}

/* ── Rule editor popover ───────────────────────────────── */
let popState = null;
const popSpring = new Spring(0, { response: 0.4, damping: 0.92, rest: 0.002, onUpdate: (p) => paintPop(p) });
function paintPop(p) {
  const pop = $('#pop'); if (!popState) return;
  const q = clamp(p, 0, 1.03);
  pop.style.opacity = String(clamp(p * 1.4, 0, 1));
  pop.style.transform = `translateX(${(1 - q) * popState.dx}px) translateY(${(1 - q) * popState.dy}px) scale(${lerp(0.9, 1, q)})`;
  pop.style.filter = p < 0.99 ? `blur(${(1 - clamp(p, 0, 1)) * 8}px)` : '';
  if (p <= 0.001 && popState.closing) { pop.hidden = true; popState.anchor?.focus?.({ preventScroll: true }); popState = null; }
}
function openRule(code, anchor, stageN) {
  const st = PLAN.find((p) => p.n === (stageN || stageForDate(scnDate())?.n));
  if (!st) return;
  closeMenu();
  const pop = $('#pop');
  const r = ruleFor(st.n, code);
  popState = { code, stage: st.n, anchor, draft: { lvl: r.lvl, warnAfter: r.warnAfter, errAfter: r.errAfter, oopAfter: r.oopAfter } };
  pop.innerHTML = popHTML();
  pop.hidden = false;
  const ar = anchor.getBoundingClientRect();
  const pw = Math.min(380, innerWidth - 32);
  let left, top, dx = 0, dy = 0;
  if (MOBILE.matches) { left = 16; top = Math.max(16, innerHeight - pop.offsetHeight - 16); pop.style.transformOrigin = '50% 100%'; dy = 30; }
  else {
    const inDock = anchor.closest('.dock');
    left = inDock ? ar.left - pw - 14 : ar.left - pw - 14;
    if (left < 16) left = Math.min(innerWidth - pw - 16, ar.right + 14);
    top = clamp(ar.top + ar.height / 2 - pop.offsetHeight / 2, 64, innerHeight - pop.offsetHeight - 16);
    pop.style.transformOrigin = `${left < ar.left ? '100%' : '0%'} ${clamp(ar.top + ar.height / 2 - top, 0, pop.offsetHeight)}px`;
    dx = left < ar.left ? 14 : -14;
  }
  Object.assign(pop.style, { left: left + 'px', top: top + 'px' });
  popState.dx = dx; popState.dy = dy;
  wirePop();
  popSpring.set(0); popSpring.to(1);
  setTimeout(() => $('.seg button[aria-checked="true"]', pop)?.focus({ preventScroll: true }), 30);
}
function impactCount(code, d) {
  // how many events this rule would have produced today up to now
  if (d.lvl === 'req') {
    let n = 0; let cursor = S.settings.shiftFrom + S.settings.startGrace;
    const iv = [...intervals(code)].sort((a, b) => a[0] - b[0]);
    for (const [a, b] of iv) { if (a > cursor && a - cursor >= d.warnAfter) n++; cursor = Math.max(cursor, b); }
    if (S.now > cursor && S.now - cursor >= d.warnAfter) n++;
    return n;
  }
  if (d.lvl === 'no') return intervals(code).filter(([a, b]) => Math.min(b, S.now) - a >= d.oopAfter).length;
  return 0;
}
function popHTML() {
  const { code, stage, draft } = popState;
  const st = PLAN.find((p) => p.n === stage);
  const r = ruleFor(stage, code);
  const cur = impactCount(code, { lvl: r.lvl, warnAfter: r.warnAfter, oopAfter: r.oopAfter });
  const nxt = impactCount(code, draft);
  const lvls = LV_ORDER;
  const expl = {
    req: 'Отсутствие создаёт предупреждение, затем отклонение.',
    rec: 'Отмечается на карточке этапа, событий не создаёт.',
    ok: 'Может быть на площадке, в сверке не участвует.',
    no: 'Появление на площадке создаёт отклонение.',
    skip: 'Не участвует в сверке. Подходит для стационарной техники: башенного крана, бытовок.',
  }[draft.lvl];
  return `<h3 id="popTitle">${sil(code, 'ghost')}${M[code].name}</h3>
    <div class="meta">Этап ${st.n} · ${esc(st.name)}</div>
    <div class="field"><span class="lbl" id="segLbl">Требование на этом этапе</span>
      <div class="seg" role="radiogroup" aria-labelledby="segLbl"><i class="pill"></i>${lvls.map((l) => `<button type="button" role="radio" aria-checked="${draft.lvl === l}" data-lvl="${l}">${l === 'skip' ? 'Не учитывать' : LV[l].label}</button>`).join('')}</div>
      <div class="src-line" id="lvlExpl">${expl}</div></div>
    ${draft.lvl === 'req' ? `<div class="field two">
      <div><span class="lbl">Предупредить через</span><div class="stepper" data-k="warnAfter"><button type="button" aria-label="Меньше">−</button><output>${durShort(draft.warnAfter)}</output><button type="button" aria-label="Больше">+</button></div></div>
      <div><span class="lbl">Отклонение через</span><div class="stepper" data-k="errAfter"><button type="button" aria-label="Меньше">−</button><output>${durShort(draft.errAfter)}</output><button type="button" aria-label="Больше">+</button></div></div></div>` : ''}
    ${draft.lvl === 'no' ? `<div class="field"><span class="lbl">Отклонение, если замечен дольше</span><div class="stepper" data-k="oopAfter"><button type="button" aria-label="Меньше">−</button><output>${durShort(draft.oopAfter)}</output><button type="button" aria-label="Больше">+</button></div></div>` : ''}
    <div class="impact">Сегодня по этому правилу: <b>${cur} ${plural(cur, 'событие', 'события', 'событий')}</b>. С новыми настройками было бы: <span class="roll" id="impactN">${nxt}</span>.<small>Уже созданные события не изменятся. Новое правило действует с ${hhmm(S.now)}.</small></div>
    <div class="src-line">По справочнику: ${LV[r.base].label.toLowerCase()}, ${Math.round(r.p * 100)}%${st.catalog ? ` · ${esc(st.catalog)}` : ''}${r.edited ? `<br>Изменено ${esc(r.at || 'вами')}${r.note ? `: ${esc(r.note)}` : ''}` : ''}</div>
    <div class="pop-actions">${r.edited ? '<button type="button" class="btn ghost small" data-pop="reset">Вернуть как в справочнике</button>' : ''}<button type="button" class="btn small" data-pop="cancel">Отмена</button><button type="button" class="btn primary small" data-pop="apply">Применить</button></div>`;
}
const pillS = {
  x: new Spring(0, { response: 0.36, damping: 0.8, rest: 0.2, onUpdate: () => paintPill() }),
  y: new Spring(0, { response: 0.36, damping: 0.9, rest: 0.2, onUpdate: () => paintPill() }),
  w: new Spring(0, { response: 0.36, damping: 0.9, rest: 0.2, onUpdate: () => paintPill() }),
};
function paintPill() { const p = $('#pop .seg .pill'); if (!p) return; p.style.transform = `translate(${pillS.x.x}px, ${pillS.y.x}px)`; p.style.width = pillS.w.x + 'px'; }
function placePill(instant) {
  const b = $('#pop .seg button[aria-checked="true"]'); const p = $('#pop .seg .pill'); if (!b || !p) return;
  p.style.height = b.offsetHeight + 'px';
  for (const [k, v] of [['x', b.offsetLeft], ['y', b.offsetTop], ['w', b.offsetWidth]]) instant ? pillS[k].set(v) : pillS[k].to(v);
  paintPill();
}
function wirePop() {
  const pop = $('#pop');
  const seg = $('.seg', pop);
  placePill(!popState.pillReady);
  popState.pillReady = true;
  $$('button', seg).forEach((b) => b.addEventListener('click', () => {
    popState.draft.lvl = b.dataset.lvl;
    const prev = $('#impactN', pop).textContent;
    pop.innerHTML = popHTML(); wirePop();
    rollNumberText($('#impactN', pop), prev);
    $('.seg button[aria-checked="true"]', pop)?.focus({ preventScroll: true });
  }));
  seg.addEventListener('keydown', (e) => {
    const i = LV_ORDER.indexOf(popState.draft.lvl);
    if (['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault();  const n = LV_ORDER[(i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : LV_ORDER.length - 1)) % LV_ORDER.length]; $(`.seg button[data-lvl="${n}"]`, pop).click(); }
  });
  $$('.stepper', pop).forEach((sp) => {
    const k = sp.dataset.k; const steps = k === 'warnAfter' ? WARN_STEPS : k === 'errAfter' ? ERR_STEPS : OOP_STEPS;
    const [minus, plus] = $$('button', sp);
    const bump = (d) => {
      const cur = popState.draft[k]; let i = steps.findIndex((s) => s >= cur); if (i < 0) i = steps.length - 1;
      i = clamp(i + d, 0, steps.length - 1); popState.draft[k] = steps[i];
      if (k === 'warnAfter' && popState.draft.errAfter <= popState.draft.warnAfter) popState.draft.errAfter = ERR_STEPS.find((s) => s > popState.draft.warnAfter) || ERR_STEPS.at(-1);
      $('output', sp).textContent = durShort(popState.draft[k]);
      const other = $$('.stepper', pop).find((x) => x.dataset.k === 'errAfter'); if (other) $('output', other).textContent = durShort(popState.draft.errAfter);
      const el = $('#impactN', pop); const prev = el.textContent; el.textContent = impactCount(popState.code, popState.draft); rollNumberText(el, prev);
    };
    minus.addEventListener('click', () => bump(-1)); plus.addEventListener('click', () => bump(1));
  });
  $$('[data-pop]', pop).forEach((b) => b.addEventListener('click', () => {
    const a = b.dataset.pop;
    if (a === 'cancel') closePop();
    if (a === 'reset') { delete S.rules[popState.stage]?.[popState.code]; afterRuleChange('Правило возвращено к справочнику'); }
    if (a === 'apply') {
      const r = ruleFor(popState.stage, popState.code);
      const d = popState.draft;
      const changed = d.lvl !== r.base || d.warnAfter !== S.settings.warnAfter || d.errAfter !== S.settings.errAfter || d.oopAfter !== S.settings.oopAfter;
      (S.rules[popState.stage] ||= {});
      if (changed) S.rules[popState.stage][popState.code] = { ...d, at: `сегодня в ${hhmm(S.now)}`, note: S.rules[popState.stage][popState.code]?.note };
      else delete S.rules[popState.stage][popState.code];
      afterRuleChange(`Правило для «${M[popState.code].lower}» обновлено · этап ${popState.stage}`);
    }
  }));
}
function rollNumberText(el, prev) {
  if (!el || RM.matches || prev === el.textContent) return;
  el.animate([{ transform: `translateY(${Number(el.textContent) > Number(prev) ? 10 : -10}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 320, easing: 'cubic-bezier(.2,.8,.2,1)' });
}
function afterRuleChange(msg) {
  closePop();
  $('#recon').dataset.k = '';
  render();
  renderPlanDetail();
  renderDemand();
  showToast(msg);
}
function closePop() { if (!popState) return; popState.closing = true; popSpring.to(0, { damping: 1 }); }

/* ── Settings sheet ────────────────────────────────────── */
let sheetTab = 'control';
const sheetSpring = new Spring(0, { response: 0.48, damping: 0.92, rest: 0.002, onUpdate: (p) => {
  const sh = $('#sheet');
  sh.style.transform = MOBILE.matches ? `translateY(${(1 - p) * 104}%)` : `translateX(${(1 - p) * 108}%)`;
  $('#scrim').style.opacity = String(clamp(p, 0, 1) * 0.8);
  if (p <= 0.001 && sheetSpring.target === 0) { sh.hidden = true; $('#scrim').dataset.on = 'false'; $('#settingsBtn').focus({ preventScroll: true }); }
} });
function openSheet(tab = 'control') {
  closePop(); closeMenu();
  sheetTab = tab;
  const sh = $('#sheet'); sh.hidden = false;
  sh.innerHTML = sheetHTML();
  $('#scrim').dataset.on = 'true';
  wireSheet();
  sheetSpring.to(1);
  setTimeout(() => $('#sheetTitle').focus({ preventScroll: true }), 40);
}
function closeSheet() { sheetSpring.to(0, { damping: 1 }); }
function sheetHTML() {
  const s = S.settings, d = DEFAULTS;
  const row = (k, title, desc, val, def) => `<div class="set-row"><div><h4>${title}</h4><p>${desc}</p></div>
    <div class="stepper" data-k="${k}"><button type="button" aria-label="Меньше">−</button><output>${val}</output><button type="button" aria-label="Больше">+</button></div>
    <div class="def">По умолчанию: ${def}${s[k] !== d[k] ? ` <span class="changed">· изменено вами</span> <button type="button" data-reset="${k}">Сбросить</button>` : ''}</div></div>`;
  const ev = evaluate(S.t);
  const tabs = { control: 'Контроль', sources: 'Источники', shift: 'Смена и объект' };
  let body = '';
  if (sheetTab === 'control') body = `
    ${row('window', 'Окно сверки', 'Техника считается замеченной, если найдена хотя бы на одном кадре любой камеры за это время.', `${s.window} с`, `${d.window} с`)}
    ${row('conf', 'Порог уверенности распознавания', 'Рамки с меньшей уверенностью не учитываются в сверке и не показываются.', `${s.conf}%`, `${d.conf}%`)}
    ${row('warnAfter', 'Предупреждение, если обязательной техники нет', 'Общее значение для всех этапов. У отдельной техники на этапе можно задать своё.', durShort(s.warnAfter), durShort(d.warnAfter))}
    ${row('errAfter', 'Отклонение, если её нет', 'После этого времени предупреждение становится отклонением.', durShort(s.errAfter), durShort(d.errAfter))}
    ${row('oopAfter', 'Техника не по этапу', 'Создать отклонение, если нехарактерная техника видна дольше этого времени.', durShort(s.oopAfter), durShort(d.oopAfter))}
    <div class="set-row"><div><h4>Пороги профиля этапа</h4><p>Как доля этапов справочника, где встречается техника, переводится в требование.</p></div><span></span>
      <div class="thresholds"><div><b>≥ 80%</b>обязательна</div><div><b>50–79%</b>рекомендуется</div><div><b>20–49%</b>допустима</div><div><b>&lt; 20%</b>не характерна</div></div></div>`;
  if (sheetTab === 'sources') body = `${ev.cams.map((c) => `<div class="src-row"><img src="${IMG[c.img]}" alt="" style="${c.off ? 'filter:saturate(.2) brightness(.7)' : ''}"><div><b>${c.n} · ${esc(c.name)}</b><small class="${c.off ? 'bad' : ''}">${c.off ? `Нет сигнала ${durShort(c.offFor)} · последний кадр ${hhmmss(c.ft)}` : 'Свежий кадр 1 с назад · 1280×720 · 0,4 с задержка'}</small><small class="mono">${esc(c.url)}</small></div><button type="button" class="btn small" data-check="${c.id}">Проверить</button></div>`).join('')}
    <div class="set-row"><div><h4>Распознавание</h4><p>${ev.model ? 'Работает · 11 классов техники · кадр анализируется за 0,3 с' : `Модель не отвечает с ${hhmm(S.scn.modelSince)}. Пока анализа нет, события не создаются.`}</p></div><button type="button" class="btn small" data-act="toast:Проверка сервера распознавания в макете не выполняется">Проверить</button></div>
    <div style="display:flex;gap:8px;margin-top:14px"><button type="button" class="btn small" data-act="toast:Форма добавления камеры: название, зона, адрес потока">Добавить камеру</button><button type="button" class="btn small" data-act="toast:Для записи нужны дата и время начала, чтобы найти этап плана">Загрузить запись</button></div>`;
  if (sheetTab === 'shift') body = `
    <div class="set-row"><div><h4>Смена</h4><p>Вне смены отсутствие техники не считается отклонением.</p></div><span class="mono">${hhmm(s.shiftFrom)}–${hhmm(s.shiftTo)}</span><div class="def">По умолчанию: 07:00–19:00</div></div>
    ${row('startGrace', 'Сбор техники после начала смены', 'Сколько ждать, прежде чем считать технику отсутствующей, если с начала смены её ещё не было.', durShort(s.startGrace), durShort(d.startGrace))}
    <div class="set-row"><div><h4>Тип объекта</h4><p>Определяет раздел справочника для профилей этапов.</p></div><span>Жильё</span></div>
    <div class="set-row"><div><h4>Зоны</h4><p>Котлован, Кран и склад. Камеры и этапы привязываются к зонам.</p></div><button type="button" class="btn small" data-act="toast:Редактор зон: привязка камер и этапов">Изменить</button></div>`;
  return `<div class="sheet-head"><div><h2 id="sheetTitle" tabindex="-1">Настройки контроля</h2><p>Многоквартирный жилой дом · корпус 2</p></div><button type="button" class="close-x" data-act="close-sheet" aria-label="Закрыть"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></div>
    <div class="tabs" role="tablist">${Object.entries(tabs).map(([k, v]) => `<button type="button" role="tab" aria-selected="${k === sheetTab}" data-tab="${k}">${v}</button>`).join('')}<i class="bar-ind"></i></div>
    <div class="sheet-body">${body}</div>`;
}
const STEP_SETS = { window: [10, 15, 30, 60, 120], conf: [40, 50, 60, 70, 80, 90], warnAfter: WARN_STEPS, errAfter: ERR_STEPS, oopAfter: OOP_STEPS, startGrace: [0, 900, 1800, 2700, 3600] };
let tabInd = null;
function wireSheet() {
  const sh = $('#sheet');
  const ind = $('.bar-ind', sh);
  const sel = $('.tabs button[aria-selected="true"]', sh);
  if (!tabInd) tabInd = { x: new Spring(sel.offsetLeft, { response: 0.36, damping: 0.86, rest: 0.2 }), w: new Spring(sel.offsetWidth, { response: 0.36, damping: 0.9, rest: 0.2 }) };
  tabInd.x.onUpdate = (v) => { $('.bar-ind', $('#sheet')).style.transform = `translateX(${v}px)`; };
  tabInd.w.onUpdate = (v) => { $('.bar-ind', $('#sheet')).style.width = v + 'px'; };
  ind.style.transform = `translateX(${tabInd.x.x}px)`; ind.style.width = tabInd.w.x + 'px';
  tabInd.x.to(sel.offsetLeft); tabInd.w.to(sel.offsetWidth);
  $$('.tabs button', sh).forEach((b) => b.addEventListener('click', () => { sheetTab = b.dataset.tab; sh.innerHTML = sheetHTML(); wireSheet(); }));
  $$('.stepper', sh).forEach((sp) => {
    const k = sp.dataset.k; const steps = STEP_SETS[k];
    const [minus, plus] = $$('button', sp);
    const bump = (d) => {
      let i = steps.findIndex((s) => s >= S.settings[k]); if (i < 0) i = steps.length - 1;
      S.settings[k] = steps[clamp(i + d, 0, steps.length - 1)];
      if (S.settings.errAfter <= S.settings.warnAfter) S.settings.errAfter = ERR_STEPS.find((s) => s > S.settings.warnAfter) || ERR_STEPS.at(-1);
      sh.querySelector('.sheet-body').innerHTML = $('.sheet-body', (() => { const t = document.createElement('div'); t.innerHTML = sheetHTML(); return t; })()).innerHTML;
      wireSheetBody();
      render();
    };
    minus.addEventListener('click', () => bump(-1)); plus.addEventListener('click', () => bump(1));
  });
  wireSheetBody(true);
}
function wireSheetBody(skipSteppers) {
  const sh = $('#sheet');
  if (!skipSteppers) $$('.stepper', sh).forEach((sp) => {
    const k = sp.dataset.k; const steps = STEP_SETS[k];
    const [minus, plus] = $$('button', sp);
    const bump = (d) => { let i = steps.findIndex((s) => s >= S.settings[k]); if (i < 0) i = steps.length - 1; S.settings[k] = steps[clamp(i + d, 0, steps.length - 1)]; if (S.settings.errAfter <= S.settings.warnAfter) S.settings.errAfter = ERR_STEPS.find((s) => s > S.settings.warnAfter) || ERR_STEPS.at(-1); refreshSheetBody(); render(); };
    minus.addEventListener('click', () => bump(-1)); plus.addEventListener('click', () => bump(1));
  });
  $$('[data-reset]', sh).forEach((b) => b.addEventListener('click', () => { S.settings[b.dataset.reset] = DEFAULTS[b.dataset.reset]; refreshSheetBody(); render(); }));
  $$('[data-check]', sh).forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.check; b.disabled = true; b.textContent = 'Проверяем…';
    setTimeout(() => { b.disabled = false; b.textContent = 'Проверить'; showToast(camOff(id, S.now) ? 'Камера не ответила за 5 секунд. Проверьте питание и сеть.' : 'Кадр получен · 1280×720 · 0,4 с'); }, 900);
  }));
}
function refreshSheetBody() {
  const sh = $('#sheet'); const t = document.createElement('div'); t.innerHTML = sheetHTML();
  $('.sheet-body', sh).innerHTML = $('.sheet-body', t).innerHTML;
  wireSheetBody();
}

/* ── Scenario menu ─────────────────────────────────────── */
const menuSpring = new Spring(0, { response: 0.34, damping: 0.95, rest: 0.002, onUpdate: (p) => {
  const m = $('#menu'); m.style.opacity = String(clamp(p * 1.3, 0, 1)); m.style.transform = `translateY(${(1 - p) * -6}px) scale(${lerp(0.96, 1, p)})`;
  if (p <= 0.001 && menuSpring.target === 0) m.hidden = true;
} });
function openMenu() {
  const m = $('#menu'); const b = $('#scnBtn').getBoundingClientRect();
  m.innerHTML = `<div class="m-k kicker">Сценарий макета</div>` + SCN_ORDER.map((k) => `<button type="button" role="menuitemradio" aria-checked="${k === S.key}" data-scn="${k}"><span class="chk">✓</span><span><b>${SCN[k].label}</b><small>${SCN[k].hint}</small></span></button>`).join('') + `<a class="m-link" role="menuitem" href="concept.html">Концепция и решения<span aria-hidden="true">→</span></a>`;
  m.hidden = false;
  const w = m.offsetWidth;
  Object.assign(m.style, { left: clamp(b.right - w, 8, innerWidth - w - 8) + 'px', top: b.bottom + 8 + 'px', transformOrigin: `${b.right - clamp(b.right - w, 8, innerWidth - w - 8)}px 0` });
  $('#scnBtn').setAttribute('aria-expanded', 'true');
  menuSpring.to(1);
  $('button[aria-checked="true"]', m)?.focus();
  $$('[data-scn]', m).forEach((x) => x.addEventListener('click', () => { closeMenu(); switchScenario(x.dataset.scn); }));
  m.onkeydown = (e) => {
    const items = $$('[data-scn]', m); const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  };
}
function closeMenu() { if ($('#menu').hidden) return; $('#scnBtn').setAttribute('aria-expanded', 'false'); menuSpring.to(0); }
function switchScenario(k) {
  if (k === S.key) return;
  closeAll(); cancelAnimationFrame(replayRaf);
  const app = $('#app');
  if (RM.matches) { loadScenario(k); return; }
  app.getAnimations().forEach((a) => a.cancel());
  app.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: 'ease-in', fill: 'forwards' });
  // the switch itself runs on a timer, so it happens even if the fade is paused in a background tab
  setTimeout(() => {
    loadScenario(k, { boot: true });
    app.getAnimations().forEach((a) => a.cancel());
    app.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: 'ease-out' });
  }, 150);
}
function closeAll() { closeCase(); closePop(); closeMenu(); if (!$('#sheet').hidden) closeSheet(); }

/* ── Setup (first run) ─────────────────────────────────── */
function checkSVG() { return '<svg viewBox="0 0 30 30" aria-hidden="true"><circle cx="15" cy="15" r="14" fill="var(--ok-bg)" stroke="var(--ok)" stroke-width="1.2"/><path d="M9.5 15.5l3.8 3.7 7.4-8" fill="none" stroke="var(--ok)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="stroke-dasharray:20;stroke-dashoffset:20;animation:draw2 .5s .1s cubic-bezier(.4,0,.2,1) forwards"/></svg><style>@keyframes draw2{to{stroke-dashoffset:0}}</style>'; }
function renderSetup() {
  const st = S.setupState; const el = $('#setup');
  const step = (n, done, locked, title, desc, act, res = '') => `<div class="s-step" data-done="${done}" data-locked="${locked}"><span class="n">${n}${done ? checkSVG() : ''}</span><div><h3>${title}</h3><p>${desc}</p>${res}</div><div class="s-act">${done ? '' : act}</div></div>`;
  const planRes = st.plan ? `<div class="s-res"><div><i></i>9 этапов · 18 апреля 2026 – 12 января 2027</div><div><i></i>8 этапов сопоставлены со справочником «Жильё» автоматически</div><div><i style="background:var(--warn)"></i>«Благоустройство территории» → «Устройство асфальтобетонного покрытия», сходство 0,62. <button type="button" class="link" data-act="toast:Здесь можно выбрать другой этап справочника">Проверить</button></div></div>` : '';
  const srcRes = st.source ? `<div class="s-res"><div><i></i>Камера «Котлован · общий план» · кадр получен, 1280×720, задержка 0,4 с</div></div>` : st.camForm ? `<form class="cam-form" id="camForm"><input id="camName" aria-label="Название камеры" value="Котлован · общий план"><input id="camUrl" aria-label="Адрес потока" value="rtsp://10.20.1.11/main"><button type="submit" class="btn small primary" id="camCheck">Проверить связь</button></form>` : '';
  const checks = ['Свежий кадр получен', 'Распознавание работает · 11 классов техники', 'Этап на 5 мая найден: 2 «Выемка грунта котлована»'];
  const checkRes = st.check ? `<div class="s-res">${checks.map((c, i) => `<div><i class="${i < st.check ? '' : 'wait'}"></i>${i < st.check ? c : `${c.split(' ')[0]} …`}</div>`).join('')}</div>` : '';
  const ready = st.plan && st.source && st.check >= 3;
  el.innerHTML = `<div class="setup-card"><span class="kicker">Новый объект</span><h1>Подготовим контроль за четыре шага</h1>
    <p>Сверка начнётся, когда будут план работ и хотя бы один источник кадров. Без них система ничего не утверждает о площадке.</p>
    <div class="s-steps">
      ${step(1, true, false, 'Объект', 'Многоквартирный жилой дом · корпус 3 · тип «Жильё»', '')}
      ${step(2, st.plan, false, 'План работ', 'Файл .xlsx или .csv с этапами и датами. Покажем, как этапы сопоставились со справочником, до сохранения.', `<label class="btn small">Выбрать файл<input type="file" accept=".xlsx,.csv" id="planFile" hidden></label><button type="button" class="btn small" data-act="setup-plan">Взять пример плана</button>`, planRes)}
      ${step(3, st.source, !st.plan, 'Источник кадров', 'Камера по адресу потока или запись с датой и временем начала.', `<button type="button" class="btn small" data-act="setup-cam">Подключить камеру</button><button type="button" class="btn small ghost" data-act="toast:Для записи укажите дату и время начала съёмки">Загрузить запись</button>`, srcRes)}
      ${step(4, ready, !(st.plan && st.source), 'Проверка', 'Кадр приходит, распознавание отвечает, на сегодня есть этап плана.', '', checkRes)}
    </div>
    <div class="setup-go"><button type="button" class="btn plan" data-act="setup-go" ${ready ? '' : 'disabled'}>Начать контроль</button><p>${ready ? 'Всё готово.' : 'Кнопка станет доступна после проверки.'}</p></div></div>`;
  const form = $('#camForm', el);
  if (form) form.addEventListener('submit', (e) => { e.preventDefault(); const b = $('#camCheck', el); b.disabled = true; b.textContent = 'Проверяем…'; setTimeout(() => { st.source = true; st.camForm = false; renderSetup(); runChecks(); }, 900); });
  const pf = $('#planFile', el);
  if (pf) pf.addEventListener('change', () => { if (pf.files[0]) { showToast(`Файл «${pf.files[0].name}» получен. В макете показан пример разбора.`); setupPlan(); } });
}
function setupPlan() {
  S.setupState.plan = true; renderSetup();
  buildPlan();
  // the plan arrives in the dock: segments drop into the folded strip
  renderDock(evaluate(S.t));
  if (!RM.matches) $$('.p-bar').forEach((b, i) => b.animate([{ opacity: 0, transform: b.style.transform + ' translateY(-18px)' }, { opacity: 1, transform: b.style.transform }], { duration: 520, delay: i * 45, easing: 'cubic-bezier(.2,.8,.2,1.15)', fill: 'backwards' }));
  if (S.setupState.source) runChecks();
}
function runChecks() {
  const st = S.setupState;
  if (!(st.plan && st.source) || st.check) return;
  let i = 0;
  const tick = () => { i++; st.check = i; renderSetup(); if (i < 3) setTimeout(tick, 520); };
  setTimeout(tick, 400);
}

/* ── Global events ─────────────────────────────────────── */
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act], .q-card, .slot, .tile, .oop-chip, .extra-row button[data-code], .req, .dm-cell, .pf-row, .d-ev');
  if (!t) {
    if (!$('#menu').hidden && !e.target.closest('#menu, #scnBtn')) closeMenu();
    if (popState && !e.target.closest('#pop')) closePop();
    return;
  }
  if (t.classList.contains('q-card')) { if (t.dataset.swiped) return; openCase(t.dataset.id, t); return; }
  if (t.classList.contains('slot') || t.classList.contains('oop-chip') || (t.dataset.code && t.closest('.extra-row'))) { openRule(t.dataset.code, t); return; }
  if (t.classList.contains('req') || t.classList.contains('dm-cell')) { openRule(t.dataset.code, t, Number(t.dataset.stage)); return; }
  if (t.classList.contains('pf-row')) { S.planSel = Number(t.dataset.n); layoutPlan(dockP); renderPlanDetail(); return; }
  if (t.classList.contains('tile')) { switchCam(t.dataset.cam, t); return; }
  const act = t.dataset.act;
  if (!act) return;
  if (act === 'case') openCase(t.dataset.id, t);
  else if (act === 'close-case') closeCase();
  else if (act === 'close-sheet') closeSheet();
  else if (act === 'plan') { closeCase(); setDock(!S.dockOpen); }
  else if (act === 'collapse-plan') setDock(false);
  else if (act === 'replay') replay();
  else if (act === 'live') goLive();
  else if (act === 'undo') undo();
  else if (act === 'journal') showToast('Журнал: все события объекта, фильтры и выгрузка акта за период');
  else if (act === 'toggle-done') { S.doneOpen = !S.doneOpen; render(); }
  else if (act === 'rule') { closeCase(); setTimeout(() => { const s = $(`.slot[data-code="${t.dataset.code}"]`); if (s) openRule(t.dataset.code, s); }, RM.matches ? 0 : 320); }
  else if (act.startsWith('settings')) { closeCase(); openSheet(act.split(':')[1] || 'control'); }
  else if (act.startsWith('toast:')) showToast(act.slice(6));
  else if (act === 'setup-plan') setupPlan();
  else if (act === 'setup-cam') { S.setupState.camForm = true; renderSetup(); $('#camUrl')?.focus(); }
  else if (act === 'setup-go') switchScenario('truck');
});
$('#scnBtn').addEventListener('click', (e) => { e.stopPropagation(); $('#menu').hidden ? openMenu() : closeMenu(); });
$('#settingsBtn').addEventListener('click', () => openSheet('control'));
$('#timePill').addEventListener('click', () => { if (S.scn.setup) return; if (!S.live) goLive(); else { $('#day').focus(); showToast('Перетащите отметку времени на шкале внизу, чтобы посмотреть запись'); } });
$('#ctxObject').addEventListener('click', () => showToast('Список объектов: последние, поиск по адресу'));
$('#ctxZone').addEventListener('click', () => showToast('Зоны объекта: Котлован, Кран и склад'));
$('#scrim').addEventListener('click', () => { if (caseState) closeCase(); else if (!$('#sheet').hidden) closeSheet(); });
document.addEventListener('change', () => {});
$('#strip').addEventListener('click', (e) => { const b = e.target.closest('#boxToggle'); if (b) { S.boxes = !S.boxes; render(); } });

// slot hover maps plan item → boxes on the frame
$('#side').addEventListener('pointerover', (e) => { const s = e.target.closest('.slot, .oop-chip, .extra-row button[data-code]'); setFocus(s?.dataset.code || null); });
$('#side').addEventListener('pointerleave', () => setFocus(null));
$('#side').addEventListener('focusin', (e) => { const s = e.target.closest('.slot, .oop-chip'); setFocus(s?.dataset.code || null); });
function setFocus(code) {
  const f = $('#frame');
  if (!code || !$(`#boxes .box[data-m="${code}"]`)) { delete f.dataset.focus; $$('#boxes .box').forEach((b) => b.classList.remove('focus')); return; }
  f.dataset.focus = code;
  $$('#boxes .box').forEach((b) => b.classList.toggle('focus', b.dataset.m === code));
}

function switchCam(id, tile) {
  if (id === S.cam) return;
  const frame = $('#frame');
  const from = tile.getBoundingClientRect(), to = frame.getBoundingClientRect();
  const src = $('img', tile).src;
  S.cam = id;
  if (RM.matches) { render(); return; }
  // shared element: the tile grows into the main frame
  const ghost = document.createElement('img');
  ghost.src = src; ghost.className = 'token';
  Object.assign(ghost.style, { width: to.width + 'px', height: to.height + 'px', objectFit: 'cover', borderRadius: '4px', zIndex: 50, filter: $('img', tile).style.filter });
  document.body.appendChild(ghost);
  const sx = from.width / to.width, sy = from.height / to.height;
  const sp = new Spring(0, { response: 0.42, damping: 0.92, rest: 0.002, onUpdate: (p) => {
    const x = lerp(from.left, to.left, p), y = lerp(from.top, to.top, p);
    ghost.style.transformOrigin = '0 0';
    ghost.style.transform = `translate(${x}px,${y}px) scale(${lerp(sx, 1, p)},${lerp(sy, 1, p)})`;
  }, onRest: () => { render(); requestAnimationFrame(() => ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180 }).onfinish = () => ghost.remove()); } });
  sp.to(1);
  $('#boxes').animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: 'forwards' }).onfinish = () => { $('#boxes').dataset.k = ''; };
  setTimeout(() => $('#boxes').animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, fill: 'forwards' }), 420);
}

document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea';
  if (e.key === 'Escape') {
    if (!$('#menu').hidden) { closeMenu(); $('#scnBtn').focus(); return; }
    if (popState) { closePop(); return; }
    if (caseState) { closeCase(); return; }
    if (!$('#sheet').hidden) { closeSheet(); return; }
    if (S.dockOpen) { setDock(false); $('#grip').focus(); return; }
  }
  if (typing) return;
  if (caseState && ['1', '2', '3'].includes(e.key)) { const m = { 1: 'confirmed', 2: 'false', 3: 'later' }[e.key]; const b = $(`[data-decide="${m}"]`); if (b && !b.disabled) commitCase(m); return; }
  if (caseState && e.key === 'Tab') { // focus stays inside the dialog
    const f = $$('#case button:not([disabled]), #case textarea, #case a, #case [tabindex="0"]'); if (!f.length) return;
    const i = f.indexOf(document.activeElement);
    if (e.shiftKey && i <= 0) { e.preventDefault(); f.at(-1).focus(); } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
  }
  if (caseState || popState || !$('#sheet').hidden) return;
  if (e.key === 'j' || e.key === 'k' || e.key === 'о' || e.key === 'л') {
    const cards = $$('.q-card'); if (!cards.length) return;
    const i = cards.indexOf(document.activeElement);
    const n = (e.key === 'j' || e.key === 'о') ? Math.min(cards.length - 1, i + 1) : Math.max(0, i - 1);
    cards[n].focus();
  }
  if (e.key === 'p' || e.key === 'з') setDock(!S.dockOpen);
  if (e.key === 'l' || e.key === 'д') goLive();
});

addEventListener('resize', () => {
  const { min, max } = dockLimits();
  dockSpring.set(S.dockOpen ? max : min);
  $('#day').dataset.k = '';
  render();
  if (caseState) { const R = caseRect(); caseState.rect = R; Object.assign($('#case').style, { left: R.left + 'px', top: R.top + 'px', width: R.width + 'px', height: R.height + 'px' }); paintCase(caseSpring.x); }
});

function bindQueueJump() {
  const side = $('#side'), q = $('#queue'), jump = $('#qJump');
  const io = new IntersectionObserver(([en]) => { S.queueVisible = en.isIntersecting; updateJump(); }, { root: side, threshold: 0.35 });
  io.observe(q);
  jump.addEventListener('click', () => side.scrollTo({ top: q.offsetTop - 8, behavior: RM.matches ? 'auto' : 'smooth' }));
}
function updateJump() {
  const jump = $('#qJump'); if (!jump) return;
  const n = (S.prev?.events || []).filter((e) => e.pending);
  const show = S.queueVisible === false && n.length > 0 && !S.scn.setup && !MOBILE.matches;
  jump.dataset.sev = n.some((e) => e.sevNow === 'err') ? 'err' : 'warn';
  $('#qJumpT').textContent = `Требуют решения · ${n.length}`;
  if (show === !jump.hidden) return;
  if (show) { jump.hidden = false; if (!RM.matches) jump.animate([{ opacity: 0, transform: 'translateY(10px) scale(.96)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' }); }
  else jump.hidden = true;
}

/* ── Start ─────────────────────────────────────────────── */
bindDay();
bindDock();
bindQueueJump();
loadScenario('truck', { boot: true });
dockSpring.set(dockLimits().min);
