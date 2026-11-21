import { z } from "zod";

const QuestionsSchema = z.object({
  questions: z.array(z.object({
    question: z.string().min(1),
    header: z.string().optional(),
    options: z.array(z.object({ label: z.string().min(1), description: z.string().optional() })).default([]),
    multiSelect: z.boolean().default(false),
    allowOther: z.boolean().default(false),
    isOther: z.boolean().default(false),
    allowEmpty: z.boolean().default(false),
    placeholder: z.string().optional(),
  })).min(1),
}).passthrough();

export const MAX_QUESTION_ANSWER_LENGTH = 16000;
export const WorkerQuestionAnswerSchema = z.object({
  header: z.string(),
  selections: z.array(z.string()),
  text: z.string().max(MAX_QUESTION_ANSWER_LENGTH),
}).strict();
export type WorkerQuestionAnswer = z.infer<typeof WorkerQuestionAnswerSchema>;

export function parseWorkerQuestions(input: unknown) {
  const parsed = QuestionsSchema.safeParse(input);
  if (!parsed.success) return null;
  const questions = parsed.data.questions.map((item) => ({
    ...item,
    header: item.header || item.question,
    allowOther: item.allowOther || item.isOther,
  }));
  if (new Set(questions.map(({ header }) => header)).size !== questions.length) return null;
  return { questions, input: input as Record<string, unknown> };
}
export type WorkerQuestion = NonNullable<ReturnType<typeof parseWorkerQuestions>>["questions"][number];

export function workerQuestionHasTextInput(question: WorkerQuestion): boolean {
  return question.options.length === 0 || question.allowOther;
}

/** Convert checked options and custom text into Paseo's header-keyed response format. */
export function buildWorkerQuestionAnswers(
  questions: readonly WorkerQuestion[],
  answers: readonly WorkerQuestionAnswer[],
): Record<string, string> | null {
  if (questions.length !== answers.length) return null;
  const entries: [string, string][] = [];
  for (const [index, question] of questions.entries()) {
    const { header, selections, text } = answers[index];
    const custom = text.trim();
    const selected = new Set(selections);
    if (header !== question.header || (!question.multiSelect && selected.size + Number(Boolean(custom)) > 1)
      || (custom && !workerQuestionHasTextInput(question))) return null;
    const available = new Set(question.options.map(({ label }) => label));
    if ([...selected].some((label) => !available.has(label))) return null;
    const response = [...selected, ...(custom ? [custom] : [])].join(", ");
    if (!response && !(question.allowEmpty && workerQuestionHasTextInput(question))) return null;
    // The native form omits an optional unselected choice, but sends an empty text response explicitly.
    if (response || question.options.length === 0) entries.push([header, response]);
  }
  return Object.fromEntries(entries);
}
