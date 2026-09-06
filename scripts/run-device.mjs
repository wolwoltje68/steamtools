#!/usr/bin/env node
// Launch the app on a real device, emulator or browser, with a preflight that
// explains what is missing instead of failing deep inside a native build.
//
//   node scripts/run-device.mjs android      # emulator or USB device
//   node scripts/run-device.mjs ios          # simulator or device (macOS only)
//   node scripts/run-device.mjs web          # browser
//   node scripts/run-device.mjs expo-go      # QR code, any phone, no toolchain
//
// Written in Node rather than shell so it behaves the same on macOS, Linux and
// Windows.
import { execFileSync, spawnSync } from 'node:child_process';
import { platform } from 'node:os';

const target = process.argv[2] || 'expo-go';
const HOST = platform(); // 'darwin' | 'linux' | 'win32'

function have(command, args = ['--version']) {
  try {
    execFileSync(command, args, { stdio: 'ignore' });
    return true;
  } catch (err) {
    return false;
  }
}

function die(message, hints = []) {
  console.error(`\n${message}\n`);
  for (const hint of hints) console.error(`  - ${hint}`);
  console.error('');
  process.exit(1);
}

function start(args) {
  console.log(`\n> npx ${args.join(' ')}\n`);
  const result = spawnSync('npx', args, { stdio: 'inherit', shell: HOST === 'win32' });
  process.exit(result.status ?? 1);
}

switch (target) {
  case 'android': {
    if (!have('adb', ['version'])) {
      die('adb was not found, so no Android device can be reached.', [
        'Install Android Studio, or the platform-tools package on its own.',
        'Then add platform-tools to PATH (e.g. ~/Android/Sdk/platform-tools).',
        'No toolchain? Run `node scripts/run-device.mjs expo-go` instead.',
      ]);
    }
    const devices = execFileSync('adb', ['devices'], { encoding: 'utf8' })
      .split('\n')
      .slice(1)
      .filter((line) => line.trim() && !line.includes('offline'));
    if (devices.length === 0) {
      die('adb found no connected device.', [
        'Start an emulator, or plug in a phone with USB debugging enabled.',
        'Check with: adb devices',
      ]);
    }
    console.log(`Android device(s) ready: ${devices.length}`);
    // run:android compiles a dev build, which is what exercises the native
    // modules (SecureStore, notifications) that Expo Go only partly provides.
    start(['expo', 'run:android']);
    break;
  }

  case 'ios': {
    if (HOST !== 'darwin') {
      die('iOS builds require macOS: the toolchain is Xcode, which Apple ships only for macOS.', [
        'On Linux or Windows, verify the iOS *bundle* instead: node scripts/verify-platforms.mjs ios',
        'Or run the app on an iPhone through Expo Go: node scripts/run-device.mjs expo-go',
        'For installable iOS builds without a Mac, use EAS Build: npx eas build -p ios',
      ]);
    }
    if (!have('xcrun', ['--version'])) {
      die('Xcode command line tools were not found.', ['Install them with: xcode-select --install']);
    }
    start(['expo', 'run:ios']);
    break;
  }

  case 'web':
    start(['expo', 'start', '--web']);
    break;

  case 'expo-go':
    console.log('Starting Metro. Scan the QR code with Expo Go (Android) or the Camera app (iOS).');
    console.log('Note: expo-secure-store has no Expo Go implementation on web, and');
    console.log('notifications are limited there - use a dev build to exercise those.');
    start(['expo', 'start']);
    break;

  default:
    die(`Unknown target "${target}".`, ['Valid targets: android, ios, web, expo-go']);
}
