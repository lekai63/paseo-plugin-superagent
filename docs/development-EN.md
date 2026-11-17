# Development and releases

[← Back to README](../README-EN.md) · [简体中文](development.md)

## Local development

```bash
npm install
npm run typecheck
npm test
paseo plugin install /absolute/path/to/paseo-plugin-superagent   # install from a local directory
paseo plugin reload superagent                                    # reload after changing code
```

If the daemon does not have plugins enabled yet, first turn on `pluginsEnabled` in `$PASEO_HOME/config.json` and then run `paseo reload`.

Layout: `shared/` (domain model + RPC contract + settings, shared by both sides; `shared/locales/` holds the Chinese and English interface text and `shared/i18n.ts` is the translation function; execution provides the direct-delivery decision and session state derivation), `server/` (store/router/workers/engine), `client/` (the chat page chat-screen, the top tabs chat-tab-bar and its local copy chat-tabs-store, the message stream chat-messages, the input box chat-composer, the right sidebar chat-sidebar, the settings page settings-screen (five tabs — Basics/Models/Rules/Execution/IM — sharing one module-level draft), and small primitives such as buttons/badges/notices in ui.tsx; `shared/chat.ts` arranges a thread's triggers and decisions into a conversation). For engine details see the header comment of `server/engine.ts`.

`npm test` uses the built-in test runner of Node.js 24+ and the existing TypeScript dependencies to verify Worker continuation, delivery-failure fallback, cancel races, restart recovery and Feishu connection cleanup; it does not connect to real providers or IM services.

## Interface text and translation

- English is the source language: all interface text is written in `shared/locales/en/<namespace>.ts`, and Simplified Chinese is in the same-named files under `shared/locales/zh-CN/`, annotated with `Translation<typeof en>`, so a missing or extra key is reported by `npm run typecheck`.
- Keys use dotted paths (`chat.composer.send`), interpolation is written `{{name}}`, and plurals use `_one`/`_other` with a numeric `count` (Chinese writes only `_other`). The `Translate` type in `shared/i18n.ts` checks key names and required interpolations against the English source.
- In components use `useT()` from `client/i18n.ts`; pure shared functions take a `t` parameter; the daemon uses `t` from `server/i18n.ts` (the language comes from the client's `superagent.set_locale` report). Titles rendered by the host, the Command Center and slash commands use `messages.message(key)`.
- Do not call `t` at module top level or store translations in constants; logs, user/agent content and prompts sent to the model are not translated.
- `tests/i18n.test.mjs` checks that the Chinese and English keys and interpolations match and that the host resolves titles by the app language, and it scans the source: Chinese string literals outside comments must be moved into `shared/locales` (those deliberately kept, such as search keywords, are listed in the allowlist).

## Releases (CNB)

`.cnb.yml` runs the type check and tests on pushes to `main` and on PRs targeting `main`; pushing a `v*` tag publishes the npm package `@0_0/paseo-plugin-superagent` to the CNB npm registry `https://npm.cnb.cool/0_0/paseo/superagent-plugin/-/packages/` and creates a Release of the same name.

1. Update the version (without tagging automatically): `npm version 0.2.0 --no-git-tag-version`, then commit `package.json` and `package-lock.json`;
2. Tag and push: `git tag v0.2.0 && git push origin main v0.2.0`;
3. The pipeline checks that the tag matches the `package.json` version, runs the type check and tests, then removes the `build` in the manifest that exists only for Git installs (Paseo has already installed dependencies on npm installs) and runs `npm publish`. A prerelease version containing `-` (such as `v0.2.0-beta.1`) is published under the `next` tag and does not affect `latest`.

Dependency locking: a Git install runs `npm ci` against the committed `package-lock.json`, so the dependency tree is fully locked. The npm package ships no lockfile (since npm 12, `npm-shrinkwrap.json` inside a dependency package is neither packed nor read), so runtime dependencies are pinned to exact versions in `package.json`; when upgrading a dependency, change both `package.json` and `package-lock.json`. If the plugin is later submitted to the official Paseo plugin directory (which requires the full dependency tree to be locked), it will need to switch to `bundleDependencies` or a Git source.

Publishing uses the build's built-in `CNB_TOKEN` (`tag_push` is a trusted event, and the token has registry read/write permission), so no secrets repository is needed; whoever pushes the tag must have the "Developer" role or above in that npm registry. Before publishing you can check the package contents locally with `npm run pack:check`.

## iOS crash investigation: avoid importing all of React Native

The plugin once had a fault where, after it was enabled, the iOS app crashed as soon as it connected to the daemon, while Web worked and disabling the plugin restored it. Changing the whole-package React Native import to on-demand imports has been confirmed to fix it on the Paseo 0.15.0 iOS client.

The trigger was a namespace import in `client/host-font-scale.ts`:

```ts
// Avoid: generates interop code that copies every React Native export.
import * as ReactNative from "react-native";
```

For Hermes compatibility, the plugin compiler in Paseo 0.15.0 rewrites esbuild's `get: () => from[key]` into `value: from[key]`, so exports that were originally read lazily are now read eagerly. React Native initializes modules lazily through getters, so copying the whole package loads modules the plugin does not use, such as `PushNotificationIOS` and `DevMenu`, ahead of time; when a module lacks a native implementation, the initialization exception may be reported by Metro as a fatal error and the whole iOS app exits. Web does not take the same native-module initialization path, so verifying on Web alone cannot find the problem.

The fix is to import only the modules actually used, avoiding the whole-package copy code:

```ts
import { NativeModules, Platform, TurboModuleRegistry } from "react-native";

const platform = Platform.OS;
```

The problem occurs during plugin bundle loading, before component rendering and any business function call, so a `try/catch` inside a function cannot cover the import stage. Also avoid triggering all the getters again by spreading or iterating over the whole React Native exports object. Native storage access runs only in the iOS/Android branches, and when a module is unavailable the platform default font size is kept; browser APIs are centralized in `client/web.ts`, and every entry first checks `Platform.OS === "web"`.

The regression test `tests/client-loading.test.mjs` generates a bundle with the compile rules above, sets throwing getters on the unused native modules, verifies that plugin loading and registration do not touch them, and covers font-size reading and exception fallback on iOS/Android/Web:

```bash
node --import ./tests/register-typescript.mjs --test tests/client-loading.test.mjs
```

When investigating a similar fault, first inspect the import code of the bundle actually delivered and the native-module initialization path, then verify on a real iOS device; TypeScript checks or Web tests alone are not enough to confirm cross-platform compatibility.
