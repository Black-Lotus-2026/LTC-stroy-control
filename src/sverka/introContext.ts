import type { ContextDTO } from './customerApi'
import { roleName } from './customerContext'

type IntroState = { context: ContextDTO | null; accessLoading: boolean; accessError: string; accessNotice: string }
export function introPresentation(state: IntroState) {
  const context = state.context
  if (state.accessError) return { role: context ? roleName(context) : 'Доступ не проверен', task: state.accessError, cta: 'Повторить загрузку', disabled: state.accessLoading, action: 'retry' as const }
  if (state.accessLoading && !context) return { role: 'Проверяем назначения…', task: 'Получаем организацию, объект и разрешения с сервера.', cta: 'Загружаем доступы…', disabled: true, action: 'continue' as const }
  if (!context) return { role: 'Назначение не выбрано', task: state.accessNotice || 'Вам пока не назначены рабочие объекты. Примите приглашение или обратитесь к администратору организации.', cta: 'Организации и приглашения', disabled: false, action: 'continue' as const }
  const role = roleName(context)
  if (context.is_demo) return { role, task: 'Общая демонстрация · только просмотр опубликованных источников и дел.', cta: 'Открыть демонстрацию', disabled: false, action: 'continue' as const }
  if (context.lifecycle === 'archived') return { role, task: 'Объект в архиве · только просмотр. Незавершённые дела сохраняют свои статусы.', cta: 'Открыть архив объекта', disabled: false, action: 'continue' as const }
  const task = context.role === 'customer_manager' ? 'Проверяйте риски, назначайте ответственных и принимайте устранение.' : context.role === 'contractor_foreman' ? 'Выполняйте свои задачи, прикладывайте материалы и передавайте исправления на приёмку.' : context.role === 'pto_engineer' ? 'Проверяйте страницы ППР и отправляйте требования на утверждение заказчику.' : 'Просматривайте доступные вашему назначению материалы объекта.'
  const cta = context.role === 'customer_manager' ? 'Перейти к решениям' : context.role === 'contractor_foreman' ? 'Открыть мои задачи' : context.role === 'pto_engineer' ? 'Открыть документы' : 'Открыть объект'
  return { role, task, cta, disabled: false, action: 'continue' as const }
}
