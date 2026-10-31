import React from 'react'
import ReactDOM from 'react-dom/client'
import './sverka/sverka.css'
import { initTheme } from './sverka/lib/theme'
import { SverkaApp } from './sverka/SverkaApp'

initTheme()

// Clean up any legacy query params or hashes so direct bookmarks resolve cleanly to the main UI
if (location.hash === '#legacy' || new URLSearchParams(location.search).has('legacy')) {
  const url = new URL(location.href)
  url.searchParams.delete('legacy')
  if (url.hash === '#legacy') {
    url.hash = ''
  }
  history.replaceState(null, '', url.href)
}

addEventListener('hashchange', () => {
  if (location.hash === '#legacy') {
    history.replaceState(null, '', location.pathname + location.search)
  }
})

const root = ReactDOM.createRoot(document.getElementById('root')!)
root.render(
  <React.StrictMode>
    <SverkaApp />
  </React.StrictMode>,
)
