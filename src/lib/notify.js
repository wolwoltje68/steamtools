// Local notifications for automation events. Notifications are a nicety, so
// every failure here is swallowed rather than allowed to break automation.
import * as Notifications from 'expo-notifications';

let configured = false;
let permitted = false;

export async function setupNotifications() {
  if (configured) return permitted;
  configured = true;
  try {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert: true,
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
    });
    const existing = await Notifications.getPermissionsAsync();
    permitted = existing.granted;
    if (!permitted && existing.canAskAgain) {
      permitted = (await Notifications.requestPermissionsAsync()).granted;
    }
  } catch (err) {
    permitted = false;
  }
  return permitted;
}

export async function notify(title, body) {
  if (!permitted) return;
  try {
    await Notifications.scheduleNotificationAsync({ content: { title, body }, trigger: null });
  } catch (err) {
    // Ignore: a missing notification must never break automation.
  }
}
