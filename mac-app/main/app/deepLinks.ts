import { app, type BrowserWindow, type Event } from 'electron';
import path from 'path';

type OpenAppHandler = (agentId: string | null) => void;

function focusMainWindow(mainWindow: BrowserWindow): void {
  mainWindow.show();
  mainWindow.focus();
}

function focusAvailableMainWindow(getMainWindow: () => BrowserWindow | null): BrowserWindow | null {
  const mainWindow = getMainWindow();
  if (mainWindow === null || mainWindow.isDestroyed()) return null;
  focusMainWindow(mainWindow);
  return mainWindow;
}

function forwardPaymentComplete(getMainWindow: () => BrowserWindow | null, success: boolean): void {
  const mainWindow = focusAvailableMainWindow(getMainWindow);
  if (mainWindow === null) return;
  mainWindow.webContents.send('payment-complete', { success });
}

/** OAuth callbacks (Gmail) redirect to `roselabs://oauth-complete?oauth_result=…`. */
function forwardOAuthComplete(getMainWindow: () => BrowserWindow | null, success: boolean): void {
  const mainWindow = focusAvailableMainWindow(getMainWindow);
  if (mainWindow === null) return;
  mainWindow.webContents.send('oauth-complete', { success });
}

export function registerDeepLinkProtocol(protocol: string): void {
  if (process.defaultApp === true && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(protocol, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(protocol);
  }
  console.log(`[App] Registered protocol: ${protocol}://`);
}

export function handleDeepLink(
  url: string,
  getMainWindow: () => BrowserWindow | null,
  openApp: OpenAppHandler
): void {
  console.log('[App] Received deep link:', url);
  try {
    const parsed = new URL(url);
    if (parsed.host === 'open') {
      console.log('[App] Open app deep link received');
      openApp(parsed.searchParams.get('agent-id'));
    } else if (parsed.host === 'payment-success') {
      console.log('[App] Payment success deep link received');
      forwardPaymentComplete(getMainWindow, true);
    } else if (parsed.host === 'oauth-complete') {
      console.log('[App] OAuth complete deep link received');
      forwardOAuthComplete(getMainWindow, parsed.searchParams.get('oauth_result') === 'success');
    } else if (parsed.host === 'payment-cancel') {
      console.log('[App] Payment cancel deep link received');
      forwardPaymentComplete(getMainWindow, false);
    }
  } catch (err) {
    console.error('[App] Failed to parse deep link URL:', err);
  }
}

export function registerOpenUrlHandler(
  getMainWindow: () => BrowserWindow | null,
  openApp: OpenAppHandler
): void {
  app.on('open-url', (event: Event, url: string) => {
    event.preventDefault();
    handleDeepLink(url, getMainWindow, openApp);
  });
}
