const APP_ID = 'c1a30beb-bc79-45f6-9cdd-275e663dbcd6';
const basePath = import.meta.env.BASE_URL.replace(/\/?$/, '/');
const workerPath = `${basePath.slice(1)}onesignal/OneSignalSDKWorker.js`;
const workerScope = `${basePath}onesignal/`;
const OPTED_IN_KEY = 'fiudia-member-push-opted-in';

type PushSubscription = {
  optedIn: boolean;
  optIn: () => Promise<void>;
  optOut: () => Promise<void>;
  addEventListener: (name: 'change', listener: () => void) => void;
  removeEventListener: (name: 'change', listener: () => void) => void;
};

type OneSignalSdk = {
  init: (options: {
    appId: string;
    serviceWorkerPath: string;
    serviceWorkerParam: { scope: string };
    notifyButton: { enable: boolean };
    promptOptions: { slidedown: { prompts: Array<{ type: 'push'; autoPrompt: false }> } };
  }) => Promise<void>;
  Notifications: {
    permission: boolean;
    isPushSupported: () => boolean;
    addEventListener: (name: 'permissionChange', listener: () => void) => void;
    removeEventListener: (name: 'permissionChange', listener: () => void) => void;
  };
  User: { PushSubscription: PushSubscription };
};

declare global {
  interface Window {
    OneSignalDeferred?: Array<(sdk: OneSignalSdk) => Promise<void>>;
  }
}

let sdkPromise: Promise<OneSignalSdk> | null = null;
let scriptPromise: Promise<void> | null = null;

export function supportsPushEnvironment() {
  return window.isSecureContext && 'serviceWorker' in navigator && 'Notification' in window;
}

function loadScript(): Promise<void> {
  if (!scriptPromise) {
    scriptPromise = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js';
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        script.remove();
        reject(new Error('Das Push-Modul konnte nicht geladen werden.'));
      };
      document.head.appendChild(script);
    }).catch(error => {
      scriptPromise = null;
      throw error;
    });
  }
  return scriptPromise;
}

export function getOneSignal(): Promise<OneSignalSdk> {
  if (!supportsPushEnvironment()) {
    return Promise.reject(new Error('Push wird auf diesem Gerät oder dieser Verbindung nicht unterstützt.'));
  }
  if (!sdkPromise) {
    sdkPromise = new Promise<OneSignalSdk>((resolve, reject) => {
      window.OneSignalDeferred = window.OneSignalDeferred || [];
      const initialize = async (sdk: OneSignalSdk) => {
        try {
          await sdk.init({
            appId: APP_ID,
            serviceWorkerPath: workerPath,
            serviceWorkerParam: { scope: workerScope },
            notifyButton: { enable: false },
            promptOptions: { slidedown: { prompts: [{ type: 'push', autoPrompt: false }] } },
          });
          resolve(sdk);
        } catch (error) {
          reject(error);
        }
      };
      window.OneSignalDeferred.push(initialize);
      void loadScript().catch(error => {
        window.OneSignalDeferred = window.OneSignalDeferred?.filter(callback => callback !== initialize);
        reject(error);
      });
    }).catch(error => {
      sdkPromise = null;
      throw error;
    });
  }
  return sdkPromise;
}

export function rememberPushChoice(optedIn: boolean) {
  if (optedIn) localStorage.setItem(OPTED_IN_KEY, '1');
  else localStorage.removeItem(OPTED_IN_KEY);
}

// A browser shared by multiple people must not keep an opted-in subscription
// after a member signs out. Failed cleanup is retried on the signed-out page.
export async function optOutOnSignOut() {
  if (!localStorage.getItem(OPTED_IN_KEY)) return;
  const sdk = await getOneSignal();
  await sdk.User.PushSubscription.optOut();
  rememberPushChoice(false);
}