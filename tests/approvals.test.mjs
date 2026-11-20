import assert from "node:assert/strict";
import test from "node:test";
import { approvalCode, describeRequest, needsHumanApproval, parseApprovalCommand, routerMayRespond } from "../server/approvals.ts";

test("only Worker questions may be answered by the Router; every other request needs a human to approve", () => {
  for (const kind of ["tool", "plan", "mode", "other"]) {
    assert.equal(needsHumanApproval({ kind }), true, kind);
    assert.equal(routerMayRespond({ kind }, { behavior: "allow" }), false, kind);
    assert.equal(routerMayRespond({ kind }, { behavior: "deny" }), true, `${kind} can still be declined`);
  }
  assert.equal(needsHumanApproval({ kind: "question" }), false);
  assert.equal(routerMayRespond({ kind: "question" }, { behavior: "allow" }), true);
});

test("approval codes are short, stable and bound to the ticket and request", () => {
  const code = approvalCode("tkt_a", "req-1");
  assert.match(code, /^[0-9a-f]{6}$/);
  assert.equal(approvalCode("tkt_a", "req-1"), code);
  assert.notEqual(approvalCode("tkt_b", "req-1"), code);
  assert.notEqual(approvalCode("tkt_a", "req-2"), code);
});

test("approval commands are parsed only at the start of a message", () => {
  assert.deepEqual(parseApprovalCommand("/approve 3FA9C1"), { behavior: "allow", code: "3fa9c1", message: null });
  assert.deepEqual(parseApprovalCommand("  @bot /deny 3fa9c1 not on main "), { behavior: "deny", code: "3fa9c1", message: "not on main" });
  assert.deepEqual(parseApprovalCommand("／approve 3fa9c1"), { behavior: "allow", code: "3fa9c1", message: null });
  assert.deepEqual(parseApprovalCommand("/approve"), { behavior: "allow", code: "", message: null });
  assert.deepEqual(parseApprovalCommand("/approve the plan"), { behavior: "allow", code: "", message: "the plan" });
  assert.equal(parseApprovalCommand("please /approve 3fa9c1"), null);
  assert.equal(parseApprovalCommand("/approval 3fa9c1"), null);
  assert.equal(parseApprovalCommand("approve 3fa9c1"), null);
});

test("request descriptions quote the provider's own request fields", () => {
  const text = describeRequest({
    id: "p1", name: "Bash", kind: "tool", title: "Run git push", description: "Pushes main",
    input: { command: "git push origin main" },
  });
  assert.match(text, /^tool · Bash — Run git push/);
  assert.match(text, /Pushes main/);
  assert.match(text, /"command":"git push origin main"/);
  assert.equal(describeRequest({ id: "p2", name: "ExitPlanMode", kind: "plan", input: {} }), "plan · ExitPlanMode");
  assert.ok(describeRequest({ id: "p3", name: "x", kind: "tool", input: { blob: "a".repeat(5000) } }).length < 700);
});
