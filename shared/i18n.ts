import { en } from "./locales/en/index";
import { zhCN } from "./locales/zh-CN/index";

/**
 * 插件界面语言:Paseo 设为简体中文时用简体中文,其余语言一律英文。
 *
 * 资源按 i18next 约定书写(`{{name}}` 插值、`_one`/`_other` 复数后缀),同一份资源既交给
 * SDK 的 `defineTranslations`(宿主渲染的标题、命令等),也由下面的 `translate` 在
 * client 组件、shared 纯函数与 daemon 里直接使用,三处译文与回退规则一致。
 */
export type Language = "en" | "zh-CN";

export type MessageTree = { readonly [key: string]: string | MessageTree };

type PluralSuffix = "zero" | "one" | "two" | "few" | "many" | "other";
type MinorPlural = Exclude<PluralSuffix, "other">;

/**
 * 其他语言的资源形状:与英文同键、叶子为任意字符串;`_other` 之外的复数形式可省
 * (中文只用 `_other`)。用它标注译文,漏译或多出的键在 typecheck 时报错。
 */
export type Translation<T> = {
  readonly [K in keyof T as K extends `${string}_${MinorPlural}` ? never : K]: T[K] extends string ? string : Translation<T[K]>;
} & {
  readonly [K in keyof T as K extends `${string}_${MinorPlural}` ? K : never]?: string;
};

type Join<Prefix extends string, Key extends string> = Prefix extends "" ? Key : `${Prefix}.${Key}`;
type BaseKey<Key extends string> = Key extends `${infer Base}_${PluralSuffix}` ? Base : Key;
type KeysOf<T, Prefix extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? Join<Prefix, BaseKey<K>> : KeysOf<T[K], Join<Prefix, K>>;
}[keyof T & string];

/** 全部消息键(点分路径;复数键写基础名并传 `count`)。 */
export type MessageKey = KeysOf<typeof en>;

type Lookup<T, Key extends string> = Key extends `${infer Head}.${infer Rest}`
  ? Head extends keyof T ? Lookup<T[Head], Rest> : never
  : Key extends keyof T ? T[Key] : never;
type Placeholders<Value> = Value extends `${string}{{${infer Name}}}${infer Rest}` ? Name | Placeholders<Rest> : never;
type Source<Key extends string> = Lookup<typeof en, Key> | Lookup<typeof en, `${Key}_one`> | Lookup<typeof en, `${Key}_other`>;
/** 某个键在英文原文里要求的插值名。 */
export type MessageVars<Key extends MessageKey> = Placeholders<Source<Key>>;
export type MessageValue = string | number;
type Args<Key extends MessageKey> = [MessageVars<Key>] extends [never]
  ? []
  : [vars: { readonly [Name in MessageVars<Key>]: MessageValue }];

export interface Translate {
  <Key extends MessageKey>(key: Key, ...args: Args<Key>): string;
  readonly lang: Language;
}

const RESOURCES: Readonly<Record<Language, MessageTree>> = { en, "zh-CN": zhCN };

/**
 * 宿主上报的语言 → 插件语言。宿主已把系统语言解析成它支持的标签(简体中文为 `zh-CN`);
 * 这里与宿主的归一规则一致地接受 `zh`、`zh-Hans*`,其余(含繁体)都回到英文。
 */
export function resolveLanguage(locale: string | null | undefined): Language {
  const tag = (locale ?? "").trim().toLowerCase().replace(/_/g, "-");
  if (tag === "zh" || tag === "zh-cn" || tag === "zh-hans" || tag.startsWith("zh-hans-")) return "zh-CN";
  return "en";
}

function lookup(tree: MessageTree, path: string): string | undefined {
  let node: string | MessageTree | undefined = tree;
  for (const part of path.split(".")) {
    if (!node || typeof node === "string") return undefined;
    node = node[part];
  }
  return typeof node === "string" ? node : undefined;
}

/** 只需英文与中文的复数规则;不依赖 Intl.PluralRules(Hermes 不一定提供)。 */
function pluralForm(lang: Language, count: number): MinorPlural | "other" {
  return lang === "en" && count === 1 ? "one" : "other";
}

const PLACEHOLDER = /{{\s*-?\s*([^},\s]+)[^}]*}}/g;

function interpolate(template: string, vars: Readonly<Record<string, MessageValue>> | undefined): string {
  if (!vars) return template;
  return template.replace(PLACEHOLDER, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

/** 按 i18next 的查找顺序取译文:复数形式 → `_other` → 原键;缺失时回落英文,再缺返回键名。 */
export function translate(lang: Language, key: string, vars?: Readonly<Record<string, MessageValue>>): string {
  const count = vars?.count;
  for (const language of lang === "en" ? (["en"] as const) : ([lang, "en"] as const)) {
    const tree = RESOURCES[language];
    let template: string | undefined;
    if (typeof count === "number") {
      template = lookup(tree, `${key}_${pluralForm(language, count)}`) ?? lookup(tree, `${key}_other`);
    }
    template ??= lookup(tree, key);
    if (template !== undefined) return interpolate(template, vars);
  }
  return key;
}

export const LANGUAGES: readonly Language[] = ["en", "zh-CN"];

/**
 * 一个无插值消息在所有语言里的写法(去重)。用于按名称找回插件早先创建的实体,
 * 例如切换语言后仍能认出用另一种语言命名的持久工作区。
 */
export function allTranslations(key: MessageKey): string[] {
  return [...new Set(LANGUAGES.map((lang) => translate(lang, key)))];
}

const translators = new Map<Language, Translate>();

/** 固定语言的翻译函数;同一语言返回同一实例,可放心作为 React 依赖。 */
export function translator(lang: Language): Translate {
  let t = translators.get(lang);
  if (!t) {
    const fn = (key: string, vars?: Readonly<Record<string, MessageValue>>) => translate(lang, key, vars);
    t = Object.assign(fn, { lang }) as unknown as Translate;
    translators.set(lang, t);
  }
  return t;
}
