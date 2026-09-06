import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@babel/parser';

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

test('every source file parses as ESM + JSX', () => {
  const files = [...walk('src'), 'App.js', 'index.js'];
  assert.ok(files.length > 0);
  for (const file of files) {
    try {
      parse(readFileSync(file, 'utf8'), { sourceType: 'module', plugins: ['jsx'] });
    } catch (err) {
      assert.fail(`${file}: ${err.message}`);
    }
  }
});

test('relative imports use explicit extensions and resolve', () => {
  const files = walk('src');
  const missing = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
    for (const node of ast.program.body) {
      const spec = node.source?.value;
      if (!spec || !spec.startsWith('.')) continue;
      if (!spec.endsWith('.js')) { missing.push(`${file} -> ${spec} (no extension)`); continue; }
      const resolved = join(file, '..', spec);
      try { statSync(resolved); } catch { missing.push(`${file} -> ${spec} (not found)`); }
    }
  }
  assert.deepEqual(missing, []);
});
