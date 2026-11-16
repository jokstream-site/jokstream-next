import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      // Caching is an optimization; playback must continue without a service worker.
    })
  }, { once: true })
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
