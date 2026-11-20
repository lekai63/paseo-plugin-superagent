import assert from "node:assert/strict";
import test from "node:test";
import { parseWorkerQuestions } from "../shared/worker-questions.ts";
import { feishuRequestCard, readFeishuRequestAction, readWecomRequestAction, wecomRequestCard } from "../server/im-cards.ts";
import { parseImQuestionAnswers } from "../server/im-requests.ts";

const delivery = { deliveryId: "im-dec_test", title: "Task", text: "Question" };
const color = { question: "Colors?", header: "colors", options: [{ label: "Red" }, { label: "Blue" }], multiSelect: true };
const notes = { question: "Notes?", header: "notes", options: [] };

test("Feishu form fields and text replies encode multi-select and free text the same way", () => {
  const { questions } = parseWorkerQuestions({ questions: [color, notes] });
  const card = feishuRequestCard({ ...delivery, questions });
  const button = card.elements[1].elements.at(-1);
  assert.equal(button.action_type, "form_submit");
  const event = readFeishuRequestAction({ event: {
    context: { open_chat_id: "chat", open_message_id: "message" }, operator: { open_id: "user" },
    action: { value: button.value, form_value: { q1: "1,2", q2: "Keep + sign", submit: "" } },
  } });
  const answer = parseImQuestionAnswers(questions, event.submission);
  assert.deepEqual(answer, parseImQuestionAnswers(questions, { text: "1: 1,2\n2: Keep + sign" }));
  assert.deepEqual(answer, [{ header: "colors", selections: ["Red", "Blue"], text: "" }, { header: "notes", selections: [], text: "Keep + sign" }]);
  assert.equal(parseImQuestionAnswers(questions, { text: "1: 3\n2: notes" }), null);
  assert.equal(parseImQuestionAnswers(questions, { text: "1: 1\n1: 2\n2: notes" }), null);
});

test("WeCom uses a vote card for choices and text for forms requiring free text", () => {
  const { questions } = parseWorkerQuestions({ questions: [color] });
  const card = wecomRequestCard({ ...delivery, questions });
  assert.equal(card.card_type, "vote_interaction");
  assert.equal(card.checkbox.mode, 1);
  const event = readWecomRequestAction({ chattype: "group", chatid: "chat", from: { userid: "user" }, event: {
    eventtype: "template_card_event", template_card_event: { task_id: card.task_id, event_key: card.submit_button.key,
      selected_items: { selected_item: [{ question_key: "q1", option_ids: { option_id: ["2"] } }] } },
  } });
  assert.deepEqual(parseImQuestionAnswers(questions, event.submission), [{ header: "colors", selections: ["Blue"], text: "" }]);
  assert.equal(wecomRequestCard({ ...delivery, questions: parseWorkerQuestions({ questions: [notes] }).questions }), undefined);
  assert.equal(wecomRequestCard({ ...delivery, allow: true, deny: true }).card_type, "button_interaction");
});
