export type PageKey = 'monitoring' | 'archive' | 'progress' | 'analytics' | 'reports' | 'settings'
export type IncidentStatus = 'Требует проверки' | 'Подтверждено' | 'В работе' | 'Устранено' | 'Ложное срабатывание'
export type Priority = 'Критический' | 'Высокий' | 'Средний' | 'Низкий'

export interface Camera {
  id: string
  name: string
  zone: string
  status: 'online' | 'degraded' | 'offline'
  freshness: string
  visibility: number
}

export interface Incident {
  id: string
  type: string
  title: string
  zone: string
  camera: string
  time: string
  age: string
  priority: Priority
  status: IncidentStatus
  assignee: string
  sla: string
  confidence: number
  grouped?: number
  note: string
}

export const projects = [
  { id: 'north', name: 'ЖК «Северный», корпус 2', address: 'Москва, ул. Полярная, 18', stage: 'Монолитные работы · 62%' },
]

export const cameras: Camera[] = []

export const incidentsSeed: Incident[] = [
  { id: 'INC-248', type: 'СИЗ', title: 'Рабочий без каски', zone: 'C-02 · Корпус 2', camera: 'CAM-02', time: '14:32', age: '8 мин', priority: 'Высокий', status: 'Требует проверки', assignee: 'Не назначен', sla: '22 мин', confidence: 94, grouped: 3, note: 'Три последовательные детекции одного человека. Лицо не идентифицируется.' },
  { id: 'INC-247', type: 'Техника', title: 'Ожидаемая техника не найдена', zone: 'A-03 · Котлован', camera: 'CAM-03', time: '14:18', age: '22 мин', priority: 'Средний', status: 'Требует проверки', assignee: 'Алексей Морозов', sla: '38 мин', confidence: 68, note: 'Экскаватор не найден в трёх наблюдениях. Обзор рабочей области ограничен до 72%.' },
  { id: 'INC-245', type: 'Безопасность', title: 'Вход в опасную зону', zone: 'A-03 · Котлован', camera: 'CAM-03', time: '13:51', age: '49 мин', priority: 'Критический', status: 'В работе', assignee: 'Ирина Соколова', sla: 'Просрочено 19 мин', confidence: 97, grouped: 2, note: 'Человек пересёк границу активной зоны работы экскаватора.' },
  { id: 'INC-243', type: 'Камера', title: 'Камера вне сети', zone: 'B-01 · Складирование', camera: 'CAM-09', time: '12:26', age: '2 ч 14 мин', priority: 'Средний', status: 'Подтверждено', assignee: 'Денис Волков', sla: 'Просрочено 74 мин', confidence: 100, note: 'Нет кадров и телеметрии. Последний успешный heartbeat в 12:25.' },
  { id: 'INC-241', type: 'Техника', title: 'Предполагаемый простой крана', zone: 'C-02 · Корпус 2', camera: 'CAM-02', time: '11:44', age: '2 ч 56 мин', priority: 'Низкий', status: 'В работе', assignee: 'Алексей Морозов', sla: '1 ч 04 мин', confidence: 81, note: 'Мобильный кран не менял положение 28 минут. Это наблюдение не доказывает простой.' },
  { id: 'INC-238', type: 'СИЗ', title: 'Нет сигнального жилета', zone: 'D-01 · Периметр', camera: 'CAM-05', time: '10:16', age: '4 ч 24 мин', priority: 'Средний', status: 'Устранено', assignee: 'Ирина Соколова', sla: 'Закрыто за 18 мин', confidence: 91, note: 'Нарушение подтверждено и устранено на месте.' },
  { id: 'INC-236', type: 'Данные', title: 'Недостаточно данных о зоне', zone: 'C-02 · Корпус 2', camera: 'CAM-02', time: '09:41', age: '4 ч 59 мин', priority: 'Низкий', status: 'Ложное срабатывание', assignee: 'Мария Ким', sla: 'Закрыто', confidence: 46, note: 'Объект занимал менее 1% кадра; результат отклонён.' },
  { id: 'INC-234', type: 'Безопасность', title: 'Опасное сближение с техникой', zone: 'A-03 · Котлован', camera: 'CAM-03', time: '09:18', age: '5 ч 22 мин', priority: 'Высокий', status: 'Устранено', assignee: 'Ирина Соколова', sla: 'Закрыто за 11 мин', confidence: 96, note: 'Дистанция между человеком и самосвалом менее 3 м.' },
  { id: 'INC-229', type: 'Прогресс', title: 'Возможное отставание', zone: 'C-02 · Корпус 2', camera: 'CAM-02', time: 'Вчера, 17:20', age: '21 ч', priority: 'Средний', status: 'Подтверждено', assignee: 'Алексей Морозов', sla: '8 ч', confidence: 73, note: 'Наблюдаемый объём опалубки ниже планового диапазона. Требуется сверка с журналом работ.' },
  { id: 'INC-226', type: 'Техника', title: 'Несоответствующая техника', zone: 'B-01 · Складирование', camera: 'CAM-07', time: 'Вчера, 15:02', age: '23 ч', priority: 'Низкий', status: 'Устранено', assignee: 'Денис Волков', sla: 'Закрыто за 42 мин', confidence: 88, note: 'Манипулятор находился в зоне разгрузки вне согласованного окна.' },
  { id: 'INC-221', type: 'СИЗ', title: 'Рабочий без каски', zone: 'D-01 · Периметр', camera: 'CAM-05', time: 'Вчера, 12:48', age: '1 д', priority: 'Высокий', status: 'Устранено', assignee: 'Ирина Соколова', sla: 'Закрыто за 9 мин', confidence: 93, note: 'Нарушение подтверждено и устранено.' },
  { id: 'INC-218', type: 'Камера', title: 'Низкая видимость', zone: 'C-02 · Корпус 2', camera: 'CAM-02', time: 'Вчера, 09:10', age: '1 д', priority: 'Средний', status: 'В работе', assignee: 'Денис Волков', sla: 'Просрочено 3 ч', confidence: 100, note: 'Часть обзора перекрыта складируемыми материалами.' },
]

