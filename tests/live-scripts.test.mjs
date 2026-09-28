import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';

function importedNames(file) {
  const ast = parse(readFileSync(file, 'utf8'), { sourceType: 'module' });
  const names = [];
  for (const node of ast.program.body) {
    if (node.type !== 'ImportDeclaration') continue;
    for (const spec of node.specifiers) {
      names.push(spec.imported?.name || spec.local.name);
    }
  }
  return names;
}

// Anything that moves an item, money or a trade. The live scripts run against
// somebody's real account, so this is enforced rather than promised in a
// comment: a future edit that imports one of these fails the suite.
const MUTATING = [
  'acceptTradeOffer',
  'declineTradeOffer',
  'sendTradeOffer',
  'respondToConfirmation',
  'respondToConfirmations',
  'createSellListing',
  'removeListing',
  'changeMasterPassword',
  'destroyVault',
];

for (const script of ['scripts/verify-live.mjs', 'scripts/verify-live-auth.mjs']) {
  test(`${script} imports nothing that can change account state`, () => {
    const imported = importedNames(script);
    const offenders = imported.filter((name) => MUTATING.includes(name));
    assert.deepEqual(offenders, [], `${script} must stay read-only`);
  });

  test(`${script} never takes credentials from argv`, () => {
    const source = readFileSync(script, 'utf8');
    // argv is fine for a profile or a file path; a password there would land in
    // the user's shell history.
    assert.doesNotMatch(source, /argv\[\d\][^\n]*[Pp]assword/,
      'a password must never be read from a command-line argument');
  });
}

test('the signed-in script masks secrets instead of printing them', () => {
  const source = readFileSync('scripts/verify-live-auth.mjs', 'utf8');
  assert.match(source, /const mask =/, 'needs a masking helper');

  // Check each template interpolation on its own: mask() wraps the value, so it
  // appears before the secret's name and a plain lookahead would miss it.
  const secrets = /\b(accessToken|refreshToken|password|sharedSecret|identitySecret)\b/;
  const unmasked = [];
  for (const [, expression] of source.matchAll(/\$\{([^}]*)\}/g)) {
    if (secrets.test(expression) && !expression.includes('mask(')) unmasked.push(expression.trim());
  }
  assert.deepEqual(unmasked, [], 'these interpolations print a secret unmasked');
});
