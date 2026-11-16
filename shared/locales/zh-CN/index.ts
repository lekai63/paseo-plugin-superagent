import type { Translation } from "../../i18n";
import type { en } from "../en/index";
import { chat } from "./chat";
import { host } from "./host";
import { labels } from "./labels";
import { server } from "./server";
import { settings } from "./settings";
import { sidebar } from "./sidebar";
import { validation } from "./validation";
import { weixin } from "./weixin";

export const zhCN: Translation<typeof en> = { host, labels, validation, chat, sidebar, settings, weixin, server };
