import { Platform } from "react-native";
import { APP_SETTINGS_KEY, LEGACY_SETTINGS_KEY, resolveHostAppearance, resolveUiFontSize, type HostAppearance } from "../shared/host-font";
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

/** Paseo 外观设置(界面/正文字号、内容列宽度);非 Web 或读不到存储时为 null。 */
export function readWebAppearance(): HostAppearance | null {
  if (Platform.OS !== "web") return null;
  try {
    const storage = browser.localStorage;
    if (!storage || typeof storage.getItem !== "function") return null;
    const read = (key: string) => {
      try { return storage.getItem(key); } catch { return null; }
    };
    return resolveHostAppearance(read(APP_SETTINGS_KEY), read(LEGACY_SETTINGS_KEY), "web");
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

/**
 * 运行点的呼吸(better-paseo `RunningDot`):1200ms 一个周期在全不透明与 30% 之间往返,
 * 用 CSS 动画在合成层上跑,React 不参与每一帧。
 */
export function startWebPulse(node: unknown): (() => void) | undefined {
  if (Platform.OS !== "web") return;
  const element = node as {
    animate?: (frames: { opacity: number }[], options: { duration: number; iterations: number; easing: string }) => {
      startTime: number | null;
      cancel(): void;
    };
  } | null;
  if (!element?.animate) return;
  const animation = element.animate([{ opacity: 1 }, { opacity: 0.3 }, { opacity: 1 }],
    { duration: 1200, iterations: Infinity, easing: "cubic-bezier(0.33, 1, 0.68, 1)" });
  // 所有运行点共用同一个时钟,同屏的几个点一起呼吸。
  animation.startTime = 0;
  return () => animation.cancel();
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
