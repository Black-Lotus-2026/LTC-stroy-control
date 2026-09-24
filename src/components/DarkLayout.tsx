import React, { useEffect, useState } from 'react'
import {
  IncidentAlertItem,
  StageItem,
  fetchStages,
  loadDemoSchedule,
} from '../api/stroyControlApi'
import { GanttChart } from './GanttChart'
import { IncidentAlerts } from './IncidentAlerts'
import { StageAnalytics } from './StageAnalytics'
import { VideoPlayer } from './VideoPlayer'

export const DarkLayout: React.FC = () => {
  const [stages, setStages] = useState<StageItem[]>([])
  const [selectedStageId, setSelectedStageId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'dashboard' | 'gantt' | 'video' | 'analytics' | 'incidents'>('dashboard')
  const [toastMessage, setToastMessage] = useState<string | null>(null)

  const showToast = (msg: string) => {
    setToastMessage(msg)
    setTimeout(() => setToastMessage(null), 4000)
  }

  useEffect(() => {
    fetchStages()
      .then((items) => {
        if (items && items.length > 0) {
          setStages(items)
          setSelectedStageId(items[1]?.id || items[0]?.id)
        } else {
          loadDemoSchedule().then((demo) => {
            setStages(demo)
            setSelectedStageId(demo[1]?.id || demo[0]?.id)
          })
        }
      })
      .catch(() => {
        loadDemoSchedule().then((demo) => {
          setStages(demo)
          setSelectedStageId(demo[1]?.id || demo[0]?.id)
        })
      })
  }, [])

  const selectedStage = stages.find((s) => s.id === selectedStageId) || null

  const handleStageSelectFromGantt = (stageId: string) => {
    setSelectedStageId(stageId)
    // If not in dashboard, switch to analytics tab or keep in place
  }

  const handleSelectIncident = (incident: IncidentAlertItem) => {
    if (incident.stage_id) {
      setSelectedStageId(incident.stage_id)
    }
    showToast(`Выбран инцидент ${incident.code}: ${incident.machinery_type}`)
  }

  return (
    <div className="space-y-6 text-slate-100 font-sans pb-12">
      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed bottom-6 right-6 z-50 bg-indigo-900 border border-indigo-500 text-white px-4 py-3 rounded-xl shadow-2xl flex items-center gap-3 animate-bounce">
          <span className="w-2 h-2 rounded-full bg-emerald-400" />
          <span className="text-xs font-medium">{toastMessage}</span>
        </div>
      )}

      {/* Top Controls & Navigation Bar */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 bg-slate-900/90 border border-slate-800 p-4 rounded-xl shadow-lg">
        <div>
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-800/60 text-xs font-mono font-semibold">
              002-stroy-control-platform
            </span>
            <h2 className="text-lg font-bold text-slate-100 tracking-tight">
              Видеоконтроль стройплощадки и график СМР
            </h2>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Комплексный мониторинг спецтехники (YOLO 10 классов), календарный план и VLM-верификация инцидентов (Google Gemini)
          </p>
        </div>

        {/* Section View Tabs */}
        <div className="inline-flex rounded-lg bg-slate-950 p-1 border border-slate-800 text-xs self-start md:self-auto">
          {[
            { id: 'dashboard', label: 'Общий дашборд' },
            { id: 'video', label: 'Камеры и видео' },
            { id: 'gantt', label: 'Календарный план' },
            { id: 'analytics', label: 'Аналитика этапа' },
            { id: 'incidents', label: 'Инциденты' },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as typeof activeTab)}
              className={`px-3 py-1.5 rounded-md font-medium transition-all ${
                activeTab === tab.id
                  ? 'bg-indigo-600 text-white shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* VIEW: DASHBOARD (Unified 2-row layout) */}
      {activeTab === 'dashboard' && (
        <div className="space-y-6">
          {/* Row 1: Video Player (60%) + Incident Alerts (40%) */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-7">
              <VideoPlayer stages={stages} />
            </div>
            <div className="lg:col-span-5">
              <IncidentAlerts onSelectIncident={handleSelectIncident} />
            </div>
          </div>

          {/* Row 2: Stage Probability Analytics */}
          <div>
            <StageAnalytics selectedStage={selectedStage} />
          </div>

          {/* Row 3: Gantt Timeline & Table */}
          <div>
            <GanttChart
              stages={stages}
              onStagesChange={(newStages) => setStages(newStages)}
              onSelectStage={handleStageSelectFromGantt}
              selectedStageId={selectedStageId}
            />
          </div>
        </div>
      )}

      {/* VIEW: VIDEO ONLY */}
      {activeTab === 'video' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-8">
            <VideoPlayer stages={stages} />
          </div>
          <div className="lg:col-span-4">
            <IncidentAlerts onSelectIncident={handleSelectIncident} />
          </div>
        </div>
      )}

      {/* VIEW: GANTT ONLY */}
      {activeTab === 'gantt' && (
        <div className="space-y-6">
          <GanttChart
            stages={stages}
            onStagesChange={(newStages) => setStages(newStages)}
            onSelectStage={handleStageSelectFromGantt}
            selectedStageId={selectedStageId}
          />
          {selectedStage && <StageAnalytics selectedStage={selectedStage} />}
        </div>
      )}

      {/* VIEW: ANALYTICS ONLY */}
      {activeTab === 'analytics' && (
        <div className="space-y-6">
          <StageAnalytics selectedStage={selectedStage} />
          <GanttChart
            stages={stages}
            onStagesChange={(newStages) => setStages(newStages)}
            onSelectStage={handleStageSelectFromGantt}
            selectedStageId={selectedStageId}
          />
        </div>
      )}

      {/* VIEW: INCIDENTS ONLY */}
      {activeTab === 'incidents' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-7">
            <IncidentAlerts onSelectIncident={handleSelectIncident} />
          </div>
          <div className="lg:col-span-5">
            <StageAnalytics selectedStage={selectedStage} />
          </div>
        </div>
      )}
    </div>
  )
}
