import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';

const traverse = traverseModule.default || traverseModule;

function ast(file) {
  return parse(readFileSync(file, 'utf8'), { sourceType: 'module', plugins: ['jsx'] });
}

// The engine must be constructed once. If its effect depends on callbacks that
// change identity (persist -> updateAccounts -> ensureSession, which used to
// churn on every settings change), the engine is rebuilt while the separate
// start/stop effect does not re-run, and automation stops silently.
test('the automation engine is constructed in an effect with no dependencies', () => {
  let found = false;
  traverse(ast('src/state/AppContext.js'), {
    CallExpression(path) {
      if (path.node.callee.name !== 'useEffect') return;
      const source = path.toString();
      if (!source.includes('new AutomationEngine')) return;
      found = true;
      const deps = path.node.arguments[1];
      assert.ok(deps, 'the engine effect must declare a dependency array');
      assert.equal(deps.type, 'ArrayExpression');
      assert.deepEqual(deps.elements, [], 'the engine effect must have empty deps');
    },
  });
  assert.ok(found, 'could not find the AutomationEngine construction effect');
});

test('persist does not close over settings state', () => {
  const source = readFileSync('src/state/AppContext.js', 'utf8');
  const persist = source.slice(source.indexOf('const persist = useCallback'));
  const body = persist.slice(0, persist.indexOf('const updateAccounts'));
  assert.match(body, /settingsRef\.current/, 'persist must read settings through a ref');
  assert.match(body, /\},\s*\[\]\);/, 'persist must have empty deps to stay stable');
});

// Screens re-fetch when their dependency array changes. ensureSession rewrites
// the account object after renewing a token, so depending on the object rather
// than its id causes an extra round trip on every refresh.
test('per-account screens key their loaders on the account id', () => {
  for (const file of [
    'src/screens/TradesScreen.js',
    'src/screens/ConfirmationsScreen.js',
    'src/screens/InventoryScreen.js',
    'src/screens/MarketSellScreen.js',
  ]) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /\[activeAccount,/, `${file} still depends on the account object`);
    assert.match(source, /activeAccount\?\.id/, `${file} should depend on activeAccount?.id`);
  }
});
