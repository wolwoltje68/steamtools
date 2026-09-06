// Writing a file to the cache and handing it to the OS share sheet is the only
// reliable way to get data off the device on both platforms.
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';

/**
 * @returns {Promise<boolean>} false when the platform cannot share, so callers
 * can fall back to the clipboard.
 */
export async function shareText(filename, contents, mimeType = 'application/json') {
  try {
    if (!(await Sharing.isAvailableAsync())) return false;
    const path = `${FileSystem.cacheDirectory}${filename}`;
    await FileSystem.writeAsStringAsync(path, contents);
    await Sharing.shareAsync(path, { mimeType, dialogTitle: filename, UTI: 'public.json' });
    return true;
  } catch (err) {
    return false;
  }
}
