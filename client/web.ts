import { Platform } from "react-native";
import { APP_SETTINGS_KEY, LEGACY_SETTINGS_KEY, resolveUiFontSize } from "../shared/host-font";
import { DEFAULT_SEND_SHORTCUT, resolveHostSendShortcut, type HostSendShortcut } from "../shared/host-send-shortcut";

interface StorageEvent {
  key: string | null;
}

interface BrowserHost {
  localStorage?: { getItem(key: string): string | null };
  addEventListener(type: "focus", listener: () => void): void;
  addEventListener(type: "storage", listener: (event: StorageEvent) => void): void;
  removeEventListener(type: "focus", listener: () => void): void;
  removeEventListener(type: "storage", listener: (event: StorageEvent) => void): void;
  matchMedia(query: string): {
    matches: boolean;
    addEventListener(type: "change", listener: () => void): void;
    removeEventListener(type: "change", listener: () => void): void;
  };
}

const browser = globalThis as unknown as BrowserHost;

/** Browser APIs stay behind the platform guard; native clients use AsyncStorage. */
export function readWebUiFontSize(): number | null {
  if (Platform.OS !== "web") return null;
  try {
    const storage = browser.localStorage;
    if (!storage || typeof storage.getItem !== "function") return null;
    const read = (key: string) => {
      try { return storage.getItem(key); } catch { return null; }
    };
    return resolveUiFontSize(read(APP_SETTINGS_KEY), read(LEGACY_SETTINGS_KEY), "web");
  } catch {
    return null;
  }
}

/**
 * 宿主的发送快捷键设置(Settings → General)。每次按键时现读,用户在宿主里改设置后
 * 无需重挂载立即生效;读不到时按宿主默认 Enter 发送。
 */
export function readWebSendShortcut(): HostSendShortcut {
  if (Platform.OS !== "web") return DEFAULT_SEND_SHORTCUT;
  try {
    const storage = browser.localStorage;
    if (!storage || typeof storage.getItem !== "function") return DEFAULT_SEND_SHORTCUT;
    const read = (key: string) => {
      try { return storage.getItem(key); } catch { return null; }
    };
    return resolveHostSendShortcut(read(APP_SETTINGS_KEY), read(LEGACY_SETTINGS_KEY));
  } catch {
    return DEFAULT_SEND_SHORTCUT;
  }
}

export function subscribeWebAppearance(trigger: () => void): () => void {
  if (Platform.OS !== "web" || typeof browser.addEventListener !== "function") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === APP_SETTINGS_KEY || event.key === LEGACY_SETTINGS_KEY) trigger();
  };
  browser.addEventListener("focus", trigger);
  browser.addEventListener("storage", onStorage);
  return () => {
    browser.removeEventListener("focus", trigger);
    browser.removeEventListener("storage", onStorage);
  };
}

export function subscribeWebReducedMotion(onChange: (reduced: boolean) => void): () => void {
  if (Platform.OS !== "web" || typeof browser.matchMedia !== "function") return () => {};
  const query = browser.matchMedia("(prefers-reduced-motion: reduce)");
  const update = () => onChange(query.matches);
  update();
  query.addEventListener("change", update);
  return () => query.removeEventListener("change", update);
}

export function startWebRotation(node: unknown): (() => void) | undefined {
  if (Platform.OS !== "web") return;
  const element = node as {
    animate?: (frames: { transform: string }[], options: { duration: number; iterations: number }) => {
      startTime: number | null;
      cancel(): void;
    };
  } | null;
  if (!element?.animate) return;
  const animation = element.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], { duration: 900, iterations: Infinity });
  animation.startTime = 0;
  return () => animation.cancel();
}
