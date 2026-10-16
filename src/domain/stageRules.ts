import { type StageItem, getStageCustomOverrides, toRussianMachineryName } from '../api/stroyControlApi'

export function getRequiredMachineryForStage(stageName?: string): string[] {
  if (!stageName) return ['Башенный кран', 'Самосвал']
  const lower = stageName.toLowerCase()
  if (lower.includes('кладк') || lower.includes('перегород')) {
    return ['Башенный кран', 'Автобетоносмеситель', 'Погрузчик']
  }
  if (lower.includes('котлован') || lower.includes('землян')) {
    return ['Экскаватор', 'Самосвал', 'Бульдозер']
  }
  if (lower.includes('фундамент') || lower.includes('нулев')) {
    return ['Бетононасос', 'Автобетоносмеситель', 'Экскаватор']
  }
  if (lower.includes('монолит') || lower.includes('каркас')) {
    return ['Башенный кран', 'Бетононасос', 'Автобетоносмеситель']
  }
  if (lower.includes('фасад')) {
    return ['Автогидроподъемник', 'Башенный кран', 'Автокран']
  }
  if (lower.includes('кровл')) {
    return ['Башенный кран', 'Автокран']
  }
  if (lower.includes('благоустрой')) {
    return ['Асфальтоукладчик', 'Каток', 'Самосвал', 'Погрузчик']
  }
  return ['Башенный кран', 'Самосвал']
}

export interface StageMachineryRules {
  mandatory: string[]
  recommended: string[]
  uncharacteristic: string[]
}

export function getStageMachineryRules(stageName?: string): StageMachineryRules {
  if (!stageName) {
    return {
      mandatory: ['Башенный кран'],
      recommended: ['Самосвал', 'Автобетоносмеситель'],
      uncharacteristic: ['Асфальтоукладчик', 'Каток', 'Автогрейдер'],
    }
  }
  const s = stageName.toLowerCase()
  if (s.includes('котлован') || s.includes('землян')) {
    return {
      mandatory: ['Экскаватор', 'Самосвал'],
      recommended: ['Бульдозер', 'Погрузчик'],
      uncharacteristic: ['Башенный кран', 'Асфальтоукладчик', 'Каток', 'Автогидроподъемник'],
    }
  }
  if (s.includes('фундамент') || s.includes('нулев')) {
    return {
      mandatory: ['Бетононасос', 'Автобетоносмеситель'],
      recommended: ['Экскаватор', 'Автокран'],
      uncharacteristic: ['Асфальтоукладчик', 'Каток', 'Автогрейдер'],
    }
  }
  if (s.includes('кладк') || s.includes('перегород') || s.includes('кирпич') || s.includes('блок')) {
    return {
      mandatory: ['Башенный кран'],
      recommended: ['Автобетоносмеситель', 'Погрузчик', 'Автокран'],
      uncharacteristic: ['Асфальтоукладчик', 'Каток', 'Автогрейдер', 'Бульдозер'],
    }
  }
  if (s.includes('монолит') || s.includes('каркас') || s.includes('колонн') || s.includes('перекрыт') || s.includes('пилон')) {
    return {
      mandatory: ['Башенный кран', 'Бетононасос'],
      recommended: ['Автобетоносмеситель', 'Автокран'],
      uncharacteristic: ['Бульдозер', 'Асфальтоукладчик', 'Каток', 'Автогрейдер'],
    }
  }
  if (s.includes('фасад') || s.includes('витраж') || s.includes('остеклен')) {
    return {
      mandatory: ['Автогидроподъемник'],
      recommended: ['Автокран', 'Башенный кран'],
      uncharacteristic: ['Экскаватор', 'Бульдозер', 'Асфальтоукладчик', 'Каток', 'Автогрейдер'],
    }
  }
  if (s.includes('кровл')) {
    return {
      mandatory: ['Башенный кран'],
      recommended: ['Автокран', 'Автогидроподъемник'],
      uncharacteristic: ['Экскаватор', 'Бульдозер', 'Каток', 'Асфальтоукладчик', 'Автогрейдер'],
    }
  }
  if (s.includes('благоустрой') || s.includes('дорож') || s.includes('асфальт')) {
    return {
      mandatory: ['Асфальтоукладчик', 'Каток'],
      recommended: ['Самосвал', 'Погрузчик', 'Автогрейдер'],
      uncharacteristic: ['Башенный кран', 'Бетононасос', 'Автогидроподъемник'],
    }
  }
  return {
    mandatory: ['Башенный кран'],
    recommended: ['Самосвал', 'Автобетоносмеситель'],
    uncharacteristic: ['Асфальтоукладчик', 'Каток'],
  }
}

export function getEffectiveStageRules(stage?: StageItem | null): {
  mandatory: string[]
  recommended: string[]
  uncharacteristic: string[]
} {
  const base = getStageMachineryRules(stage?.name)
  if (!stage) {
    return {
      mandatory: base.mandatory.map((m) => toRussianMachineryName(m)),
      recommended: base.recommended.map((m) => toRussianMachineryName(m)),
      uncharacteristic: base.uncharacteristic.map((m) => toRussianMachineryName(m)),
    }
  }

  const overrides = getStageCustomOverrides(stage.id, stage.name)
  if (!overrides || Object.keys(overrides).length === 0) {
    return {
      mandatory: base.mandatory.map((m) => toRussianMachineryName(m)),
      recommended: base.recommended.map((m) => toRussianMachineryName(m)),
      uncharacteristic: base.uncharacteristic.map((m) => toRussianMachineryName(m)),
    }
  }

  const mandatory = new Set<string>(base.mandatory.map((m) => toRussianMachineryName(m)))
  const recommended = new Set<string>(base.recommended.map((m) => toRussianMachineryName(m)))
  const uncharacteristic = new Set<string>(base.uncharacteristic.map((m) => toRussianMachineryName(m)))

  for (const [code, status] of Object.entries(overrides)) {
    const labelRu = toRussianMachineryName(code)
    if (!labelRu) continue

    // Delete existing entries (case-insensitive)
    for (const item of Array.from(mandatory)) {
      if (item.toLowerCase() === labelRu.toLowerCase()) mandatory.delete(item)
    }
    for (const item of Array.from(recommended)) {
      if (item.toLowerCase() === labelRu.toLowerCase()) recommended.delete(item)
    }
    for (const item of Array.from(uncharacteristic)) {
      if (item.toLowerCase() === labelRu.toLowerCase()) uncharacteristic.delete(item)
    }

    const st = String(status).toUpperCase()
    if (st === 'MANDATORY' || st === 'ОБЯЗАТЕЛЬНАЯ') {
      mandatory.add(labelRu)
    } else if (st === 'RECOMMENDED' || st === 'РЕКОМЕНДОВАННАЯ') {
      recommended.add(labelRu)
    } else if (st === 'UNCHARACTERISTIC' || st === 'НЕ ДОПУСКАЕТСЯ') {
      uncharacteristic.add(labelRu)
    }
  }

  return {
    mandatory: Array.from(mandatory),
    recommended: Array.from(recommended),
    uncharacteristic: Array.from(uncharacteristic),
  }
}

// ----------------------------------------------------------------------------
// Camera Frame with RTSP Live Stream Player & Real AI Machinery Bounding Boxes
// ----------------------------------------------------------------------------
