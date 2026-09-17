const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const { execFileSync } = require('child_process');
const root = path.join(__dirname, '..');
for (const folder of ['', 'services', 'tests', 'scripts']) for (const name of fs.readdirSync(path.join(root, folder))) {
  const file = path.join(root, folder, name);
  if (name.endsWith('.js')) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (name.endsWith('.html')) for (const match of fs.readFileSync(file, 'utf8').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) if (match[1].trim()) acorn.parse(match[1], { ecmaVersion: 'latest' });
}
console.log('JavaScript and inline HTML scripts passed syntax checks.');
