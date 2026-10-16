import React from 'react'
import ReactDOM from 'react-dom/client'

/*
 * Two interfaces live side by side for comparison: the new one by default, the original one at
 * #legacy. Each injects only its own stylesheet, so their global rules never meet; switching
 * between them reloads the page.
 */
const isLegacy = () => /(^#|&)legacy\b/.test(location.hash) || new URLSearchParams(location.search).has('legacy')
const legacy = isLegacy()

function injectCss(css: string) {
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
}

const root = ReactDOM.createRoot(document.getElementById('root')!)

if (legacy) {
  Promise.all([import('./styles.css?inline'), import('./App'), import('@fontsource-variable/inter')]).then(([css, mod]) => {
    injectCss(css.default)
    const App = mod.default
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    )
    const back = document.createElement('a')
    back.href = '#'
    back.textContent = 'Новый интерфейс →'
    Object.assign(back.style, { position: 'fixed', right: '16px', bottom: '16px', zIndex: '2000', padding: '8px 14px', borderRadius: '18px', background: '#f2efe9', color: '#121315', font: '500 13px/1.2 system-ui, sans-serif', textDecoration: 'none', boxShadow: '0 10px 30px -10px rgba(0,0,0,.6)' })
    document.body.appendChild(back)
  })
} else {
  Promise.all([import('./sverka/sverka.css?inline'), import('./sverka/SverkaApp')]).then(([css, mod]) => {
    injectCss(css.default)
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#0c0e11')
    const { SverkaApp } = mod
    root.render(
      <React.StrictMode>
        <SverkaApp />
      </React.StrictMode>,
    )
  })
}

addEventListener('hashchange', () => {
  if (isLegacy() !== legacy) location.reload()
})
