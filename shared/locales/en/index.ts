import { chat } from "./chat";
import { host } from "./host";
import { labels } from "./labels";
import { server } from "./server";
import { settings } from "./settings";
import { sidebar } from "./sidebar";
import { validation } from "./validation";
import { weixin } from "./weixin";

/** English is the source language: every key exists here, other languages fall back to it. */
export const en = { host, labels, validation, chat, sidebar, settings, weixin, server } as const;
