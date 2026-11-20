import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { SuperagentStore } from "./server/store";
import { SuperagentEngine } from "./server/engine";
import {
  createCancelTicketHandler,
  createCloseThreadHandler,
  createDispatchHandler,
  createForceEvalHandler,
  createRespondToPermissionHandler,
  createRetryTicketHandler,
  createRetryImDeliveryHandler,
  createSaveChatTabsHandler,
  createStateHandler,
  createUnsubscribeHandler,
} from "./server/handlers";
import { createSessionOpenTransform, orchestrationPermission, resolveMcpProviders } from "./server/agent-mcp";
import { startDispatchMcpServer, type SuperagentMcpEndpoint } from "./server/mcp-server";
import { ImManager, resolveImInboxDir } from "./server/im";
import { FeishuSource } from "./server/feishu";
import { QqSource } from "./server/qq";
import { DingtalkSource } from "./server/dingtalk";
import { WecomSource } from "./server/wecom";
import { WeixinSource } from "./server/weixin";
import { WeixinLogin } from "./server/weixin-login";
import { clearWeixinAccount, loadWeixinAccount, saveWeixinAccount } from "./server/weixin-store";
import { readFilePreview, statPaths } from "./server/file-preview";
import { readPiPermissionModes } from "./server/pi-modes";
import {
  superagentCancelTicketRpc,
  superagentCloseThreadRpc,
  superagentDispatchRpc,
  superagentForceEvalRpc,
  superagentReadFileRpc,
  superagentRespondToPermissionRpc,
  superagentRetryTicketRpc,
  superagentRetryImDeliveryRpc,
  superagentPiModesRpc,
  superagentSaveChatTabsRpc,
  superagentSetLocaleRpc,
  superagentStateEventsSubscription,
  superagentStateRpc,
  superagentStatFilesRpc,
  superagentUnsubscribeRpc,
  superagentWeixinAccountRpc,
  superagentWeixinStatusRpc,
} from "./shared/rpc";
import type { WeixinStatus } from "./shared/weixin";
import { resolveLanguage } from "./shared/i18n";
import { setServerLanguage } from "./server/i18n";
import {
  parseAllowlist,
  superagentSettings,
  type SuperagentSettingsValues,
} from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  const store = new SuperagentStore();
  const settings = server.registerSettings(superagentSettings);
  const engine = new SuperagentEngine(store, settings);

  // daemon 侧文字的语言:先用上次客户端上报并落盘的语言,之后随 set_locale 更新。
  void store.ready.then(() => {
    const saved = store.get().kv.language;
    if (saved) setServerLanguage(saved);
  });

  // SDK 只把 paseo 交给 handler 和 hook:每个入口都 prime 引擎,
  // 无头 daemon 重启后第一个 hook/RPC 就会把看门狗拉起来。
  const withPrime =
    <Input, Output>(
      handler: (input: Input, context: PluginHandlerContext) => Output | Promise<Output>,
    ) =>
    (input: Input, context: PluginHandlerContext): Output | Promise<Output> => {
      engine.prime(context.paseo);
      return handler(input, context);
    };

  server.handle(superagentDispatchRpc, withPrime(createDispatchHandler(engine)));
  server.handle(superagentStateRpc, withPrime(createStateHandler(engine)));
  // 状态变化推送(Paseo 0.16 插件订阅):先推当前版本(新订阅与断线重订都据此补读),
  // 之后每次变化推新版本。handler 必须同步返回——返回 promise 时它一结束订阅就会关闭。
  server.handle(superagentStateEventsSubscription, (_input, { paseo, push, signal }) => {
    engine.prime(paseo);
    const send = (revision: string) => {
      push({ revision }).catch((error: unknown) => {
        if (!signal.aborted) console.error("[superagent] state event push failed", error);
      });
    };
    const off = engine.onStateChange(send);
    signal.addEventListener("abort", off, { once: true });
    send(engine.revision);
  });
  server.handle(superagentForceEvalRpc, withPrime(createForceEvalHandler(engine)));
  server.handle(superagentCancelTicketRpc, withPrime(createCancelTicketHandler(engine)));
  server.handle(superagentRespondToPermissionRpc, withPrime(createRespondToPermissionHandler(engine)));
  server.handle(superagentRetryTicketRpc, withPrime(createRetryTicketHandler(engine)));
  server.handle(superagentRetryImDeliveryRpc, withPrime(createRetryImDeliveryHandler(engine)));
  server.handle(superagentCloseThreadRpc, withPrime(createCloseThreadHandler(engine)));
  server.handle(superagentUnsubscribeRpc, withPrime(createUnsubscribeHandler(engine)));
  server.handle(superagentSaveChatTabsRpc, withPrime(createSaveChatTabsHandler(engine)));
  server.handle(superagentSetLocaleRpc, withPrime(async ({ locale }) => {
    const language = resolveLanguage(locale);
    await store.ready;
    setServerLanguage(language);
    if (store.get().kv.language !== language) {
      await store.update((next) => {
        next.kv = { ...next.kv, language };
      });
    }
    return { ok: true };
  }));
  // 对话页文件预览:只读、限量,不经引擎。
  server.handle(superagentReadFileRpc, withPrime((input) => readFilePreview(input.path)));
  server.handle(superagentStatFilesRpc, withPrime(async (input) => ({ kinds: await statPaths(input.paths) })));
  // pi 权限模式候选(pi-permission-modes):设置页 provider 选 pi 时的 Worker 模式来源。
  server.handle(superagentPiModesRpc, withPrime(() => readPiPermissionModes()));

  // agent 委派与编排工具入口:插件自持的本地 MCP endpoint(按调用方角色下发
  // superagent_dispatch / Router 回读 / Worker 退订转回工具),经 session_open 注入。
  // 通道独立于宿主 "Paseo tools" 开关。注意:角色工具只能走这条注入路径——写进
  // agent 保存配置会与插件注入同名冲突,daemon 会拒绝建会话。
  let dispatchEndpoint: SuperagentMcpEndpoint | null = null;
  startDispatchMcpServer(engine)
    .then((endpoint) => {
      dispatchEndpoint = endpoint;
    })
    .catch((error) => {
      console.error("[superagent] dispatch mcp server failed to start", error);
    });

  // agent 委派 MCP 注入:settings.agentToolEnabled 且目标不是编排自身的 agent。
  const agentToolTransform = createSessionOpenTransform(
    () => dispatchEndpoint,
    () => current.agentToolEnabled,
    () => resolveMcpProviders(current.agentToolProviders),
  );

  // IM 触发源:插件启动即连接(不等引擎 prime——宿主不在启动时提供 Paseo 句柄,
  // 无头重启后可能很久才有首个 hook/RPC);引擎启动前到达的消息先落盘排队,启动后补处理。
  // 答复经 ImManager 发回原聊天。
  const im = new ImManager();
  engine.setReplySink(im);
  im.setHandler((message) => {
    void engine
      .dispatch({
        title: message.title,
        task: message.text,
        sender: message.sender,
        origin: message.origin,
        threadKey: message.threadKey,
        context: message.context,
        replyTo: message.replyTo,
      })
      .catch((error) => {
        console.error("[superagent] IM trigger dispatch failed", error);
      });
  });
  // 准入丢弃留痕(§3.1):白名单命中但被规则挡下的消息记 filtered,不再静默丢弃。
  im.setDropHandler((drop) => {
    void engine
      .dispatchFiltered(
        {
          title: drop.title,
          task: drop.text,
          sender: drop.sender,
          origin: drop.origin,
          threadKey: drop.threadKey,
          replyTo: drop.replyTo,
        },
        drop.reason,
      )
      .catch((error) => {
        console.error("[superagent] IM filtered-record failed", error);
      });
  });

  function imSignature(values: SuperagentSettingsValues): string {
    return JSON.stringify({
      f: [values.feishuEnabled, values.feishuAppId, values.feishuAppSecret, values.feishuAllowUsers, values.feishuAllowChats, values.feishuObserve],
      q: [values.qqEnabled, values.qqEndpoint, values.qqToken, values.qqAllowUsers, values.qqAllowGroups, values.qqObserve],
      d: [values.dingtalkEnabled, values.dingtalkClientId, values.dingtalkClientSecret, values.dingtalkAllowUsers, values.dingtalkAllowChats],
      w: [values.wecomEnabled, values.wecomBotId, values.wecomSecret, values.wecomAllowUsers, values.wecomAllowChats],
      x: [values.weixinEnabled, values.weixinAllowUsers],
    });
  }

  /** IM 附件收件目录:各通道每条消息现取,改设置不必重连。 */
  const imInboxDir = () => resolveImInboxDir(current.imInboxDir);

  // 微信:凭证来自扫码登录(daemon 本机文件),不在设置里;扫码人自动进白名单。
  let weixinSource: WeixinSource | null = null;

  async function wantedWeixinSource(values: SuperagentSettingsValues): Promise<WeixinSource | null> {
    if (!values.weixinEnabled) return null;
    const account = await loadWeixinAccount();
    if (!account) {
      console.warn("[superagent] weixin source enabled but not logged in; scan the QR code in settings");
      return null;
    }
    const users = [...new Set([...(account.userId ? [account.userId] : []), ...parseAllowlist(values.weixinAllowUsers)])];
    if (users.length === 0) {
      console.warn("[superagent] weixin source enabled but allowlist is empty; not starting (unsafe)");
      return null;
    }
    return new WeixinSource({ account, allowUsers: users, inboxDir: imInboxDir });
  }

  // IM 启停串行执行:设置保存与扫码登录可能同时触发重连。
  let imSyncChain: Promise<void> = Promise.resolve();
  function queueImSync(task: () => Promise<void>): Promise<void> {
    const run = imSyncChain.then(task);
    imSyncChain = run.catch((error) => {
      console.error("[superagent] IM source sync failed", error);
    });
    return imSyncChain;
  }

  /** 只重启微信通道(登录/退出后),不打断其他通道的连接。 */
  async function syncWeixinSource(): Promise<void> {
    const next = await wantedWeixinSource(current);
    if (!next) {
      await im.stopChannel("weixin");
      weixinSource = null;
      return;
    }
    weixinSource = next;
    await im.register(next).catch((error) => {
      console.error("[superagent] IM source failed to start", error);
    });
  }

  const weixinLogin = new WeixinLogin({
    loadAccount: loadWeixinAccount,
    onConfirmed: async (account) => {
      await saveWeixinAccount(account);
      await queueImSync(syncWeixinSource);
    },
  });

  async function weixinStatus(): Promise<WeixinStatus> {
    const account = await loadWeixinAccount();
    return {
      account: account ? { botId: account.botId, userId: account.userId ?? null, savedAt: account.savedAt } : null,
      login: weixinLogin.snapshot(),
      source: weixinSource && im.has("weixin") ? weixinSource.status() : null,
    };
  }

  server.handle(superagentWeixinStatusRpc, withPrime(() => weixinStatus()));
  server.handle(
    superagentWeixinAccountRpc,
    withPrime(async (input) => {
      switch (input.action) {
        case "login":
          await weixinLogin.start();
          break;
        case "verify":
          weixinLogin.verify(input.code ?? "");
          break;
        case "cancel":
          weixinLogin.cancel();
          break;
        case "logout":
          weixinLogin.cancel();
          // 先停轮询再删凭证与游标,避免轮询把游标写回来。
          await queueImSync(async () => {
            await im.stopChannel("weixin");
            weixinSource = null;
            await clearWeixinAccount();
          });
          break;
      }
      return weixinStatus();
    }),
  );

  async function syncImSources(): Promise<void> {
    const values = current;
    const wanted = new Map<string, Promise<void>>();
    if (values.feishuEnabled) {
      const users = parseAllowlist(values.feishuAllowUsers);
      const chats = parseAllowlist(values.feishuAllowChats);
      if (!values.feishuAppId || !values.feishuAppSecret) {
        console.warn("[superagent] feishu source enabled but appId/appSecret missing; not starting");
      } else if (users.length === 0 && chats.length === 0) {
        console.warn("[superagent] feishu source enabled but allowlists are empty; not starting (unsafe)");
      } else {
        wanted.set(
          "feishu",
          im.register(
            new FeishuSource({
              appId: values.feishuAppId,
              appSecret: values.feishuAppSecret,
              allowUsers: users,
              allowChats: chats,
              observeGroups: values.feishuObserve,
              inboxDir: imInboxDir,
            }),
          ),
        );
      }
    }
    if (values.qqEnabled) {
      const users = parseAllowlist(values.qqAllowUsers);
      const groups = parseAllowlist(values.qqAllowGroups);
      if (!values.qqEndpoint) {
        console.warn("[superagent] qq source enabled but endpoint missing; not starting");
      } else if (users.length === 0 && groups.length === 0) {
        console.warn("[superagent] qq source enabled but allowlists are empty; not starting (unsafe)");
      } else {
        wanted.set(
          "qq",
          im.register(
            new QqSource({
              endpoint: values.qqEndpoint,
              token: values.qqToken,
              allowUsers: users,
              allowGroups: groups,
              observeGroups: values.qqObserve,
            }),
          ),
        );
      }
    }
    if (values.dingtalkEnabled) {
      const users = parseAllowlist(values.dingtalkAllowUsers);
      const chats = parseAllowlist(values.dingtalkAllowChats);
      if (!values.dingtalkClientId || !values.dingtalkClientSecret) {
        console.warn("[superagent] dingtalk source enabled but clientId/clientSecret missing; not starting");
      } else if (users.length === 0 && chats.length === 0) {
        console.warn("[superagent] dingtalk source enabled but allowlists are empty; not starting (unsafe)");
      } else {
        wanted.set(
          "dingtalk",
          im.register(
            new DingtalkSource({
              clientId: values.dingtalkClientId,
              clientSecret: values.dingtalkClientSecret,
              allowUsers: users,
              allowChats: chats,
              inboxDir: imInboxDir,
            }),
          ),
        );
      }
    }
    if (values.wecomEnabled) {
      const users = parseAllowlist(values.wecomAllowUsers);
      const chats = parseAllowlist(values.wecomAllowChats);
      if (!values.wecomBotId || !values.wecomSecret) {
        console.warn("[superagent] wecom source enabled but botId/secret missing; not starting");
      } else if (users.length === 0 && chats.length === 0) {
        console.warn("[superagent] wecom source enabled but allowlists are empty; not starting (unsafe)");
      } else {
        wanted.set(
          "wecom",
          im.register(
            new WecomSource({
              botId: values.wecomBotId,
              secret: values.wecomSecret,
              allowUsers: users,
              allowChats: chats,
              inboxDir: imInboxDir,
            }),
          ),
        );
      }
    }
    const weixin = await wantedWeixinSource(values);
    if (weixin) {
      weixinSource = weixin;
      wanted.set("weixin", im.register(weixin));
    }
    for (const channel of ["feishu", "qq", "dingtalk", "wecom", "weixin"] as const) {
      if (wanted.has(channel)) continue;
      await im.stopChannel(channel);
      if (channel === "weixin") weixinSource = null;
    }
    for (const start of wanted.values()) {
      await start.catch((error) => {
        console.error("[superagent] IM source failed to start", error);
      });
    }
  }

  // 设置订阅:默认值起步,读取与保存都刷新快照;IM 配置变化热重载 source。
  let current: SuperagentSettingsValues = superagentSettings.schema.parse({});
  let lastImSignature = imSignature(current);
  void settings.read().then((state) => {
    if (state.status !== "ready") return;
    current = state.values;
    const signature = imSignature(current);
    if (signature !== lastImSignature) {
      lastImSignature = signature;
      void queueImSync(syncImSources);
    }
  });
  settings.subscribe((state) => {
    if (state.status !== "ready") return;
    current = state.values;
    const signature = imSignature(current);
    if (signature === lastImSignature) return;
    lastImSignature = signature;
    void queueImSync(syncImSources);
  });

  // hook 同时用于 prime 与注入:无头重启后首个 session_open 就把引擎拉起来。
  const removeSessionOpen = server.before("agent.session_open", ({ request }, context) => {
    engine.prime(context.paseo);
    return agentToolTransform(request);
  });

  // 编排 agent 的权限策略:Router/看门狗只裁决不执行(非自身工具一律拒绝),
  // Worker 的退订/转回工具自动放行;其余请求交 Router 决策或转告用户。
  const removePermissionHook = server.addHook("agent.permission.before", async ({ agent, request }, context) => {
    engine.prime(context.paseo);
    await store.ready;
    const decision = orchestrationPermission(engine.orchestrationRole(agent.id), request);
    if (!decision) {
      if (engine.orchestrationRole(agent.id) === "worker") await engine.syncWorkerPermissions(agent.id);
      return;
    }
    try {
      await context.paseo.agents.ref(agent.id).respondToPermission({ requestId: request.id, response: decision });
    } catch (error) {
      console.error("[superagent] permission response failed", error);
    }
  });

  const removePermissionResolvedHook = server.addHook("agent.permission.after", async ({ agent, requestId, resolution }, context) => {
    engine.prime(context.paseo);
    await store.ready;
    await engine.workerPermissionResolved(agent.id, { requestId, behavior: resolution.behavior });
  });

  // hook 仅用于 prime(无头重启后到首个 RPC 之间保持引擎活着)。
  const hookRemovers = (["agent.created", "agent.turn_ended", "workspace.created"] as const).map(
    (event) =>
      server.on(event, (_payload, context) => {
        engine.prime(context.paseo);
      }),
  );

  return () => {
    for (const remove of hookRemovers) remove();
    removeSessionOpen();
    removePermissionHook();
    removePermissionResolvedHook();
    void dispatchEndpoint?.stop();
    weixinLogin.cancel();
    void im.stopAll();
    void engine.stop();
  };
}
