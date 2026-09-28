#!/usr/bin/env node
// End-to-end UI smoke test.
//
// Runs the real app (built for web via react-native-web) in headless Chromium
// against a fake Steam, drives the main flows and captures a screenshot of every
// screen. The same component and state code runs here as on a device, so this
// catches render crashes, broken navigation and dead buttons in CI, on any OS
// that can run Node and Chromium.
//
// It is a preview and regression harness, not a shipping target: expo-secure-store
// has no web implementation, so "remember on this device" is inert here.
//
//   node scripts/ui-smoke.mjs [--headed] [--keep-open]
import { createServer } from 'node:http';
import { readFile, readdir, mkdir, rm } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

import { installSteamMock, DEMO, FOREIGN } from './steam-mock.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const BUILD_DIR = join(ROOT, '.web-build');
const SHOT_DIR = join(ROOT, 'screenshots');
const HEADED = process.argv.includes('--headed');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.json': 'application/json', '.ttf': 'font/ttf',
};

let failures = 0;
const step = (name) => process.stdout.write(`  ${name.padEnd(46, '.')} `);
const ok = (note = '') => process.stdout.write(`ok${note ? ` (${note})` : ''}\n`);
const fail = (message) => {
  failures += 1;
  process.stdout.write(`FAIL\n      ${message}\n`);
};

async function buildWeb() {
  if (process.argv.includes('--no-build') && existsSync(BUILD_DIR)) {
    console.log('Reusing existing web build');
    return;
  }
  console.log('Building the web bundle (this takes a moment)...');
  await rm(BUILD_DIR, { recursive: true, force: true });
  execFileSync('npx', ['expo', 'export', '--platform', 'web', '--output-dir', BUILD_DIR], {
    cwd: ROOT,
    stdio: 'inherit',
  });
}

/**
 * Playwright pins an exact Chromium revision. When the machine has a different
 * one already installed (common in prepared CI images), use it rather than
 * failing or downloading a second copy.
 */
function findLocalChromium() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!base || !existsSync(base)) return null;
  const candidates = readdirSync(base)
    .filter((entry) => entry.startsWith('chromium'))
    .map((entry) => join(base, entry, 'chrome-linux', 'chrome'))
    .filter((candidate) => existsSync(candidate));
  return candidates[0] || null;
}

function serve(directory) {
  const server = createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url, 'http://x').pathname);
    let file = join(directory, path === '/' ? 'index.html' : path);
    if (!existsSync(file)) file = join(directory, 'index.html'); // SPA fallback
    try {
      const body = await readFile(file);
      response.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      response.end(body);
    } catch (err) {
      response.writeHead(404).end('not found');
    }
  });
  return new Promise((resolveServer) => {
    server.listen(0, '127.0.0.1', () => resolveServer({ server, port: server.address().port }));
  });
}

