import assert from "node:assert/strict";
import test from "node:test";
import { resolveHostSendShortcut, parseHostSendShortcut } from "../shared/host-send-shortcut.ts";

test("reads sendShortcut from an app settings blob and validates the value", () => {
  assert.equal(parseHostSendShortcut(JSON.stringify({ sendShortcut: "mod-enter" })), "mod-enter");
  assert.equal(parseHostSendShortcut(JSON.stringify({ sendShortcut: "enter" })), "enter");
  assert.equal(parseHostSendShortcut(JSON.stringify({ uiBaseFontSize: 16 })), null);
  assert.equal(parseHostSendShortcut(JSON.stringify({ sendShortcut: "yes" })), null);
  assert.equal(parseHostSendShortcut("not json"), null);
  assert.equal(parseHostSendShortcut(null), null);
});

test("resolution prefers the current key, then the legacy key, then the host default", () => {
  assert.equal(resolveHostSendShortcut(JSON.stringify({ sendShortcut: "mod-enter" }), JSON.stringify({ sendShortcut: "enter" })), "mod-enter");
  assert.equal(resolveHostSendShortcut(null, JSON.stringify({ sendShortcut: "mod-enter" })), "mod-enter");
  assert.equal(resolveHostSendShortcut(JSON.stringify({ theme: "dark" }), null), "enter");
  assert.equal(resolveHostSendShortcut(null, null), "enter");
});
