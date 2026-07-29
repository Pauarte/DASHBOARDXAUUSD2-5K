import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { PartnersPage } from './pages/PartnersPage.tsx'

// No router library — this is the only secondary route, kept as a plain
// pathname check so /socis stays out of the public dashboard's nav/bundle
// story entirely.
const Root = window.location.pathname === '/socis' ? PartnersPage : App

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/service-worker.js'))
}