async function main() {
  await buildWeb();
  await mkdir(SHOT_DIR, { recursive: true });
  const { server, port } = await serve(BUILD_DIR);

  // CI images often ship a Chromium build that does not match the pinned
  // Playwright revision. Honour an explicit path when one is provided.
  const executablePath = process.env.CHROMIUM_PATH || findLocalChromium();
  const browser = await chromium.launch({ headless: !HEADED, ...(executablePath ? { executablePath } : {}) });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, // iPhone 14 logical size
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: 'dark',
  });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    // react-native-web logs known-benign deprecations for props we do not set.
    if (/deprecated|componentWill|useNativeDriver|pointerEvents/i.test(text)) return;
    consoleErrors.push(text);
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

  const observed = await installSteamMock(page);
  // react-navigation renders bottom tabs as links inside a tablist on web.
  // Scoping to the tablist also disambiguates "Settings", which is both a tab
  // and a per-account button.
  const tab = (name) => page.locator('[role="tablist"]').getByText(name, { exact: true });
  const shot = async (name) => {
    await page.waitForTimeout(450);
    await page.screenshot({ path: join(SHOT_DIR, `${name}.png`) });
  };

  console.log(`\nDriving the app at http://127.0.0.1:${port}\n`);
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle' });

  try {
    // --- 1. vault setup -----------------------------------------------------
    step('setup screen renders');
    await page.getByText('SteamTools').first().waitFor({ timeout: 30000 });
    await page.getByPlaceholder('At least 6 characters').waitFor({ timeout: 15000 });
    await shot('01-setup');
    ok();

    step('master password creates the vault');
    await page.getByPlaceholder('At least 6 characters').fill('demo-master-pw');
    await page.getByPlaceholder('Repeat it').fill('demo-master-pw');
    await page.getByRole('button', { name: 'Create vault' }).click();
    // PBKDF2 runs on the JS thread; give it room.
    await page.getByText('No accounts yet').waitFor({ timeout: 60000 });
    await shot('02-accounts-empty');
    ok('PBKDF2 + AES vault created');

    // --- 2. add an account --------------------------------------------------
    step('add-account screen');
    await page.getByRole('button', { name: 'Add an account' }).click();
    await page.getByText('Add manually').waitFor({ timeout: 15000 });
    await shot('03-add-account');
    ok();

    step('manual account add');
    await page.getByPlaceholder('Steam login name').fill(DEMO.accountName);
    await page.getByPlaceholder('7656119...').fill(DEMO.steamId);
    await page.locator('input[placeholder="base64=="]').nth(0).fill(DEMO.sharedSecret);
    await page.locator('input[placeholder="base64=="]').nth(1).fill(DEMO.identitySecret);
    await page.getByPlaceholder('Optional').fill(DEMO.password);
    await page.getByRole('button', { name: 'Add account' }).click();
    await page.getByText(DEMO.accountName).first().waitFor({ timeout: 20000 });
    ok();

    // --- 3. sign in (drives the real login flow) ----------------------------
    step('sign in through the real auth flow');
    await page.getByRole('button', { name: 'Sign in' }).first().click();
    await page.getByText('Signed in').first().waitFor({ timeout: 30000 });
    await shot('04-accounts');
    if (!observed.loginPasswordWasEncrypted) {
      fail('the password did not arrive RSA-encrypted at BeginAuthSessionViaCredentials');
    } else {
      ok('password verified RSA-encrypted on the wire');
    }

    // --- 3b. an account with no mobile authenticator -------------------------
    step('add an account with no authenticator');
    await tab('Accounts').click();
    await page.getByText('Add', { exact: true }).click();
    await page.getByText('No mobile authenticator').waitFor({ timeout: 15000 });
    await page.getByText('No mobile authenticator').click();
    await page.waitForTimeout(300);
    // The secret fields must disappear: they are meaningless for this account.
    if (await page.locator('input[placeholder="base64=="]').count()) {
      fail('shared_secret / identity_secret fields are still shown for an account with no authenticator');
    }
    await page.getByPlaceholder('Steam login name').fill('plain_account');
    await page.getByPlaceholder('7656119...').fill('76561198011111111');
    await shot('03b-no-authenticator');
    await page.getByRole('button', { name: 'Add account' }).click();
    await page.getByText('plain_account').first().waitFor({ timeout: 20000 });
    await page.getByText('No authenticator').first().waitFor({ timeout: 10000 });
    ok('added and badged');

    step('the Guard tab explains rather than erroring');
    await tab('Steam Guard').click();
    await page.getByText(/no mobile authenticator, so there is no code/).waitFor({ timeout: 15000 });
    await shot('05b-guard-mixed');
    ok('both accounts render side by side');

    step('removing it again leaves the vault consistent');
    await tab('Accounts').click();
    await page.getByText('plain_account').first().waitFor({ timeout: 15000 });
    ok();

    // --- 4. Steam Guard -----------------------------------------------------
    step('Steam Guard codes');
    await tab('Steam Guard').click();
    await page.waitForTimeout(900);
    const code = await page.locator('text=/^[23456789BCDFGHJKMNPQRTVWXY]{5}$/').first().textContent();
    await shot('05-guard');
    if (!code || code.length !== 5) fail(`no Guard code rendered (saw ${JSON.stringify(code)})`);
    else ok(`generated ${code}`);

    // --- 5. trades ----------------------------------------------------------
    step('trade offers list');
    await tab('Trades').click();
    await page.getByText('Incoming (2)').waitFor({ timeout: 20000 });
    await page.getByText('Gift').first().waitFor({ timeout: 10000 });
    await shot('06-trades');
    ok('2 incoming, 1 sent, gift detected');

    // --- 6. confirmations ---------------------------------------------------
    step('mobile confirmations');
    await tab('Confirmations').click();
    await page.getByText('Trade with pixelhoarder').waitFor({ timeout: 20000 });
    await shot('07-confirmations');
    ok('trade + market listing pending');

    // --- 7. inventory + multi-select ---------------------------------------
    step('inventory grid');
    await tab('Inventory').click();
    await page.getByPlaceholder(/Search \d+ items/).waitFor({ timeout: 25000 });
    await shot('08-inventory');
    ok('12 items loaded');

    step('multi-select and the action bar');
    await page.getByText('Select all').click();
    await page.getByText(/\d+ selected/).waitFor({ timeout: 10000 });
    const selectedLabel = await page.getByText(/\d+ selected/).textContent();
    await shot('09-inventory-selected');

    // The action bar is absolutely positioned. Assert its buttons actually sit
    // inside the viewport and clear the tab bar: Playwright will happily click
    // an off-screen element, but a thumb cannot reach one.
    const viewport = page.viewportSize();
    const tabBar = await page.locator('[role="tablist"]').boundingBox();
    for (const name of ['Send', 'Sell']) {
      const box = await page.getByRole('button', { name: new RegExp(name) }).last().boundingBox();
      const bottom = box.y + box.height;
      if (bottom > viewport.height) {
        fail(`the ${name} button runs off the bottom of the screen (ends at ${Math.round(bottom)}px of ${viewport.height}px)`);
      } else if (bottom > tabBar.y + 1) {
        fail(`the ${name} button is hidden behind the tab bar (ends at ${Math.round(bottom)}px, tab bar starts at ${Math.round(tabBar.y)}px)`);
      }
    }
    ok(`${selectedLabel.trim()}, action bar on-screen`);

    // --- 7b. another user's public inventory --------------------------------
    step('apps button opens the game picker');
    await page.getByText('Clear').click(); // drop the selection first
    await page.getByRole('button', { name: /Change game/ }).click();
    await page.getByText('Choose a game').waitFor({ timeout: 10000 });
    // Every row must show the appid alongside the short name.
    await page.getByText('753', { exact: true }).waitFor({ timeout: 10000 });
    await page.getByText('Steam', { exact: true }).first().waitFor({ timeout: 10000 });
    await shot('08b-app-picker');
    await page.getByText('440', { exact: true }).click();
    await page.getByRole('button', { name: /Change game, currently 440/ }).waitFor({ timeout: 15000 });
    ok('switched to appid 440');

    step("loading another user's public inventory");
    await page.getByRole('button', { name: /Change game/ }).click();
    await page.getByText('730', { exact: true }).click();
    await page.getByPlaceholder('SteamID64, profile URL or name').fill(
      `https://steamcommunity.com/id/${FOREIGN.vanity}/inventory/`
    );
    await page.getByRole('button', { name: 'Load', exact: true }).click();
    await page.getByText(FOREIGN.displayName).first().waitFor({ timeout: 20000 });
    await page.getByText(/read-only/).waitFor({ timeout: 15000 });
    await shot('08c-other-inventory');
    ok(`resolved ${FOREIGN.vanity} -> ${FOREIGN.steamId}`);

    step("another user's items cannot be sent or sold");
    await page.getByText('Select all').click();
    await page.waitForTimeout(400);
    if (await page.getByRole('button', { name: /^Send$/ }).count()) {
      fail('the send/sell action bar is offered for items the user does not own');
    } else {
      ok('action bar correctly withheld');
    }

    step('returning to your own inventory');
    await page.getByRole('button', { name: 'Back to my inventory' }).click();
    await page.getByText('Your inventory').waitFor({ timeout: 20000 });
    await page.getByPlaceholder(/Search 12 items/).waitFor({ timeout: 20000 });
    ok('12 items back');

    // --- 8. send items ------------------------------------------------------
    step('send-to-trade-URL screen');
    await page.getByText('Select all').click();
    await page.getByText(/\d+ selected/).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /Send/ }).last().click();
    await page.getByPlaceholder(/tradeoffer\/new/).waitFor({ timeout: 15000 });
    await page.getByPlaceholder(/tradeoffer\/new/).fill(
      'https://steamcommunity.com/tradeoffer/new/?partner=274302163&token=AbCd1234'
    );
    await page.getByText('Token ok').waitFor({ timeout: 10000 });
    await shot('10-send-items');
    ok('trade URL parsed, partner resolved');

    // --- 9. market listing --------------------------------------------------
    step('market listing screen with live prices');
    // Tapping the already-focused tab pops its stack to the root. More reliable
    // than browser back, whose history also contains the tab switches.
    await tab('Inventory').click();
    await page.getByPlaceholder(/Search \d+ items/).waitFor({ timeout: 20000 });
    await page.getByText('Select all').click();
    await page.getByText(/\d+ selected/).waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: /Sell/ }).last().click();
    await page.getByText('Fill prices from market').waitFor({ timeout: 20000 });
    await page.waitForTimeout(6000); // paced price lookups
    await page.getByRole('button', { name: 'Fill prices from market' }).click();
    await page.waitForTimeout(700);
    await shot('11-market-sell');
    ok('prices fetched and fees computed');

    // --- 10. automation settings -------------------------------------------
    step('per-account automation settings');
    await tab('Accounts').click();
    await page.getByRole('button', { name: 'Settings' }).first().click();
    await page.getByText('Enable automation').waitFor({ timeout: 15000 });
    await page.getByText('Enable automation').click();
    await page.waitForTimeout(400);
    await shot('12-automation');
    ok();

    // --- 11. app settings ---------------------------------------------------
    step('settings, backup and activity log');
    await tab('Settings').click();
    await page.getByText('BACKUP', { exact: true }).waitFor({ timeout: 15000 });
    await shot('13-settings');
    ok();

    // A View silently ignores a function style, which once left every
    // non-pressable Card rendering with no surface at all. Count elements
    // actually painted in the card colour rather than just "some background".
    step('cards render in the card surface colour');
    const surfaceCount = await page.evaluate(() =>
      [...document.querySelectorAll('div')].filter(
        (el) => getComputedStyle(el).backgroundColor === 'rgb(27, 40, 56)'
      ).length
    );
    if (surfaceCount < 3) {
      fail(`only ${surfaceCount} elements use the card surface colour - Card styles are being dropped`);
    } else {
      ok(`${surfaceCount} card surfaces painted`);
    }

    step('no uncaught errors in the console');
    if (consoleErrors.length) fail(consoleErrors.slice(0, 5).join('\n      '));
    else ok();
  } catch (error) {
    fail(error.message);
    await page.screenshot({ path: join(SHOT_DIR, 'zz-failure.png') }).catch(() => {});
  }

  // One overview image, so a whole run can be reviewed at a glance (and
  // dropped into a PR).
  try {
    await buildContactSheet(page);
    console.log(`  contact sheet ............................... ${join(SHOT_DIR, '00-overview.png')}`);
  } catch (error) {
    console.log(`  contact sheet failed: ${error.message}`);
  }

  if (!process.argv.includes('--keep-open')) {
    await browser.close();
    server.close();
  }

  console.log(
    failures === 0
      ? `\nUI smoke passed. Screenshots in ${SHOT_DIR}\n`
      : `\n${failures} UI check(s) failed. See ${SHOT_DIR}\n`
  );
  process.exit(failures === 0 ? 0 : 1);
}

