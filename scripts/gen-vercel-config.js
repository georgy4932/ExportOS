// Generates public/config.js for Vercel deployments.
// Set API_BASE_URL in Vercel project environment variables to the Railway/Render API URL.
// Called by: npm run build:config (configured as Vercel buildCommand in vercel.json)
const fs = require('fs')
const apiBase = (process.env.API_BASE_URL || '').replace(/\/$/, '')
fs.writeFileSync('public/config.js', `window.__API_BASE__ = '${apiBase}';\n`)
console.log(`[build:config] public/config.js → API_BASE_URL="${apiBase}"`)
