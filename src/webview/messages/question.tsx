import type { ToolPart } from "../../shared/chatReducer";
import { questionToolView } from "../../shared/questionTool";

import { useT } from "../i18n";
import { IconCheck, IconInfo } from "../icons";

import { Highlight } from "./text";

/**
 * A question tool call kept in the conversation like the assistant's prose.
 *
 * Only the answered exchange is shown here: while the form is pending, the actionable card in the
 * attention overlay is the one place to reply. Questions come from the tool input and answers from
 * its result, both stored by the server in session history, so this survives reloads and workspaces.
 */
export function QuestionTurnCard({
  part,
  searchQuery = "",
  filteredOut = false,
}: {
  part: ToolPart;
  searchQuery?: string;
  filteredOut?: boolean;
}) {
  const t = useT();
  const { questions, answers, outputText } = questionToolView(part);
  const cancelled = part.status === "error" && !answers;
  const answerFallback = cancelled ? t("cancelled") : "—";
  return (
    <section class={`card question-turn${filteredOut ? " filtered-out" : ""}`} aria-label={t("questionTitle")} data-question-turn="">
      <div class="card-title">
        <IconInfo /> {t("questionTitle")}
        {questions.length > 1 && <span class="question-turn-count">{t("questionCount", questions.length)}</span>}
      </div>
      <ol class="question-turn-list">
        {questions.map((q, index) => (
          <li class="question-turn-item" key={index}>
            {q.header && (
              <div class="question-turn-header">
                <Highlight text={q.header} query={searchQuery} />
              </div>
            )}
            <div class="question-turn-prompt">
              <Highlight text={q.question} query={searchQuery} />
            </div>
            <div class="question-turn-answer">
              <span class="question-turn-answer-label">
                <IconCheck /> {t("questionAnswer")}
              </span>
              <span class="question-turn-answer-text">
                {answers?.[index] ? (
                  <Highlight text={answers[index]} query={searchQuery} />
                ) : (
                  <span class="question-turn-pending">{answerFallback}</span>
                )}
              </span>
            </div>
          </li>
        ))}
      </ol>
      {/* An unrecognised result format is still better shown than silently dropped. */}
      {!answers && !cancelled && outputText && (
        <pre class="tool-pre question-turn-raw">
          <Highlight text={outputText} query={searchQuery} />
        </pre>
      )}
    </section>
  );
}
