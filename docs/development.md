# 开发与发布

[← 返回 README](../README-CN.md) · [English](development-EN.md)

## 本地开发

```bash
npm install
npm run typecheck
npm test
paseo plugin install /absolute/path/to/paseo-plugin-superagent   # 以本地目录安装
paseo plugin reload superagent                                    # 改代码后重载
```

若 daemon 尚未开启插件,先在 `$PASEO_HOME/config.json` 打开 `pluginsEnabled` 再 `paseo reload`。

目录:`shared/`(领域模型 + RPC 契约 + 设置,两端共用;`shared/locales/` 是中英文界面文字,`shared/i18n.ts` 是翻译函数;execution 提供直通判定与会话状态推导)、`server/`(store/router/workers/engine)、`client/`(对话页 chat-screen、顶部标签 chat-tab-bar 与其本机副本 chat-tabs-store、消息流 chat-messages、输入框 chat-composer、右侧栏 chat-sidebar、设置页 settings-screen(基础/模型/规则/执行/IM 五个标签页共享一份模块级草稿),以及 ui.tsx 里的按钮/徽标/提示条等小型原语;`shared/chat.ts` 把线程的触发与裁决排成对话)。引擎细节见 `server/engine.ts` 头注。

`npm test` 使用 Node.js 24+ 的内置测试运行器与现有 TypeScript 依赖,验证 Worker 续跑、投递失败回退、取消竞态、重启恢复与飞书连接清理;不连接真实 provider 或 IM 服务。

## 界面文字与翻译

- 英文是源语言:所有界面文字写在 `shared/locales/en/<命名空间>.ts`,简体中文在 `shared/locales/zh-CN/` 下的同名文件里,用 `Translation<typeof en>` 标注,漏译或多出的键在 `npm run typecheck` 时报错。
- 键用点分路径(`chat.composer.send`),插值写 `{{name}}`,复数用 `_one`/`_other` 加数值 `count`(中文只写 `_other`)。`shared/i18n.ts` 的 `Translate` 类型按英文原文检查键名与必填插值。
- 组件里用 `client/i18n.ts` 的 `useT()`;shared 纯函数接收 `t` 参数;daemon 用 `server/i18n.ts` 的 `t`(语言来自客户端 `superagent.set_locale` 上报)。宿主渲染的标题、命令中心与斜杠命令用 `messages.message(key)`。
- 不要在模块顶层调用 `t` 或把译文存进常量;不翻译日志、用户/agent 内容与发给模型的提示词。
- `tests/i18n.test.mjs` 检查中英文键与插值一致、宿主按 app 语言解析标题,并扫描源码:注释以外的中文字符串字面量必须移进 `shared/locales`(搜索关键词等有意保留的写在白名单里)。

## 发布(CNB)

`.cnb.yml` 在 `main` 推送与指向 `main` 的 PR 上跑类型检查与测试;推送 `v*` Tag 时发布 npm 包 `@0_0/paseo-plugin-superagent` 到 CNB npm 制品库 `https://npm.cnb.cool/0_0/paseo/superagent-plugin/-/packages/`,并创建同名 Release。

1. 更新版本号(不自动打 Tag):`npm version 0.2.0 --no-git-tag-version`,提交 `package.json` 与 `package-lock.json`;
2. 打 Tag 并推送:`git tag v0.2.0 && git push origin main v0.2.0`;
3. 流水线校验 Tag 与 `package.json` 版本一致,运行类型检查与测试,随后去掉 manifest 里只给 Git 安装用的 `build`(npm 安装时 Paseo 已装好依赖)并 `npm publish`。带 `-` 的预发布版本(如 `v0.2.0-beta.1`)以 `next` 标签发布,不影响 `latest`。

依赖锁定:Git 安装按入库的 `package-lock.json` 执行 `npm ci`,依赖树完全锁定。npm 包不附带锁文件——npm 12 起既不打包也不读取依赖包里的 `npm-shrinkwrap.json`——所以运行时依赖在 `package.json` 里写精确版本,升级依赖时同时改 `package.json` 与 `package-lock.json`。

`https://github.com/lekai63/paseo-plugin-superagent` 是 Paseo 官方插件目录审阅用的公开镜像。它是 Git 来源,依赖树由入库的 `package-lock.json` 与 manifest 里的 `build` 命令锁定;发版时把 `main` 与发布 Tag 同时推到两个远端。

发布使用构建内置的 `CNB_TOKEN`(`tag_push` 是可信事件,令牌带制品库读写权限),不需要密钥仓库;推 Tag 的人要在该 npm 制品库里是「开发者」或以上角色。发布前可在本地检查包内容:`npm run pack:check`。

## iOS 闪退排查:避免整包导入 React Native

本插件曾出现启用后 iOS 连接 daemon 即闪退、Web 正常、禁用插件后恢复的故障。将 React Native 整包导入改为按需导入后,已在 Paseo 0.15.0 的 iOS 客户端确认解决。

触发点是 `client/host-font-scale.ts` 中的命名空间导入:

```ts
// 避免:会生成复制 React Native 全部导出的互操作代码。
import * as ReactNative from "react-native";
```

Paseo 0.15.0 的插件编译器为兼容 Hermes,会把 esbuild 的 `get: () => from[key]` 改为 `value: from[key]`。原本延迟读取的导出因此变成立即读取。React Native 通过 getter 延迟初始化模块,整包复制会提前加载插件未使用的 `PushNotificationIOS`、`DevMenu` 等模块;某个模块缺少原生实现时,初始化异常可能被 Metro 上报为 fatal error,导致整个 iOS app 退出。Web 不走相同的原生模块初始化路径,因此仅验证 Web 无法发现此问题。

修复方式是只导入实际使用的模块,避免生成整包复制代码:

```ts
import { NativeModules, Platform, TurboModuleRegistry } from "react-native";

const platform = Platform.OS;
```

该问题发生在插件 bundle 加载阶段,早于组件渲染和业务函数调用,函数内部的 `try/catch` 覆盖不到导入阶段。也应避免通过对象展开或遍历整个 React Native 导出对象再次触发全部 getter。原生存储访问只在 iOS/Android 分支执行,模块不可用时保留平台默认字号;浏览器 API 集中在 `client/web.ts`,每个入口先判断 `Platform.OS === "web"`。

回归测试 `tests/client-loading.test.mjs` 按上述编译规则生成 bundle,为未使用的原生模块设置抛错 getter,验证插件加载和注册不会访问它们,并覆盖 iOS/Android/Web 字号读取及异常回退:

```bash
node --import ./tests/register-typescript.mjs --test tests/client-loading.test.mjs
```

排查同类故障时,先检查实际下发 bundle 的导入代码与原生模块初始化路径,再结合 iOS 真机验证;只通过 TypeScript 检查或 Web 测试不足以确认跨端兼容。
