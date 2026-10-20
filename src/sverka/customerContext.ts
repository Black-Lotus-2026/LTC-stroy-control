import type { ContextDTO } from './customerApi'

export const roleName = (context: ContextDTO) =>
  context.role === 'customer_manager'
    ? 'Управляющий заказчика'
    : context.role === 'contractor_foreman'
    ? 'Прораб подрядчика'
    : context.role === 'pto_engineer'
    ? `ПТО ${context.side === 'customer' ? 'заказчика' : 'подрядчика'}`
    : 'Наблюдатель · только просмотр'

export const roleBadgeInfo = (context: ContextDTO) => {
  if (context.role === 'customer_manager') {
    return {
      title: 'Руководитель',
      fullTitle: 'Управляющий заказчика',
      color: '#3b82f6',
      bg: 'rgba(59, 130, 246, 0.15)',
      desc: 'Управление объектом, утверждение решений, согласование приёмок и отчёты',
    }
  }
  if (context.role === 'contractor_foreman') {
    return {
      title: 'Прораб',
      fullTitle: 'Прораб подрядчика',
      color: '#f59e0b',
      bg: 'rgba(245, 158, 11, 0.15)',
      desc: 'Оперативный контроль площадки, видеонаблюдение и устранение замечаний',
    }
  }
  if (context.role === 'pto_engineer') {
    return {
      title: 'Инженер ПТО',
      fullTitle: `ПТО ${context.side === 'customer' ? 'заказчика' : 'подрядчика'}`,
      color: '#10b981',
      bg: 'rgba(16, 185, 129, 0.15)',
      desc: 'Контроль проектной документации, ППР, ПОС и графика производства работ',
    }
  }
  return {
    title: 'Наблюдатель',
    fullTitle: 'Наблюдатель · только просмотр',
    color: '#8b5cf6',
    bg: 'rgba(139, 92, 246, 0.15)',
    desc: 'Мониторинг видеокамер и хроники объекта без прав редактирования',
  }
}


export const contextKey = (context: ContextDTO) => `${context.organization_id}:${context.project_id}:${context.assignment_id}`
export const can = (context: ContextDTO, permission: ContextDTO['effective_permissions'][number]) => context.effective_permissions.includes(permission)
export const canReadFullPlan = (context: ContextDTO) => !context.is_demo && context.side === 'customer' && context.scope.kind === 'project' && (context.role === 'customer_manager' || context.role === 'project_viewer')
export const dateTime = (date: string | null | undefined) => date && Number.isFinite(Date.parse(date)) ? new Date(date).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }) : 'не задано'
