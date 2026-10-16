import { useState } from 'react'
import type { ImportResult, ProjectItem, StreamCheck } from '../api'
import type { Observation, Stage } from '../model'
import { fmtDay } from '../lib/format'
import { CameraForm, RecordingForm } from './Settings'

const KINDS = ['Жильё', 'Административные здания', 'Офисно-деловой центр', 'Образование', 'ДОУ', 'Здравоохранение', 'Спорт', 'Культура', 'Дороги']

const Check = () => (
  <svg viewBox="0 0 30 30" aria-hidden="true">
    <circle cx="15" cy="15" r="14" fill="var(--ok-bg)" stroke="var(--ok)" strokeWidth="1.2" />
    <path d="M9.5 15.5l3.8 3.7 7.4-8" fill="none" stroke="var(--ok)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="check-draw" />
  </svg>
)

export function Setup({
  project,
  stages,
  sourcesCount,
  obs,
  stageNow,
  onCreateProject,
  onDemoPlan,
  onUploadPlan,
  onAddCamera,
  onCheck,
  onRecording,
  onClose,
}: {
  project: ProjectItem | null
  stages: Stage[]
  sourcesCount: number
  obs: Observation
  stageNow: Stage | null
  onCreateProject: (d: { name: string; address: string; object_kind: string }) => Promise<void>
  onDemoPlan: () => Promise<ImportResult>
  onUploadPlan: (f: File) => Promise<ImportResult>
  onAddCamera: (n: string, u: string) => Promise<void>
  onCheck: (u: string) => Promise<StreamCheck>
  onRecording: (f: File, start: number) => void
  onClose: () => void
}) {
  const [prj, setPrj] = useState({ name: '', address: '', object_kind: 'Жильё' })
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [imported, setImported] = useState<ImportResult | null>(null)
  const [srcForm, setSrcForm] = useState<null | 'camera' | 'recording'>(null)
  const hasPlan = stages.length > 0
  const hasSource = sourcesCount > 0
  const live = obs.sources.some((s) => s.status === 'live')
  const ready = !!project && hasPlan && hasSource

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key)
    setErr(null)
    try {
      await fn()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не получилось')
    } finally {
      setBusy(null)
    }
  }
  const n = (i: number, done: boolean) => <span className="n">{done ? <Check /> : i}</span>
  return (
    <section className="setup" aria-labelledby="setupTitle">
      <div className="setup-card">
        <span className="kicker">{project ? project.name : 'Новый объект'}</span>
        <h1 id="setupTitle">Подготовим контроль за четыре шага</h1>
        <p>Сверка начнётся, когда будут план работ и хотя бы один источник кадров. Без них система ничего не утверждает о площадке.</p>
        {err && <p className="err-line">{err}</p>}
        <div className="s-steps">
          <div className="s-step" data-done={!!project}>
            {n(1, !!project)}
            <div>
              <h3>Объект</h3>
              {project ? (
                <p>
                  {project.name} · тип «{project.object_kind || 'не указан'}»
                </p>
              ) : (
                <form
                  className="s-body-form"
                  onSubmit={(e) => {
                    e.preventDefault()
                    run('project', () => onCreateProject(prj))
                  }}
                >
                  <div className="form-grid two-col">
                    <label>
                      Название
                      <input className="input" value={prj.name} onChange={(e) => setPrj({ ...prj, name: e.target.value })} placeholder="Жилой дом, корпус 2" required />
                    </label>
                    <label>
                      Тип объекта
                      <select className="select" value={prj.object_kind} onChange={(e) => setPrj({ ...prj, object_kind: e.target.value })}>
                        {KINDS.map((k) => (
                          <option key={k}>{k}</option>
                        ))}
                      </select>
                    </label>
                    <label style={{ gridColumn: '1 / -1' }}>
                      Адрес
                      <input className="input" value={prj.address} onChange={(e) => setPrj({ ...prj, address: e.target.value })} placeholder="г. Москва, ул. Строителей, 12" />
                    </label>
                  </div>
                  <div className="form-actions">
                    <button type="submit" className="btn small primary" disabled={busy === 'project'}>
                      {busy === 'project' ? 'Создаём…' : 'Создать объект'}
                    </button>
                  </div>
                </form>
              )}
            </div>
            <div className="s-act" />
          </div>

          <div className="s-step" data-done={hasPlan} data-locked={!project}>
            {n(2, hasPlan)}
            <div>
              <h3>План работ</h3>
              <p>Файл .xlsx или .csv с этапами и датами. Этапы сопоставляются со справочником техники.</p>
              {hasPlan && (
                <div className="s-res">
                  <div>
                    <i />
                    {stages.length} этапов · {fmtDay(stages[0].start)} – {fmtDay(stages[stages.length - 1].end)}
                  </div>
                  <div>
                    <i className={stages.every((s) => s.catalog) ? '' : 'warn'} />
                    Сопоставлено со справочником: {imported ? imported.matched_catalog_count : stages.filter((s) => s.catalog).length} из {stages.length}
                  </div>
                </div>
              )}
            </div>
            <div className="s-act">
              {!hasPlan && (
                <>
                  <label className="btn small">
                    {busy === 'upload' ? 'Загружаем…' : 'Выбрать файл'}
                    <input type="file" accept=".xlsx,.xls,.csv" hidden onChange={(e) => e.target.files?.[0] && run('upload', async () => setImported(await onUploadPlan(e.target.files![0])))} />
                  </label>
                  <button type="button" className="btn small" disabled={busy === 'demo'} onClick={() => run('demo', async () => setImported(await onDemoPlan()))}>
                    {busy === 'demo' ? 'Загружаем…' : 'Взять пример плана'}
                  </button>
                </>
              )}
            </div>
          </div>

          <div className="s-step" data-done={hasSource} data-locked={!hasPlan}>
            {n(3, hasSource)}
            <div>
              <h3>Источник кадров</h3>
              <p>Камера с HTTP/MJPEG-потоком или запись с датой и временем начала съёмки.</p>
              {srcForm === 'camera' && !hasSource && <CameraForm onAdd={onAddCamera} onCheck={onCheck} onCancel={() => setSrcForm(null)} />}
              {srcForm === 'recording' && !hasSource && <RecordingForm onSubmit={(f, s) => { onRecording(f, s); setSrcForm(null) }} onCancel={() => setSrcForm(null)} />}
              {hasSource && (
                <div className="s-res">
                  <div>
                    <i />
                    {obs.mode === 'recording' ? `Запись «${obs.recording?.name}»` : `Камер: ${sourcesCount}`}
                  </div>
                </div>
              )}
            </div>
            <div className="s-act">
              {!hasSource && !srcForm && (
                <>
                  <button type="button" className="btn small" onClick={() => setSrcForm('camera')}>
                    Подключить камеру
                  </button>
                  <button type="button" className="btn small ghost" onClick={() => setSrcForm('recording')}>
                    Открыть запись
                  </button>
                </>
              )}
            </div>
          </div>

          <div className="s-step" data-done={ready && live && obs.model === 'ready' && !!stageNow} data-locked={!ready}>
            {n(4, ready && live && obs.model === 'ready' && !!stageNow)}
            <div>
              <h3>Проверка</h3>
              <p>Кадр приходит, распознавание отвечает, на дату наблюдения есть этап плана.</p>
              {ready && (
                <div className="s-res">
                  <div>
                    <i className={live ? '' : 'wait'} />
                    {live ? 'Кадр получен' : 'Ждём кадр от источника…'}
                  </div>
                  <div>
                    <i className={obs.model === 'ready' ? '' : obs.model === 'down' ? 'bad' : 'wait'} />
                    {obs.model === 'ready' ? 'Распознавание работает' : obs.model === 'down' ? `Распознавание недоступно: ${obs.modelMessage || 'нет ответа'}` : 'Проверяем распознавание…'}
                  </div>
                  <div>
                    <i className={stageNow ? '' : 'warn'} />
                    {stageNow ? `Этап на ${fmtDay(obs.t)}: ${stageNow.n} «${stageNow.name}»` : `На ${fmtDay(obs.t)} в плане нет этапа`}
                  </div>
                </div>
              )}
            </div>
            <div className="s-act" />
          </div>
        </div>
        <div className="setup-go">
          <button type="button" className="btn plan" onClick={onClose} disabled={!ready}>
            Начать контроль
          </button>
          <p>{ready ? (obs.model === 'down' ? 'Распознавание недоступно: экран откроется, но выводов не будет, пока сервис не заработает.' : 'Всё готово.') : 'Кнопка станет доступна после первых трёх шагов.'}</p>
          {project && (
            <button type="button" className="btn ghost small setup-skip" onClick={onClose}>
              Открыть рабочий экран
            </button>
          )}
        </div>
      </div>
    </section>
  )
}
