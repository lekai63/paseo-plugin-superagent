import type { TemplateCard } from "@wecom/aibot-node-sdk";
import { ImCardSubmissionSchema, OTHER_CHOICE_VALUE } from "../shared/model";
import type { ImRequestCard } from "./im-requests";
import { t } from "./i18n";

const plain = (content: string) => ({ tag: "plain_text", content });
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function feishuRequestCard(card: ImRequestCard) {
  const button = (behavior: "allow" | "deny" | "answer", label: string) => ({
    tag: "button", text: plain(label), type: behavior === "deny" ? "danger" : "primary",
    value: { superagent: card.deliveryId, behavior },
  });
  const fields = card.questions?.map((question, index) => {
    const name = `q${index + 1}`;
    const required = !question.allowEmpty && !question.allowOther;
    if (question.options.length && !question.multiSelect) {
      // Single-choice questions render as a dropdown. With allowOther, the list gains an
      // "Other" entry and a companion free-text input (qN_other): parseImQuestionAnswers maps
      // that pair back to the "+ custom text" answer syntax, so both card and text replies share one parser.
      const choices = question.options.map(({ label }, i) => ({ text: plain(label), value: String(i + 1) }));
      if (!question.allowOther) {
        return [{ tag: "select_static" as const, name, required, placeholder: plain(question.question), options: choices }];
      }
      return [
        { tag: "select_static" as const, name, required: !question.allowEmpty, placeholder: plain(question.question),
          options: [...choices, { text: plain(t("chat.requests.otherChoice")), value: OTHER_CHOICE_VALUE }] },
        { tag: "input" as const, name: `${name}_other`, required: false,
          placeholder: plain(question.placeholder ?? t("chat.requests.otherAnswer")) },
      ];
    }
    return [{ tag: "input" as const, name, required, label: plain(question.question),
      placeholder: plain(question.options.length ? t("server.engine.imOptionPlaceholder") : question.placeholder ?? t("chat.requests.writeAnswer")) }];
  }).flatMap((field) => field);
  const actions = [card.allow ? button("allow", t("chat.requests.allow")) : null,
    card.deny ? button("deny", t("chat.requests.deny")) : null].filter(Boolean);
  if (!fields && !actions.length) return undefined;
  return {
    header: { title: plain(card.title), template: "blue" },
    elements: [{ tag: "div", text: plain(card.text) }, fields ? {
      tag: "form", name: "worker_question", elements: [...fields,
        { ...button("answer", t("chat.requests.submitAnswer")), name: "submit", action_type: "form_submit" }],
    } : { tag: "action", actions }],
  };
}

export function readFeishuRequestAction(data: unknown) {
  const event = record(record(data).event ?? data);
  const action = record(event.action);
  const value = record(action.value);
  const context = record(event.context);
  const form = record(action.form_value);
  const fields = Object.fromEntries(Object.entries(form).filter(([key]) => /^q[1-9]\d*(?:_other)?$/.test(key)));
  const parsed = ImCardSubmissionSchema.safeParse({ deliveryId: value.superagent, behavior: value.behavior,
    ...(value.behavior === "answer" ? { fields } : {}) });
  const senderId = record(event.operator).open_id;
  const chatId = context.open_chat_id ?? event.open_chat_id;
  const messageId = context.open_message_id ?? event.open_message_id;
  if (!parsed.success || typeof senderId !== "string" || !senderId || typeof chatId !== "string" || !chatId) return null;
  return { senderId, chatId, messageId: typeof messageId === "string" ? messageId : null, submission: parsed.data };
}

export function wecomRequestCard(card: ImRequestCard): TemplateCard | undefined {
  const base = { task_id: card.deliveryId, main_title: { title: card.title }, quote_area: { type: 0 as const, quote_text: card.text } };
  const questions = card.questions;
  if (!questions) {
    const buttons = [card.allow ? { key: "allow", text: t("chat.requests.allow") } : null,
      card.deny ? { key: "deny", text: t("chat.requests.deny") } : null].filter((button) => button !== null);
    return buttons.length ? { ...base, card_type: "button_interaction", button_list: buttons } : undefined;
  }
  if (questions.some((question) => !question.options.length || question.allowOther || question.allowEmpty)) return undefined;
  const options = (index: number) => questions[index].options.map(({ label }, i) => ({ id: String(i + 1), text: label }));
  const submit_button = { key: "answer", text: t("chat.requests.submitAnswer") };
  if (questions.length === 1 && questions[0].options.length <= 20) {
    return { ...base, card_type: "vote_interaction", checkbox: { question_key: "q1", mode: questions[0].multiSelect ? 1 : 0,
      option_list: options(0) }, submit_button };
  }
  if (questions.length > 3 || questions.some((question) => question.multiSelect || question.options.length > 10)) return undefined;
  return { ...base, card_type: "multiple_interaction", select_list: questions.map((q, i) => ({
    question_key: `q${i + 1}`, title: q.question, option_list: options(i),
  })), submit_button };
}

export function readWecomRequestAction(data: unknown) {
  const eventFrame = record(data);
  const event = record(eventFrame.event);
  const card = record(event.template_card_event ?? event);
  const items = record(card.selected_items).selected_item;
  const selections = Object.fromEntries(Array.isArray(items) ? items.map((value) => {
    const item = record(value);
    return [item.question_key, record(item.option_ids).option_id];
  }) : []);
  const parsed = ImCardSubmissionSchema.safeParse({ deliveryId: card.task_id, behavior: card.event_key,
    ...(card.event_key === "answer" ? { selections } : {}) });
  const senderId = record(eventFrame.from).userid;
  const group = eventFrame.chattype === "group";
  const chatId = group ? eventFrame.chatid : senderId;
  if (!parsed.success || typeof senderId !== "string" || !senderId || typeof chatId !== "string" || !chatId) return null;
  return { senderId, chatId, group, submission: parsed.data };
}
