import { describe, expect, it, vi } from "vitest";
import type { ServerEvent } from "../../src/shared/api";
import { chatReducer, initialChatState } from "../../src/shared/chatReducer";
import { JobTracker } from "../../src/chat/jobTracker";
import { parseJobInfo } from "../../src/shared/jobs";
import { syntheticNotice } from "../../src/shared/synthetic";

const SID = "ses_jobs";

function jobEvent(status: string): ServerEvent {
  return {
    type: "experimental.job.updated",
    data: {
      sessionID: SID,
      info: {
        id: "job-1",
        sessionID: SID,
        kind: "codemode",
        status,
        title: "Analyze project",
        time: { started: 10 },
      },
    },
  } as ServerEvent;
}

describe("JobTracker", () => {
  it("parses a job info and keeps only running jobs", () => {
    expect(parseJobInfo((jobEvent("running").data as { info: unknown }).info)).toMatchObject({
      id: "job-1",
      kind: "codemode",
      title: "Analyze project",
    });
    const tracker = new JobTracker();
    const changed = vi.fn();
    tracker.onDidChange(changed);
    expect(tracker.observe(jobEvent("running"))).toBe(true);
    expect(tracker.pendingFor(SID).map((job) => job.id)).toEqual(["job-1"]);
    expect(tracker.observe(jobEvent("completed"))).toBe(true);
    expect(tracker.pending()).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("drops jobs of a deleted session and on reset", () => {
    const tracker = new JobTracker();
    tracker.observe(jobEvent("running"));
    expect(tracker.observe({ type: "session.deleted", data: { sessionID: SID } } as ServerEvent)).toBe(true);
    expect(tracker.pending()).toEqual([]);
    tracker.observe(jobEvent("running"));
    tracker.reset();
    expect(tracker.pending()).toEqual([]);
  });

  it("replaces the registry with the server's running jobs after a reconnect", () => {
    const tracker = new JobTracker();
    const changed = vi.fn();
    tracker.onDidChange(changed);
    tracker.observe(jobEvent("running"));
    changed.mockClear();
    const missed = parseJobInfo({ id: "job-2", sessionID: SID, kind: "shell", status: "running", time: { started: 20 } })!;
    const done = parseJobInfo({ id: "job-3", sessionID: SID, kind: "image", status: "completed", time: { started: 5 } })!;
    // job-1 finished while the stream was down; job-2 started meanwhile; job-3 is not pending.
    expect(tracker.replace([missed, done])).toBe(true);
    expect(tracker.pending().map((job) => job.id)).toEqual(["job-2"]);
    expect(changed).toHaveBeenCalledTimes(1);
    // The same list again changes nothing and notifies nobody.
    expect(tracker.replace([missed])).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
  });
});

describe("synthetic notices", () => {
  it("compacts plain text and keeps the full payload as details", () => {
    const text = "<goal>Keep working on the task</goal>\nSecond line with more detail";
    const note = syntheticNotice(text, undefined, { resume: true });
    expect(note.text).toContain("Keep working on the task");
    expect(note.detail).toBe(text);
    expect(note.autoResume).toBe(true);
  });

  it("renders a live session.synthetic event as a compact notice", () => {
    const state = chatReducer(initialChatState, { type: "load", sessionId: SID, messages: [], permissions: [], forms: [] });
    const event = {
      type: "session.synthetic",
      data: { sessionID: SID, text: "Plan reminder: finish the release", metadata: { resume: false } },
    } as ServerEvent;
    const next = chatReducer(state, { type: "event", event });
    const notice = next.messages.find((m) => m.kind === "notice");
    expect(notice).toMatchObject({ code: "syntheticNotice", text: "Plan reminder: finish the release" });
  });

  it("labels a synthetic that wakes the agent automatically", () => {
    const state = chatReducer(initialChatState, { type: "load", sessionId: SID, messages: [], permissions: [], forms: [] });
    const event = {
      type: "session.inbox.enqueued",
      data: { sessionID: SID, item: { type: "synthetic", payload: { text: "watch: file changed", resume: true } } },
    } as ServerEvent;
    const notice = chatReducer(state, { type: "event", event }).messages.find((m) => m.kind === "notice");
    expect(notice?.code).toBe("syntheticNotice");
    expect(notice?.autoResume).toBe(true);
  });
});
