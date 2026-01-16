/**
 * Custom ESLint plugin for Ivy.
 *
 * Add rule files to eslint/ and they'll be automatically loaded.
 * Use in eslint.config.js as: plugins: { ivy: require('./eslint') }
 * Then enable rules as: 'ivy/rule-name': 'error'
 */

const fs = require('fs')
const path = require('path')

const rules = {}

const files = fs.readdirSync(__dirname)

for (const file of files) {
  if (file === 'index.js') continue
  if (!file.endsWith('.js')) continue

  const ruleName = file.replace('.js', '')
  rules[ruleName] = require(path.join(__dirname, file))
}

module.exports = { rules }
