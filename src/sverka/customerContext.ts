import type { ContextDTO } from './customerApi'

export const roleName = (context: ContextDTO) => context.role === 'customer_manager' ? 'Управляющий заказчика' : context.role === 'contractor_foreman' ? 'Прораб подрядчика' : context.role === 'pto_engineer' ? `ПТО ${context.side === 'customer' ? 'заказчика' : 'подрядчика'}` : 'Наблюдатель · только просмотр'
export const contextKey = (context: ContextDTO) => `${context.organization_id}:${context.project_id}:${context.assignment_id}`
export const can = (context: ContextDTO, permission: ContextDTO['effective_permissions'][number]) => context.effective_permissions.includes(permission)
export const canReadFullPlan = (context: ContextDTO) => !context.is_demo && context.side === 'customer' && context.scope.kind === 'project' && (context.role === 'customer_manager' || context.role === 'project_viewer')
export const dateTime = (date: string | null | undefined) => date && Number.isFinite(Date.parse(date)) ? new Date(date).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }) : 'не задано'
