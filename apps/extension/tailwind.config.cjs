const path = require('node:path')
const web = require('../../tailwind.config.js')
module.exports = {
  ...web,
  content: [
    path.join(__dirname, 'src/**/*.{ts,tsx,html}'),
    path.join(__dirname, '../../packages/chat-ui/src/**/*.{ts,tsx}'),
  ],
}
