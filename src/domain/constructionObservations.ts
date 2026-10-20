/** Display vocabulary: broad source classes remain broad; stage rules use their own subset. */
export const OBSERVATION_LABELS = {
  backhoe_loader: 'Экскаватор-погрузчик', bulldozer: 'Бульдозер', cleaning_equipment: 'Уборочная техника',
  concrete_mixer: 'Автобетоносмеситель', concrete_pump: 'Бетононасос', crane_manipulator: 'Кран-манипулятор',
  crawler_crane: 'Гусеничный кран', dump_truck: 'Самосвал', excavator: 'Экскаватор',
  forklift_giraffe: 'Телескопический погрузчик', forklift_standart: 'Вилочный погрузчик', gazelle: 'Газель',
  grader: 'Автогрейдер', hanging_head: 'Подвесной крюк', loader: 'Погрузчик', mobile_crane: 'Мобильный кран',
  other_vehicle: 'Другой транспорт', pile_driving: 'Сваебойная установка', roller: 'Каток', tanker: 'Автоцистерна',
  tower_crane: 'Башенный кран', trailer: 'Прицеп', truck: 'Грузовик', truck_crane: 'Автокран', worker: 'Рабочий',
} as const
export type ObservationCode = keyof typeof OBSERVATION_LABELS
export const OBSERVATION_CODES = Object.keys(OBSERVATION_LABELS).sort() as ObservationCode[]
export function toObservationCode(raw?: string | null): ObservationCode | null {
  const value = raw?.trim().replace(/^MACHINERY_/i, '').toLowerCase()
  return value && Object.hasOwn(OBSERVATION_LABELS, value) ? value as ObservationCode : null
}
