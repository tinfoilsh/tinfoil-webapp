// Publishes the id of the Vercel deployment being built at /deployment.json,
// which a page left open compares with the deployment it was built in to
// reload once a newer one replaces it (src/services/reload-when-updated.ts).
// Runs before `next build`. Outside Vercel the id is empty, and pages built
// there never reload.
import fs from 'node:fs'

fs.writeFileSync(
  'public/deployment.json',
  `${JSON.stringify({ id: process.env.VERCEL_DEPLOYMENT_ID ?? '' })}\n`,
)
