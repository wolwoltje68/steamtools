import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';

const traverse = traverseModule.default || traverseModule;

function analyse(file) {
  const ast = parse(readFileSync(file, 'utf8'), { sourceType: 'module', plugins: ['jsx'] });
  const literalRequires = [];
  let requireAliased = false;
  let usesMathRandom = false;

  traverse(ast, {
    CallExpression(path) {
      const callee = path.node.callee;
      if (callee.type === 'Identifier' && callee.name === 'require') {
        const arg = path.node.arguments[0];
        if (arg && arg.type === 'StringLiteral') literalRequires.push(arg.value);
      }
      if (
        callee.type === 'MemberExpression' &&
        callee.object.name === 'Math' &&
        callee.property.name === 'random'
      ) {
        usesMathRandom = true;
      }
    },
    // `const r = require` / `foo(require)` -- any use of require not as a callee.
    Identifier(path) {
      if (path.node.name !== 'require') return;
      if (path.parent.type === 'CallExpression' && path.parent.callee === path.node) return;
      requireAliased = true;
    },
  });

  return { literalRequires, requireAliased, usesMathRandom };
}

// Metro collects native dependencies only from literal `require('...')` calls.
// Aliasing require bundles cleanly but drops the module, leaving the app with no
// CSPRNG on a real device -- a failure that never shows up in Node tests.
test('expo-crypto is required literally so Metro bundles it', () => {
  const { literalRequires, requireAliased } = analyse('src/lib/random.js');
  assert.ok(literalRequires.includes('expo-crypto'), 'needs a literal require("expo-crypto")');
  assert.equal(requireAliased, false, 'require must not be aliased or passed around');
});

test('randomness never falls back to Math.random', () => {
  assert.equal(analyse('src/lib/random.js').usesMathRandom, false);
});
