import * as api from './api'
import type { ContextDTO } from './customerApi'
import { can, canReadFullPlan } from './customerContext'
import { isSharedDemoProject } from './projectScope'
import { CODES, type Code } from './lib/machinery'
import { loadLocalRules, loadSettings, stageAt, toEvent, toProfile, toStages, type Level, type Stage, type UiEvent } from './model'
export interface IntroSite {
  project: api.ProjectItem
  stages: Stage[]
  stage: Stage | null
  levels: Partial<Record<Code, Level>>
  events: UiEvent[]
  planAvailable: boolean
  eventsAvailable: boolean
  camerasAvailable: boolean
}
/** Optional intro data follows the same selected assignment as the workspace. */
export async function loadIntroSite(context: ContextDTO | null, isCurrent: () => boolean = () => true): Promise<IntroSite | null> {
  if (!context || !isCurrent()) return null
  const projects = await api.projects()
  if (!isCurrent()) return null
  const project = projects.find(item => item.id === context.project_id)
  if (!project) throw new Error('Объект недоступен в текущем назначении.')
  const planAvailable = canReadFullPlan(context), eventsAvailable = can(context, 'incident.read'), camerasAvailable = can(context, 'camera.read')
  const [items, incidents, cameras] = await Promise.all([
    planAvailable ? api.stages(project.id) : Promise.resolve([]),
    eventsAvailable ? api.incidents(project.id) : Promise.resolve([]),
    camerasAvailable ? api.cameras(project.id) : Promise.resolve([]),
  ])
  if (!isCurrent()) return null
  const stages = toStages(items), stage = stageAt(stages, Date.now()), levels: Partial<Record<Code, Level>> = {}
  if (stage) {
    const profile = await api.profile(stage.id)
    if (!isCurrent()) return null
    const rules = toProfile(profile, loadSettings(project.id, isSharedDemoProject(project)), loadLocalRules(stage.id)).rules
    for (const code of CODES) levels[code] = rules[code].lvl
  }
  return { project: { ...project, cameras }, stages, stage, levels, events: incidents.map(item => toEvent(item, api.mediaUrl)).filter(item => !item.sample), planAvailable, eventsAvailable, camerasAvailable }
}
