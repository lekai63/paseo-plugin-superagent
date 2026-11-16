import type { Translation } from "../../i18n";
import type { host as en } from "../en/host";

export const host: Translation<typeof en> = {
  commandConversations: "Superagent 对话记录",
  commandStatus: "Superagent 运行状态",
  commandSettings: "Superagent 设置",
  slashDescription: "把任务委派给 Superagent 编排(Router 评估 → Worker 执行,结果回到本会话)",
};
