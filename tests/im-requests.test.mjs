import assert from "node:assert/strict";
import test from "node:test";
import { parseWorkerQuestions } from "../shared/worker-questions.ts";
import { OTHER_CHOICE_VALUE } from "../shared/model.ts";
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

test("Feishu renders single-choice allowOther questions as a dropdown with an Other entry plus free-text input", () => {
  const flavor = { question: "Flavor?", header: "flavor", allowOther: true,
    options: [{ label: "Sweet" }, { label: "Salty" }] };
  const { questions } = parseWorkerQuestions({ questions: [flavor] });
  const card = feishuRequestCard({ ...delivery, questions });
  const elements = card.elements[1].elements;
  const select = elements[0];
  const otherInput = elements[1];
  assert.equal(select.tag, "select_static");
  assert.equal(select.name, "q1");
  assert.deepEqual(select.options.map(({ value }) => value), ["1", "2", OTHER_CHOICE_VALUE]);
  assert.equal(otherInput.tag, "input");
  assert.equal(otherInput.name, "q1_other");
  // Picking a preset option stays a plain selection; the Other pair keeps `other` out of the parsed answer.
  const read = (form_value) => readFeishuRequestAction({ event: {
    context: { open_chat_id: "chat", open_message_id: "message" }, operator: { open_id: "user" },
    action: { value: elements.at(-1).value, form_value },
  } });
  assert.deepEqual(parseImQuestionAnswers(questions, read({ q1: "2", q1_other: "" }).submission),
    [{ header: "flavor", selections: ["Salty"], text: "" }]);
  assert.deepEqual(parseImQuestionAnswers(questions, read({ q1: OTHER_CHOICE_VALUE, q1_other: "Sour" }).submission),
    [{ header: "flavor", selections: [], text: "Sour" }]);
  // Equivalent plain-text replies parse to the same shapes.
  assert.deepEqual(parseImQuestionAnswers(questions, { text: "2" }),
    [{ header: "flavor", selections: ["Salty"], text: "" }]);
  assert.deepEqual(parseImQuestionAnswers(questions, { text: "+Sour" }),
    [{ header: "flavor", selections: [], text: "Sour" }]);
  // "Other" without free text, or a preset option plus extra text, is rejected just like text replies.
  assert.equal(parseImQuestionAnswers(questions, read({ q1: OTHER_CHOICE_VALUE, q1_other: "" }).submission), null);
  assert.equal(parseImQuestionAnswers(questions, read({ q1: "1", q1_other: "extra" }).submission), null);
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
