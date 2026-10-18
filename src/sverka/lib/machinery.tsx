import type { CSSProperties } from 'react'

/* The eleven detector classes (backend/app/services/detector.py) drawn as line-art, viewBox 64×40.
   Plan uses the gold drawing, fact the white ink — the same outline in two materials. */

export const CODES = [
  'excavator',
  'bulldozer',
  'dump_truck',
  'truck_crane',
  'tower_crane',
  'concrete_mixer',
  'loader',
  'roller',
  'grader',
  'backhoe_loader',
  'concrete_pump',
] as const
export type Code = (typeof CODES)[number]

export const MACH: Record<Code, { name: string; lower: string; api: string }> = {
  excavator: { name: 'Экскаватор', lower: 'экскаватор', api: 'MACHINERY_EXCAVATOR' },
  bulldozer: { name: 'Бульдозер', lower: 'бульдозер', api: 'MACHINERY_BULLDOZER' },
  dump_truck: { name: 'Самосвал', lower: 'самосвал', api: 'MACHINERY_DUMP_TRUCK' },
  truck_crane: { name: 'Автокран', lower: 'автокран', api: 'MACHINERY_TRUCK_CRANE' },
  tower_crane: { name: 'Башенный кран', lower: 'башенный кран', api: 'MACHINERY_TOWER_CRANE' },
  concrete_mixer: { name: 'Автобетоносмеситель', lower: 'автобетоносмеситель', api: 'MACHINERY_CONCRETE_MIXER' },
  loader: { name: 'Погрузчик', lower: 'погрузчик', api: 'MACHINERY_LOADER' },
  roller: { name: 'Каток', lower: 'каток', api: 'MACHINERY_ROLLER' },
  grader: { name: 'Автогрейдер', lower: 'автогрейдер', api: 'MACHINERY_GRADER' },
  backhoe_loader: { name: 'Экскаватор-погрузчик', lower: 'экскаватор-погрузчик', api: 'MACHINERY_BACKHOE_LOADER' },
  concrete_pump: { name: 'Бетононасос', lower: 'бетононасос', api: 'MACHINERY_CONCRETE_PUMP' },
}

const BY_API = new Map<string, Code>(CODES.map((c) => [MACH[c].api, c]))
const BY_RU = new Map<string, Code>(CODES.map((c) => [MACH[c].name.toLowerCase(), c]))

/** Detector raw label, API constant or Russian name → our code. */
export function toCode(raw?: string | null): Code | null {
  if (!raw) return null
  const s = raw.trim()
  if ((CODES as readonly string[]).includes(s)) return s as Code
  return BY_API.get(s.toUpperCase()) ?? BY_RU.get(s.toLowerCase()) ?? null
}

export const SIL: Record<Code, string> = {
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
}

export type Ink = 'ink' | 'ghost' | 'oop' | 'dim'

export function silHTML(code: Code, ink: Ink = 'ink', extra = '') {
  return `<svg class="mach ${ink}${extra ? ' ' + extra : ''}" viewBox="0 0 64 40" aria-hidden="true">${SIL[code]}</svg>`
}

export function Sil({ code, ink = 'ink', draw = false, delay = 0, className = '' }: { code: Code; ink?: Ink; draw?: boolean; delay?: number; className?: string }) {
  return (
    <svg
      className={`mach ${ink}${draw ? ' draw' : ''}${className ? ' ' + className : ''}`}
      viewBox="0 0 64 40"
      aria-hidden="true"
      style={draw ? ({ '--d': `${delay}ms` } as CSSProperties) : undefined}
      dangerouslySetInnerHTML={{ __html: SIL[code] }}
    />
  )
}