export const zones = [
  { id: 'A-03', name: 'Котлован', work: 'Разработка грунта', risk: 'attention', x: 18, y: 48, w: 35, h: 30 },
  { id: 'B-01', name: 'Складирование', work: 'Приём материалов', risk: 'normal', x: 62, y: 15, w: 24, h: 25 },
  { id: 'C-02', name: 'Корпус 2', work: 'Армирование стен', risk: 'critical', x: 48, y: 50, w: 38, h: 30 },
  { id: 'D-01', name: 'Периметр', work: 'Контроль доступа', risk: 'normal', x: 8, y: 10, w: 30, h: 20 },
]

export const activities = [
  { name: 'Разработка грунта', zone: 'A-03', time: '08:00–17:00', planned: 'Экскаватор · 1, самосвалы · 3', observed: 'Самосвалы · 2', status: 'Требует проверки' },
  { name: 'Армирование стен', zone: 'C-02', time: '08:30–18:00', planned: 'Бригада · 8, кран · 1', observed: 'Люди · 7, кран · 1', status: 'В работе' },
  { name: 'Приём опалубки', zone: 'B-01', time: '13:00–15:00', planned: 'Манипулятор · 1', observed: 'Манипулятор · 1', status: 'По плану' },
]

export const detections = [
  { label: 'Экскаватор', confidence: 96, time: '14:39:52', tone: 'success' },
  { label: 'Самосвал', confidence: 92, time: '14:39:48', tone: 'success' },
  { label: 'Человек', confidence: 89, time: '14:39:44', tone: 'info' },
  { label: 'Каска не видна', confidence: 61, time: '14:39:44', tone: 'warning' },
]

export const archiveResults = [
  { time: '10:42:18', duration: '24 мин', camera: 'CAM-02', zone: 'C-02', title: 'Мобильный кран без видимого движения', confidence: 86 },
  { time: '12:16:05', duration: '31 мин', camera: 'CAM-02', zone: 'C-02', title: 'Положение стрелы и опор не изменилось', confidence: 82 },
  { time: '15:28:41', duration: '22 мин', camera: 'CAM-03', zone: 'A-03', title: 'Башенный кран без наблюдаемой активности', confidence: 74 },
]

export const analytics = [
  { day: '10 сен', incidents: 7, response: 26 },
  { day: '11 сен', incidents: 5, response: 21 },
  { day: '12 сен', incidents: 8, response: 24 },
  { day: '13 сен', incidents: 6, response: 18 },
  { day: '14 сен', incidents: 4, response: 16 },
  { day: '15 сен', incidents: 6, response: 14 },
  { day: 'Сегодня', incidents: 3, response: 12 },
]

export const team = ['Ирина Соколова', 'Алексей Морозов', 'Денис Волков', 'Мария Ким']

export const mockApi = {
  async updateIncident(id: string, patch: Partial<Incident>) {
    await new Promise((resolve) => setTimeout(resolve, 260))
    return { id, ...patch }
  },
  async runArchiveSearch(query: string) {
    await new Promise((resolve) => setTimeout(resolve, 520))
    return { query, results: archiveResults }
  },
}
