"use strict";
const fs = require('node:fs');
const path = require('node:path');

function assertNoBuildPath(text, forbidden, name) {
  for (const value of forbidden) {
    for (const variant of new Set([value, value.replace(/\\/g, '/'), JSON.stringify(value).slice(1, -1)])) {
      if (variant && text.includes(variant)) throw new Error(`Runtime artifact embeds an ephemeral build path: ${value} (${name})`);
    }
  }
  if (/\bvar\s+__(?:dirname|filename)\s*=\s*["']/.test(text)) {
    throw new Error(`Runtime artifact embeds a build-time module path: ${name}`);
  }
}

function auditRuntimePaths(root, forbidden) {
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, {withFileTypes:true})) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && /\.(?:js|cjs|mjs|cmd)$/.test(entry.name)) {
        assertNoBuildPath(fs.readFileSync(file, 'utf8'), forbidden, path.relative(root, file));
      }
    }
  }
  visit(root);
}
module.exports = {assertNoBuildPath, auditRuntimePaths};
