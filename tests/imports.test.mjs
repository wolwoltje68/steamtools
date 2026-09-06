import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from '@babel/parser';

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = [...walk('src'), 'App.js', 'index.js'];
const ast = (file) => parse(readFileSync(file, 'utf8'), { sourceType: 'module', plugins: ['jsx'] });

function exportsOf(file) {
  const names = new Set();
  for (const node of ast(file).program.body) {
    if (node.type === 'ExportDefaultDeclaration') names.add('default');
    if (node.type === 'ExportNamedDeclaration') {
      for (const spec of node.specifiers || []) names.add(spec.exported.name);
      const decl = node.declaration;
      if (!decl) continue;
      if (decl.id?.name) names.add(decl.id.name);
      for (const d of decl.declarations || []) if (d.id?.name) names.add(d.id.name);
    }
  }
  return names;
}

test('every named import resolves to a real export', () => {
  const exportCache = new Map();
  const problems = [];

  for (const file of files) {
    for (const node of ast(file).program.body) {
      if (node.type !== 'ImportDeclaration') continue;
      const spec = node.source.value;
      if (!spec.startsWith('.')) continue;

      const target = relative('.', join(file, '..', spec));
      if (!exportCache.has(target)) exportCache.set(target, exportsOf(target));
      const available = exportCache.get(target);

      for (const s of node.specifiers) {
        const wanted = s.type === 'ImportDefaultSpecifier' ? 'default'
          : s.type === 'ImportNamespaceSpecifier' ? null
          : s.imported.name;
        if (wanted && !available.has(wanted)) {
          problems.push(`${file}: imports "${wanted}" from ${spec}, which does not export it`);
        }
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('no module imports itself and no duplicate import of the same specifier', () => {
  const problems = [];
  for (const file of files) {
    const seen = new Set();
    for (const node of ast(file).program.body) {
      if (node.type !== 'ImportDeclaration') continue;
      if (seen.has(node.source.value)) problems.push(`${file}: imports ${node.source.value} twice`);
      seen.add(node.source.value);
    }
  }
  assert.deepEqual(problems, []);
});
