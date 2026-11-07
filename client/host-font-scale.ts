import { useEffect, useSyncExternalStore } from "react";
// Paseo 0.15 eagerly copies namespace imports. Import only the modules we use,
// otherwise loading this file also initializes unrelated native modules on iOS.
import { NativeModules, Platform, TurboModuleRegistry } from "react-native";
import {
  APP_SETTINGS_KEY,
  LEGACY_SETTINGS_KEY,
  defaultHostAppearance,
  resolveHostAppearance,
  sameHostAppearance,
  type HostAppearance,
} from "../shared/host-font";
import { readWebAppearance, subscribeWebAppearance } from "./web";

/**
 * 跟随 Paseo 外观设置(Settings → Appearance 的界面字号、正文字号与内容宽度)。宿主没有给插件
 * 字号 API,与 better-paseo 一样只读宿主持久化的 app settings:Web/桌面读 localStorage,
 * iOS/Android 经宿主已链接的 RNCAsyncStorage 读同一份 JSON;读不到时用平台默认。从不写入宿主存储。
 *
 * 宿主改外观后会给插件新的 theme,此时(以及窗口重新获得焦点、其他窗口改了设置时)
 * 重新读一次;读取节流到 500ms,并在触发后补读一次,覆盖宿主异步写入稍晚落地的情况。
 */

type MultiGet = (keys: string[], callback: (errors?: unknown, result?: [string, string | null][]) => void) => void;

const PLATFORM = Platform.OS;
const RECHECK_MS = 500;
const TRAILING_MS = 600;

let appearance: HostAppearance = defaultHostAppearance(PLATFORM);
let checkedAt = -Infinity;
let nativeInflight = false;
let trailing: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
let unsubscribeWeb: (() => void) | null = null;

function nativeMultiGet(): MultiGet | null {
  if (PLATFORM !== "ios" && PLATFORM !== "android") return null;
  try {
    const turbo = TurboModuleRegistry?.get?.("RNCAsyncStorage") as { multiGet?: MultiGet } | null;
    if (typeof turbo?.multiGet === "function") return turbo.multiGet.bind(turbo);
  } catch {
    // 新架构下模块未注册时 get 可能抛错,退回旧桥接。
  }
  try {
    const legacy = NativeModules?.RNCAsyncStorage as { multiGet?: MultiGet } | undefined;
    return typeof legacy?.multiGet === "function" ? legacy.multiGet.bind(legacy) : null;
  } catch {
    return null;
  }
}

function readNative(multiGet: MultiGet, key: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      multiGet([key], (_errors, result) => {
        const value = result?.[0]?.[1];
        resolve(typeof value === "string" ? value : null);
      });
    } catch {
      resolve(null);
    }
  });
}

function accept(next: HostAppearance) {
  if (sameHostAppearance(next, appearance)) return;
  appearance = next;
  for (const listener of [...listeners]) listener();
}

function check(now = Date.now()) {
  if (now - checkedAt < RECHECK_MS) return;
  checkedAt = now;
  const web = readWebAppearance();
  if (web !== null) {
    accept(web);
    return;
  }
  const multiGet = nativeMultiGet();
  if (!multiGet || nativeInflight) return;
  nativeInflight = true;
  void Promise.all([readNative(multiGet, APP_SETTINGS_KEY), readNative(multiGet, LEGACY_SETTINGS_KEY)])
    .then(([current, legacy]) => accept(resolveHostAppearance(current, legacy, PLATFORM)))
    .catch(() => {})
    .finally(() => { nativeInflight = false; });
}

function trigger() {
  check();
  if (trailing !== null) return;
  trailing = setTimeout(() => {
    trailing = null;
    check();
  }, TRAILING_MS);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) unsubscribeWeb = subscribeWebAppearance(trigger);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      unsubscribeWeb?.();
      unsubscribeWeb = null;
      if (trailing !== null) clearTimeout(trailing);
      trailing = null;
    }
  };
}

function snapshot() {
  check();
  return appearance;
}

/** 用户当前的 Paseo 外观设置;传入宿主 theme,外观变更时重读。返回值在设置不变时保持同一对象。 */
export function useHostAppearance(hostTheme: unknown): HostAppearance {
  const value = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => { trigger(); }, [hostTheme]);
  return value;
}

/** 用户当前的 Paseo 界面字号(默认 Web 14、iOS/Android 15)。 */
export function useHostUiFontSize(hostTheme: unknown): number {
  return useHostAppearance(hostTheme).uiFontSize;
}
