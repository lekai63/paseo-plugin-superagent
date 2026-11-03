import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { RpcInput } from "@getpaseo/plugin";
import type { SuperagentEngine } from "./engine";
import {
  superagentCancelTicketRpc,
  superagentCloseThreadRpc,
  superagentDispatchRpc,
  superagentForceEvalRpc,
  superagentRetryTicketRpc,
  superagentRetryImDeliveryRpc,
  superagentStateRpc,
  superagentUnsubscribeRpc,
} from "../shared/rpc";

/** RPC handler 工厂:每个 handler 已经被 index.server.ts 的 withPrime 包了一层。 */

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createRetryImDeliveryHandler(engine: SuperagentEngine) {
  return async (input: RpcInput<typeof superagentRetryImDeliveryRpc>, _context: PluginHandlerContext) => {
    try {
      await engine.retryImDelivery(input.deliveryId);
      return { ok: true, error: null };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  };
}

export function createDispatchHandler(engine: SuperagentEngine) {
  return async (
    input: RpcInput<typeof superagentDispatchRpc>,
    _context: PluginHandlerContext,
  ) => engine.dispatch(input);
}

export function createStateHandler(engine: SuperagentEngine) {
  return async (
    input: RpcInput<typeof superagentStateRpc>,
    _context: PluginHandlerContext,
  ) => engine.snapshot(input);
}

export function createForceEvalHandler(engine: SuperagentEngine) {
  return async (
    input: RpcInput<typeof superagentForceEvalRpc>,
    _context: PluginHandlerContext,
  ) => {
    await engine.forceEval(input.threadId);
    return { ok: true, error: null };
  };
}

export function createCancelTicketHandler(engine: SuperagentEngine) {
  return async (
    input: RpcInput<typeof superagentCancelTicketRpc>,
    _context: PluginHandlerContext,
  ) => {
    try {
      await engine.cancelTicket(input.ticketId);
      return { ok: true, error: null };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  };
}

export function createRetryTicketHandler(engine: SuperagentEngine) {
  return async (
    input: RpcInput<typeof superagentRetryTicketRpc>,
    _context: PluginHandlerContext,
  ) => {
    try {
      await engine.retryTicket(input.ticketId);
      return { ok: true, error: null };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  };
}

export function createCloseThreadHandler(engine: SuperagentEngine) {
  return async (
    input: RpcInput<typeof superagentCloseThreadRpc>,
    _context: PluginHandlerContext,
  ) => {
    try {
      await engine.closeThread(input.threadId);
      return { ok: true, error: null };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  };
}

export function createUnsubscribeHandler(engine: SuperagentEngine) {
  return async (
    input: RpcInput<typeof superagentUnsubscribeRpc>,
    _context: PluginHandlerContext,
  ) => {
    try {
      await engine.unsubscribe(input.threadId, input.ticketId);
      return { ok: true, error: null };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  };
}
