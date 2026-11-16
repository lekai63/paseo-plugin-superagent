import { useEffect, useRef } from "react";
import { defineTranslations, useRpc, useTranslation } from "@getpaseo/plugin/client";
import { resolveLanguage, translator, type Translate } from "../shared/i18n";
import { en } from "../shared/locales/en/index";
import { zhCN } from "../shared/locales/zh-CN/index";
import { superagentSetLocaleRpc } from "../shared/rpc";

/**
 * 同一份资源交给宿主:宿主渲染的标题、命令中心条目与斜杠命令说明用
 * `messages.message(key)`,随 app 语言切换而不必重新注册。
 */
export const messages = defineTranslations({ resources: { en, "zh-CN": zhCN } });

/** 组件内的翻译函数:跟随 app 语言(简体中文 → 中文,其余 → 英文),切换语言时重渲染。 */
export function useT(): Translate {
  const { locale } = useTranslation(messages);
  return translator(resolveLanguage(locale));
}

/**
 * 把 app 语言告诉 daemon:IM 消息描述、引擎通知、扫码状态等由 daemon 生成的文字
 * 按最近一次上报的语言书写。侧栏行常驻挂载,由它在挂载与切换语言时上报。
 */
export function useReportLocale(hostId: string): void {
  const { locale } = useTranslation(messages);
  const report = useRpc(superagentSetLocaleRpc);
  const reportRef = useRef(report);
  reportRef.current = report;
  useEffect(() => {
    void reportRef.current({ locale }).catch(() => {
      // 旧 daemon 或连接中断:daemon 维持上次的语言,下次挂载再报。
    });
  }, [locale, hostId]);
}
