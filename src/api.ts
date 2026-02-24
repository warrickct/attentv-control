// In production, always use same origin (empty string) so the app works when
// served from any host (EC2 IP, domain, etc.). Only use VITE_API_URL in dev
// or when explicitly pointing at a different backend.
const raw = import.meta.env.VITE_API_URL ?? ''
const isProd = import.meta.env.PROD
const isLocalhost = /^https?:\/\/localhost(:\d+)?\/?$/i.test(raw)
export const API_URL =
  isProd && (!raw || isLocalhost) ? '' : raw || 'http://localhost:3001'
