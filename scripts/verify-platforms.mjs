#!/usr/bin/env node
// Cross-platform build verification.
//
// Bundles the app for each target and checks the result, so a change that
// breaks one platform is caught without needing a device for each. Metro
// resolves platform-specific modules differently per target (.android.js /
// .ios.js / .web.js), which is exactly where "works on my phone" bugs hide.
//
//   node scripts/verify-platforms.mjs [android] [ios] [web]
//
// Every target builds on any OS: bundling is pure JavaScript. Producing an
// installable binary is what needs the platform toolchain (Xcode for iOS,
// the Android SDK for Android) -- see scripts/run-device.sh.
import { execFile } from 'node:child_process';
import { mkdtemp, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ALL = ['android', 'ios', 'web'];
const targets = process.argv.slice(2).filter((arg) => ALL.includes(arg));
const chosen = targets.length ? targets : ALL;

// Native platforms compile to Hermes bytecode; web emits plain JavaScript.
const EXPECTED = {
  android: { ext: '.hbc', minBytes: 500_000 },
  ios: { ext: '.hbc', minBytes: 500_000 },
  web: { ext: '.js', minBytes: 200_000 },
};

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else out.push(full);
  }
  return out;
}

let failed = 0;

for (const platform of chosen) {
  const outDir = await mkdtemp(join(tmpdir(), `steamtools-${platform}-`));
  process.stdout.write(`  ${platform.padEnd(10)} bundling... `);
  const started = Date.now();

  try {
    await run('npx', ['expo', 'export', '--platform', platform, '--output-dir', outDir], {
      maxBuffer: 32 * 1024 * 1024,
    });

    const files = await walk(outDir);
    const { ext, minBytes } = EXPECTED[platform];
    const bundles = files.filter((file) => file.endsWith(ext) && file.includes('index-'));
    if (bundles.length === 0) {
      throw new Error(`no ${ext} bundle was emitted`);
    }

    const size = (await stat(bundles[0])).size;
    if (size < minBytes) {
      throw new Error(`bundle is only ${size} bytes, expected at least ${minBytes} - modules are probably missing`);
    }

    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`ok  ${(size / 1024 / 1024).toFixed(2)} MB in ${seconds}s`);
  } catch (error) {
    failed += 1;
    console.log('FAIL');
    console.log(`      ${(error.stderr || error.message).toString().trim().split('\n').slice(-6).join('\n      ')}`);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

console.log(
  failed === 0
    ? `\nAll ${chosen.length} platform bundle(s) built.\n`
    : `\n${failed} of ${chosen.length} platform bundle(s) failed.\n`
);
process.exit(failed === 0 ? 0 : 1);