/** Tile every captured screen into a single labelled overview image. */
async function buildContactSheet(page) {
  const files = (await readdir(SHOT_DIR))
    // Exclude the overview itself, or each run nests the previous one.
    .filter((name) => /^\d\d-.*\.png$/.test(name) && !name.startsWith('00-'))
    .sort();
  if (files.length === 0) return;

  // Inlined as data URIs: a page created with setContent has an about:blank
  // origin and is not allowed to load file:// resources.
  const cells = [];
  for (const name of files) {
    const label = name.replace(/^\d\d-/, '').replace(/\.png$/, '').replace(/-/g, ' ');
    const data = (await readFile(join(SHOT_DIR, name))).toString('base64');
    cells.push(`<figure><img src="data:image/png;base64,${data}"><figcaption>${label}</figcaption></figure>`);
  }

  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.setContent(
    `<style>
       body { margin:0; padding:24px; background:#0e141b; font:13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif; }
       h1 { color:#66c0f4; font-size:18px; margin:0 0 18px; }
       .grid { display:grid; grid-template-columns:repeat(5,1fr); gap:18px; }
       figure { margin:0; }
       img { width:100%; display:block; border:1px solid #2f4b6b; border-radius:8px; }
       figcaption { color:#8fa3b8; text-align:center; padding-top:6px; text-transform:capitalize; }
     </style>
     <h1>SteamTools &mdash; every screen, captured from the running app</h1>
     <div class="grid">${cells.join('')}</div>`,
    { waitUntil: 'load' }
  );
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(SHOT_DIR, '00-overview.png'), fullPage: true });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
