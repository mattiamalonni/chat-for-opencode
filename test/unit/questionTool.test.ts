import { describe, expect, it } from "vitest";
import type { ToolPart } from "../../src/shared/chatReducer";
import { isQuestionTool, questionSearchText, questionToolView } from "../../src/shared/questionTool";

const questions = [
  { question: "What is your favorite color?", header: "Favorite color", options: [{ label: "Blue" }] },
  { question: "Which files?", header: "Files" },
];

function part(overrides: Partial<ToolPart> = {}): ToolPart {
  return {
    kind: "tool",
    key: "tool:q1",
    id: "q1",
    name: "question",
    status: "completed",
    input: { questions },
    inputText: JSON.stringify({ questions }, null, 2),
    output: [
      {
        type: "text",
        text: 'User has answered your questions: "What is your favorite color?"="Blue", "Which files?"="a.ts, b.ts". You can now continue with the user\'s answers in mind.',
      },
    ],
    ...overrides,
  };
}

describe("questionTool", () => {
  it("recognises a question tool by its input, not by other tools' output", () => {
    expect(isQuestionTool(part())).toBe(true);
    expect(isQuestionTool(part({ name: "bash" }))).toBe(false);
    expect(isQuestionTool(part({ input: { questions: [] } }))).toBe(false);
    expect(isQuestionTool(part({ input: undefined, inputText: "{}" }))).toBe(false);
  });

  it("reads questions from a string input, as in server history", () => {
    const view = questionToolView(part({ input: undefined }));
    expect(view.questions).toEqual([
      { question: "What is your favorite color?", header: "Favorite color" },
      { question: "Which files?", header: "Files" },
    ]);
  });

  it("prefers structured answers from the tool result", () => {
    const view = questionToolView(part({ metadata: { answers: [["Green"], ["a.ts", "b.ts"]] } }));
    expect(view.answers).toEqual(["Green", "a.ts, b.ts"]);
  });

  it("falls back to the answer text when the result has no metadata", () => {
    expect(questionToolView(part()).answers).toEqual(["Blue", "a.ts, b.ts"]);
  });

  it("keeps an unrecognised result as raw text", () => {
    const view = questionToolView(part({ output: [{ type: "text", text: "The user dismissed this question" }] }));
    expect(view.answers).toBeUndefined();
    expect(view.outputText).toBe("The user dismissed this question");
  });

  it("includes questions and answers in the conversation search text", () => {
    expect(questionSearchText(part())).toContain("Favorite color");
    expect(questionSearchText(part())).toContain("a.ts, b.ts");
  });
});
