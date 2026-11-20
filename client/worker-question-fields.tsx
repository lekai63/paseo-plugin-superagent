import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon, TextInput } from "@getpaseo/plugin/client/ui";
import {
  buildWorkerQuestionAnswers, MAX_QUESTION_ANSWER_LENGTH, workerQuestionHasTextInput,
  type WorkerQuestion, type WorkerQuestionAnswer,
} from "../shared/worker-questions";
import { useT } from "./i18n";
import { Button, HAIRLINE, radius, space, TYPE, type Theme } from "./ui";

type Draft = Pick<WorkerQuestionAnswer, "selections" | "text">;
const EMPTY_DRAFT: Draft = { selections: [], text: "" };

export function WorkerQuestionFields({ questions, theme, pending, onSubmit }: {
  questions: WorkerQuestion[];
  theme: Theme;
  pending: boolean;
  onSubmit(answers: WorkerQuestionAnswer[]): void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<{ active: number; fields: Record<number, Draft> }>({ active: 0, fields: {} });
  const index = Math.min(draft.active, questions.length - 1);
  const question = questions[index];
  const answers = questions.map(({ header }, index) => ({ header, ...(draft.fields[index] ?? EMPTY_DRAFT) }));
  const { selections, text } = answers[index];
  const hasNext = index < questions.length - 1;
  const canContinue = buildWorkerQuestionAnswers(hasNext ? [question] : questions, hasNext ? [answers[index]] : answers) !== null;
  const { colors } = theme;
  const body = { color: colors.foreground, fontSize: TYPE.body.size, lineHeight: TYPE.body.lineHeight };
  const caption = { color: colors.foregroundMuted, fontSize: TYPE.caption.size, lineHeight: TYPE.caption.lineHeight };
  const setActive = (active: number) => setDraft((previous) => ({ ...previous, active }));
  const updateDraft = (update: (field: Draft) => Draft) => setDraft((previous) => ({
    ...previous, fields: { ...previous.fields, [index]: update(previous.fields[index] ?? EMPTY_DRAFT) },
  }));

  return (
    <View style={{ gap: space.md }}>
      <View key={question.header} style={{ gap: space.xs }}>
        {questions.length > 1 ? <Text style={caption}>{t("chat.requests.questionProgress", { current: index + 1, count: questions.length })}</Text> : null}
        <Text selectable style={{ ...body, fontWeight: "500" }}>{question.question}</Text>
        {question.multiSelect && question.options.length > 1 ? <Text style={caption}>{t("chat.requests.multiSelect")}</Text> : null}
        {question.options.map(({ label, description }, optionIndex) => {
          const checked = selections.includes(label);
          return (
            <Pressable key={optionIndex} accessibilityRole={question.multiSelect ? "checkbox" : "radio"}
              aria-checked={checked} accessibilityState={{ checked, disabled: pending }} disabled={pending}
              onPress={() => updateDraft((draft) => ({
                selections: question.multiSelect
                  ? (draft.selections.includes(label) ? draft.selections.filter((selection) => selection !== label) : [...draft.selections, label])
                  : [label],
                text: question.multiSelect ? draft.text : "",
              }))}
              style={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: space.sm,
                paddingHorizontal: space.sm, paddingVertical: space.xs, borderRadius: radius.chip,
                borderWidth: HAIRLINE, borderColor: checked ? colors.accent : colors.border,
                backgroundColor: checked ? colors.surface2 : colors.surface0 }}>
              <Icon name={checked ? "Check" : question.multiSelect ? "Square" : "Circle"} size={16}
                color={checked ? colors.accent : colors.foregroundMuted} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={body}>{label}</Text>
                {description ? <Text style={caption}>{description}</Text> : null}
              </View>
            </Pressable>
          );
        })}
        {workerQuestionHasTextInput(question) ? (
          <TextInput accessibilityLabel={question.question} value={text} multiline editable={!pending}
            maxLength={MAX_QUESTION_ANSWER_LENGTH}
            placeholder={question.placeholder ?? t(question.options.length ? "chat.requests.otherAnswer" : "chat.requests.writeAnswer")}
            placeholderTextColor={colors.foregroundMuted}
            style={{ ...body, fontSize: Math.max(16, body.fontSize), minHeight: 44, padding: space.sm, borderRadius: radius.chip,
              borderWidth: HAIRLINE, borderColor: colors.border, backgroundColor: colors.surface0 }}
            onChangeText={(value) => updateDraft((draft) => ({
              selections: !question.multiSelect && value.trim() ? [] : draft.selections, text: value,
            }))} />
        ) : null}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
        {index > 0 ? (
          <Button theme={theme} variant="outline" label={t("chat.requests.previousQuestion")} disabled={pending}
            onPress={() => setActive(index - 1)} />
        ) : null}
        <Button theme={theme} variant="primary" label={t(hasNext ? "chat.requests.nextQuestion" : "chat.requests.submitAnswer")}
          disabled={pending || !canContinue} onPress={() => hasNext ? setActive(index + 1) : onSubmit(answers)} />
      </View>
    </View>
  );
}
