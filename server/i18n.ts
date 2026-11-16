import { translator, type Language, type Translate } from "../shared/i18n";

/**
 * daemon 侧文字的语言。插件服务端拿不到 app 的语言设置,由客户端经
 * `superagent.set_locale` 上报(简体中文 → zh-CN,其余 → en),记在状态 kv 里跨重启保留;
 * 从未上报过时用英文。多个客户端语言不同时以最近一次上报为准。
 *
 * 只影响之后生成的文字:已落盘的触发正文、通知与线程标题保持原样。
 */
let current: Language = "en";

export function serverLanguage(): Language {
  return current;
}

export function setServerLanguage(language: Language): void {
  current = language;
}

/** 按当前 daemon 语言翻译;`t.lang` 随 setServerLanguage 实时变化。 */
export const t: Translate = Object.defineProperty(
  ((key: Parameters<Translate>[0], ...args: never[]) => (translator(current) as (...input: unknown[]) => string)(key, ...args)) as unknown as Translate,
  "lang",
  { get: () => current, enumerable: true },
);
