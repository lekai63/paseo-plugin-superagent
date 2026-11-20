import type { ImCardSubmission } from "../shared/model";
import { buildWorkerQuestionAnswers, type WorkerQuestion, type WorkerQuestionAnswer } from "../shared/worker-questions";
import { t } from "./i18n";

export interface ImRequestCard {
  deliveryId: string;
  title: string;
  text: string;
  questions?: WorkerQuestion[];
  allow?: boolean;
  deny?: boolean;
}

const ANSWER = /^(?:@\S+\s+)*[/／]answer(?=\s|$)(?:\s+([0-9a-f]{6})(?=\s|$))?\s*([\s\S]*)$/i;

export function parseImAnswerCommand(text: string): { code: string; text: string } | null {
  const match = ANSWER.exec(text.trim());
  return match ? { code: match[1]?.toLowerCase() ?? "", text: match[2] } : null;
}

export function imQuestionNotice(title: string, code: string, questions: WorkerQuestion[]): string {
  const list = questions.map((question, index) => [
    `${index + 1}. ${question.question}${question.multiSelect ? ` (${t("chat.requests.multiSelect")})` : ""}`,
    ...question.options.map(({ label, description }, i) => `   ${i + 1}) ${label}${description ? ` — ${description}` : ""}`),
  ].join("\n")).join("\n");
  return `${t("server.engine.imQuestion", { title, code })}\n${list}\n\n${t("server.engine.imAnswerInstructions", { code })}`;
}

/** Text and card fields both become validated Paseo answers after re-reading the Worker. */
export function parseImQuestionAnswers(
  questions: WorkerQuestion[], submission: Pick<ImCardSubmission, "text" | "selections" | "fields">,
): WorkerQuestionAnswer[] | null {
  const values = new Map<number, string>();
  if (submission.selections || submission.fields) {
    for (const [key, value] of Object.entries(submission.selections ?? submission.fields ?? {})) {
      if (!/^q[1-9]\d*$/.test(key)) return null;
      values.set(Number(key.slice(1)), typeof value === "string" ? value : value.join(","));
    }
  } else if (questions.length === 1) {
    const text = submission.text ?? "";
    values.set(1, questions[0].options.length ? text.replace(/^1[:：]\s*/, "") : text);
  } else {
    for (const line of (submission.text ?? "").split(/\r?\n/)) {
      if (!line.trim()) continue;
      const match = /^\s*([1-9]\d*)\s*[:：]\s*(.*)$/.exec(line);
      if (!match || values.has(Number(match[1]))) return null;
      values.set(Number(match[1]), match[2]);
    }
  }
  if ([...values.keys()].some((index) => index < 1 || index > questions.length)) return null;
  const answers: WorkerQuestionAnswer[] = [];
  for (const [index, question] of questions.entries()) {
    const raw = values.get(index + 1)?.trim() ?? "";
    const answer = { header: question.header, selections: [] as string[], text: "" };
    if (!question.options.length) answer.text = raw;
    else {
      const plus = raw.indexOf("+");
      const choice = (plus < 0 ? raw : raw.slice(0, plus)).trim();
      answer.text = plus < 0 ? "" : raw.slice(plus + 1).trim();
      if (choice) {
        for (const value of choice.split(/[,，、]/).map((item) => item.trim())) {
          const option = /^\d+$/.test(value) ? question.options[Number(value) - 1] : question.options.find(({ label }) => label === value);
          if (!option) return null;
          answer.selections.push(option.label);
        }
      }
    }
    if (answer.text.length > 16000) return null;
    answers.push(answer);
  }
  return buildWorkerQuestionAnswers(questions, answers) ? answers : null;
}
