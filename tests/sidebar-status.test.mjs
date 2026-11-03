import assert from "node:assert/strict";
import test from "node:test";
import { sidebarStatus } from "../shared/sidebar-status.ts";

const snapshot = () => ({ engine: { evalInFlight: false }, threads: [], tickets: [], recentResults: [], imDeliveries: [] });

test("sidebar reflects Worker execution even when the Router is idle and an earlier result exists", () => {
  const state = snapshot();
  state.recentResults = [{ createdAt: "2026-01-01" }];
  state.tickets = [{ status: "running" }];
  assert.equal(sidebarStatus(state, [{ id: "router", status: "idle" }]), "running");
  state.tickets[0].status = "waiting";
  assert.equal(sidebarStatus(state, [{ id: "worker", status: "running" }]), "running");
  assert.equal(sidebarStatus(state, [{ id: "worker", status: "idle" }]), "done");
});

test("sidebar shows initialization, pending work and Router evaluation as running", () => {
  assert.equal(sidebarStatus({ ...snapshot(), threads: [{ pendingTriggers: 1 }] }, []), "running");
  assert.equal(sidebarStatus({ ...snapshot(), engine: { evalInFlight: true } }, []), "running");
  assert.equal(sidebarStatus(snapshot(), [{ status: "initializing" }]), "running");
  assert.equal(sidebarStatus({ ...snapshot(), tickets: [{ status: "pending" }] }, []), "running");
});

test("permission requests and errors stay visible instead of appearing completed", () => {
  const state = { ...snapshot(), recentResults: [{ createdAt: "2026-01-01" }] };
  assert.equal(sidebarStatus(state, [{ status: "running", pendingPermissions: [{}] }]), "needs_input");
  assert.equal(sidebarStatus(state, [{ status: "error" }]), "failed");
  assert.equal(sidebarStatus({ ...state, imDeliveries: [{ status: "failed" }] }, []), "failed");
  assert.equal(sidebarStatus(state, [{ status: "error", archivedAt: "2026-01-01" }]), "done");
});

test("sidebar distinguishes no work, unavailable state and completed history after Worker cleanup", () => {
  assert.equal(sidebarStatus(snapshot(), []), "idle");
  assert.equal(sidebarStatus(undefined, []), "unknown");
  const state = { ...snapshot(), recentResults: [{ createdAt: "2026-01-01" }] };
  assert.equal(sidebarStatus(state, []), "done");
  assert.equal(sidebarStatus(state, [], true), "unknown");
});
