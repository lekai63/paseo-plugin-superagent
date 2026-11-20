# IM triggers (Feishu / DingTalk / WeCom / WeChat / QQ)

[← Back to README](../README.md) · [简体中文](im.md)

In the **IM triggers** section of the settings page, turn on the channel you want and fill in its credentials and **allowlist** (at least one of senders/chats; if everything is empty the channel does not start, which keeps strangers from triggering it; the person who scans the QR code for WeChat is automatically on the allowlist). Saving hot-reloads the channel; there is no need to restart the daemon.

**Tiered admission**: a group message that matches the allowlist but does not @ the bot (Feishu/QQ) is, by default, recorded as **filtered** and kept as a trace (the conversation bubble shows "Filtered · Group message did not @ the bot"; it is not evaluated, not delivered directly, and each thread keeps at most 30). When **Group observe mode** is turned on for that channel, such messages become context triggers handed to the Router to judge (it may ignore them or act as needed), matching the "observe public chats and step in even when not called on" candidate tier from the article. Unmentioned group messages in DingTalk/WeCom are never delivered by the platform, so there is no such tier.

**Non-text content** (Feishu / DingTalk / WeCom / WeChat): images, files, videos and voice messages are downloaded into the "IM attachment inbox directory" (`imInboxDir`, `<directory>/<channel>/<Beijing-time date>/<message id>/<file name>`, mode 0600, at most 100 MB each) and written into the trigger text as one line, `[<Channel> <type>] name (size) saved on this machine: <path>` (for example `[Feishu file]`, `[DingTalk image]`, `[WeCom video]`, `[quoted WeChat file]`). A `.zip`/`.7z`/`.rar` additionally gets a listing of its contents (see the WeChat section). A failed download still triggers as usual, states the reason and asks the user to resend. When the platform provides its own voice transcription (DingTalk, WeCom, WeChat), the transcribed text is used directly. Unmentioned messages in groups (traced messages, observe-mode context) get only an attachment description and are not downloaded. The event callback returns immediately and the download happens in each channel's queue, while messages of the same channel are still handed to the engine in arrival order. If the message gives a file name it is used; otherwise the name from the download response headers is used, and failing that the type is determined from the content and a name is generated (such as `image-1.png`, `audio-1.ogg`). The QQ channel still receives text only.

