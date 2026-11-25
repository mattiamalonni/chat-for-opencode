import type { ToolPart } from "./chatReducer";
import { toolObject } from "./subagents";
import { toolOutputLabel } from "./toolOutput";

/**
 * A prompt of the server's `question` tool. The tool keeps its questions in the tool input, while
 * the answers arrive later in the tool result. Both are part of the session history, so a question
 * stays in the conversation after a reload without any extension-side persistence.
 */
export interface QuestionPrompt {
  question: string;
  header?: string;
}

export interface QuestionToolView {
  questions: QuestionPrompt[];
  /** One answer per question, in the tool's order. Undefined until the tool answers. */
  answers: string[] | undefined;
  /** Tool result as text, shown only when its answer format is not recognised. */
  outputText: string;
}

/** A `question` tool call is recognisable by its non-empty `questions[]` input. */
export function isQuestionTool(part: ToolPart): boolean {
  if (part.name !== "question") return false;
  const questions = toolObject(part).questions;
  return Array.isArray(questions) && questions.length > 0;
}

function questionsFrom(input: Record<string, unknown>): QuestionPrompt[] {
  const out: QuestionPrompt[] = [];
  for (const raw of Array.isArray(input.questions) ? input.questions : []) {
    if (!raw || typeof raw !== "object") continue;
    const q = raw as Record<string, unknown>;
    if (typeof q.question !== "string" || !q.question) continue;
    const header = typeof q.header === "string" && q.header ? q.header : undefined;
    out.push(header ? { question: q.question, header } : { question: q.question });
  }
  return out;
}

/** The result carries `metadata.answers` as `string[][]`, one entry per question. */
function answersFromMetadata(metadata: Record<string, unknown> | undefined): string[] | undefined {
  const raw = metadata?.answers;
  if (!Array.isArray(raw)) return undefined;
  return raw.map((answer) => {
    if (Array.isArray(answer)) return answer.filter((v): v is string => typeof v === "string").join(", ");
    return typeof answer === "string" ? answer : "";
  });
}

/**
 * Fallback for histories without metadata (or another client's wording): the tool formats its
 * result as `"question"="answer", "question 2"="answer 2"`. Answers are positional, so parsing
 * the quoted pairs is enough to pair them with the questions from the input.
 */
function answersFromOutput(text: string): string[] | undefined {
  const pairs = [...text.matchAll(/"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"/g)];
  if (pairs.length === 0) return undefined;
  return pairs.map((pair) => pair[2].replace(/\\(["\\])/g, "$1").replace(/\\n/g, "\n"));
}

export function questionToolView(part: ToolPart): QuestionToolView {
  const outputText = part.output.map(toolOutputLabel).filter(Boolean).join("\n");
  return {
    questions: questionsFrom(toolObject(part)),
    answers: answersFromMetadata(part.metadata) ?? answersFromOutput(outputText),
    outputText,
  };
}

/** Text a question card contributes to the conversation filter. */
export function questionSearchText(part: ToolPart): string {
  const { questions, answers, outputText } = questionToolView(part);
  return [...questions.flatMap((q) => [q.header ?? "", q.question]), ...(answers ?? []), outputText].join(" ");
}