These lines written into chats, together with other daemon-generated text such as the filtered reason, follow the interface language (see [Usage · Interface language](usage-EN.md#interface-language)); in a Chinese interface they are written in Chinese, and the English forms are shown throughout this document.

> Selection note: we evaluated [openclaw-china](https://github.com/BytePioneer-AI/openclaw-china) (MIT, TypeScript). Its adapters are deeply tied to the OpenClaw host runtime (message routing, session storage and streaming replies all go through the host), so they cannot be imported on their own outside OpenClaw. This plugin therefore connects directly using the **same official SDK matrix**: Feishu `@larksuiteoapi/node-sdk`, DingTalk `dingtalk-stream`, WeCom `@wecom/aibot-node-sdk`, all using official APIs and long-lived connections with no public endpoint. WeChat is the same story: Tencent's official plugin [`@tencent-weixin/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin) has openclaw as a peer dependency and runs on OpenClaw's channel runtime, so we call the same official interface `ilinkai.weixin.qq.com` directly according to its published iLink protocol ([protocol.md](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md)).

## Feishu (official long-lived connection)

1. Create a **self-built enterprise app** on the [Feishu Open Platform](https://open.feishu.cn) and note the App ID / App Secret;
2. Add the **bot** capability; under Events & Callbacks choose **receive events through a long-lived connection**;
3. Subscribe to the event `im.message.receive_v1`; grant the permissions `im:message` and `im:message:send_as_bot`;
4. Publish a version and add the bot to the group or DM;
5. On the settings page fill in: App ID, App Secret, and the allowed sender `open_id` (or chat `chat_id`).

Behavior: a DM triggers directly; in a group the bot must be **@mentioned** (or turn on "Group observe mode" to receive context). The same chat shares one thread for the same day in Beijing time, and a new one is created the next day; a root quote no longer splits threads further. Replies go back to the original message as quote replies.

Non-text: for rich text (post) it takes the title, text, links and code blocks, plus the images and videos in it; images, files, voice messages (raw audio; Feishu provides no transcription) and videos are downloaded through the "get message resource file" interface. When replying to a message that has an attachment (for example replying to that file in a group and @mentioning the bot with "handle this"), the original message is fetched through the "get specified message content" interface and the replied-to file is downloaded. A merged forward lists the text of up to 50 sub-messages. Cards (interactive, such as a forwarded approval card): the event carries only degraded content (a complex card is reduced to its title), so the original card is fetched by calling "get specified message content" with `card_msg_content_type=raw_card_content` and converted into the title, field labels and values, @mentioned names and button links; if it cannot be fetched, the title and card link from the event are used. Feishu does not let a bot download resources inside merged forwards and cards, so such attachments are noted by type only. Folders, contact cards and locations get a one-sentence description, and sticker emoji are ignored. The local app was verified on 2026-11-10 to have permission for both interfaces; if a new app reports insufficient permission, enable them on the open platform as the error message says.

## Answering or approving Worker requests

- **Feishu** supports question forms and permission buttons. Enable long-connection callbacks and subscribe to `card.action.trigger` in the app console.
- **WeCom** uses template cards for permissions and compatible choice questions. Free text and question sets beyond the template controls use text prompts.
- **WeChat, QQ and DingTalk's current sessionWebhook integration** use text prompts. If a platform rejects a card, the plugin sends the text fallback.
- Reply with `/answer <code> <answer>`. Enter option numbers, use commas for multiple selections, and use one `question number: answer` line per question in a set. If the channel returns quoted message IDs, you can also quote the prompt and reply with the answer. Use `/approve <code>` or `/deny <code> [reason]` for permissions.

Answers and permissions are bound to the bot account, chat, and pending request. Text replies in a group follow the channel's mention rules.

## DingTalk (official Stream mode, no public endpoint)

1. Create an in-house enterprise app in the [DingTalk developer console](https://open-dev.dingtalk.com) and note the AppKey / AppSecret;
2. Under app capabilities add a **bot**, choose **Stream mode** for receiving messages, and publish;
3. On the settings page fill in: ClientId, ClientSecret, and the allowed sender `staffId` (or chat `conversationId`).

Behavior: a one-to-one chat triggers directly; in a group only @mentions are received (a DingTalk mechanism). The same conversationId shares one thread for the same day in Beijing time, and a new one is created the next day. Replies go through the message's own sessionWebhook (**it expires**, so a late reply from a long-running Worker task may fail; the failure is logged).

Non-text: rich text (text + images), images, files and videos use the `downloadCode` in the message to call `/v1.0/robot/messageFiles/download` for a temporary address to download from (the access token is obtained with AppKey/AppSecret and cached, and robotCode is taken from the message, defaulting to AppKey); for voice messages the built-in transcription `recognition` is preferred, and the audio is downloaded only when there is no transcription; other types get a one-sentence description. In groups only @mentions are delivered, and group files cannot be handed to the bot directly, so send them in a private chat.

## WeCom (smart bot, official long-lived connection, no public endpoint)

1. Create a **smart bot** in the WeCom admin console and note the botId and Secret;
2. On the settings page fill in: botId, Secret, and the allowed sender `userid` (or group `chatid`).

Behavior: a one-to-one chat triggers directly; in a group the bot must be @mentioned. Replies are sent proactively as separate Markdown messages through `chatId`, with multi-part continuation, and do not reuse a completed `req_id` reply stream. When the channel rejects a send, the unsent content and progress are kept for resending.

Non-text: voice uses the platform's transcribed text; images, mixed text and images, files and videos are downloaded from the url in the message (links are valid for 5 minutes, so they are downloaded on receipt) and decrypted with AES-256-CBC using each link's own aeskey, and the file name comes from the download response headers. When a message with an attachment is quoted, the quoted one is downloaded; the quoted text is appended at the end of the body (WeCom quotes carry no message id, so they cannot be filed by thread).

## WeChat (Tencent's official ClawBot / iLink, QR-code login, no public endpoint)

1. On the settings page turn on "WeChat", click **Scan to log in**, scan the QR code on the settings page with WeChat on your phone and confirm on the phone (when you open the settings page on the phone itself, you can click "open the link in WeChat"; if a verification code is requested, enter the digits shown in WeChat on your phone into the settings page);
2. As needed, enter other people's WeChat user IDs (`xxx@im.wechat`) under "Additional allowed users"; the person who scanned is allowed automatically, so this can be left empty;
3. Save the settings. Afterwards, when you change accounts or the credentials become invalid, click "Scan again" without changing settings; "Log out" deletes the local credentials and stops the channel.

Behavior: DMs only (the official plugin does not open group chat either; group messages from allowlisted users are recorded as filtered with "WeChat group messages are not supported yet"). The same user under the same account shares one thread for the same day in Beijing time, and a new one is created the next day. Messages are received by `getupdates` long polling, the cursor is persisted, and receiving resumes from the breakpoint after a restart; replies carry the inbound message's `context_token` (the latest one per user, falling back after a restart to the one saved in the trigger record). Text and voice transcription are supported. Images, files and videos are downloaded from the WeChat CDN and decrypted with AES-128-ECB per the protocol, and stored at `<IM attachment inbox directory>/weixin/<Beijing-time date>/<message id>/<original file name>` (0600, at most 100 MB each); the local path is written into the trigger text as a line `[WeChat file] name (size) saved on this machine: <path>` and handed to the Router. `.zip`/`.7z`/`.rar` archives are only listed, not extracted: after that line, indented, come the file count, the total size after extraction and the first 30 file names (zip is parsed built in, file names without the UTF-8 flag are decoded as GBK; 7z/rar call the local `7z`), and it flags nested archives, encrypted entries, paths that would escape the extraction directory, symbolic links and suspected zip bombs; packaging metadata such as `__MACOSX/` and `.DS_Store` is only counted. Extraction is left to the Worker, and sizes come from the archive's self-reported metadata and serve only as a hint. A failed download still triggers as usual, states the reason and asks the user to resend. When the message has no attachment itself but quotes a message that has one, the quoted one is downloaded (labeled `[quoted WeChat file]`). Attachments in group messages are not downloaded. A quote reply inlines the original message from `ref_msg`, and only a same-day quote goes back to the original thread. When the server returns `-14` (session expired), it pauses for 1 hour and tries again, as the official plugin does, and the settings page shows the reason.

The credential (bot token) is stored only on the daemon host at `$PASEO_HOME/plugin-data/superagent/weixin/account.json` (0600), not in the plugin settings, and the client sees only the bot ID and the scanner's ID. Use must comply with Tencent's *WeChat ClawBot Terms of Use*; Tencent may throttle or end the capability at any time, so it should not be the only notification channel.

## QQ (OneBot 11, with NapCat; personal account route)

1. Install [NapCat](https://napneko.github.io/) and log in with a QQ number;
2. In its network configuration enable **forward WebSocket** (such as `ws://127.0.0.1:3001`); an Access Token can be set;
3. On the settings page fill in: endpoint, token, and the allowed QQ numbers / group numbers.

Behavior: a DM triggers directly; in a group the bot must be @mentioned (or turn on "Group observe mode" to receive context). Replies carry a quote, and it reconnects automatically after a disconnect. (For the official QQ bot platform route see openclaw-china/qqbot; it requires developer qualification and is not built in yet.)

> Security: IM message text is untrusted input. The Router system prompt already requires treating trigger text as data; the allowlist is the first gate. Credentials are stored in plain text in `$PASEO_HOME/plugin-settings/superagent/` (0600), and the WeChat bot token is stored separately in `$PASEO_HOME/plugin-data/superagent/weixin/` (0600). A WeChat Official Account channel needs a public callback, and the plugin has no HTTP entry point yet, so it is listed as a limitation.
