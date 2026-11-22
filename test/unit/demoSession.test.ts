import { describe, expect, it } from "vitest";
import { chatReducer, initialChatState } from "../../src/shared/chatReducer";
import { DEMO_EVENTS, DEMO_SESSION, DEMO_SESSION_ID, demoEventDelay } from "../../src/shared/demoSession";

describe("recorded demo session", () => {
  it("ships a consistent, self-contained payload", () => {
    expect(DEMO_SESSION.id).toBe(DEMO_SESSION_ID);
    expect(DEMO_SESSION.messages).toEqual([]);
    expect(DEMO_SESSION.permissions).toEqual([]);
    expect(DEMO_SESSION.forms).toEqual([]);
    expect(DEMO_EVENTS.length).toBeGreaterThan(20);
  });

  it("folds every recorded event into a finished conversation without a host", () => {
    let state = chatReducer(initialChatState, {
      type: "load",
      sessionId: DEMO_SESSION.id,
      title: DEMO_SESSION.title,
      agent: DEMO_SESSION.agent,
      model: DEMO_SESSION.model,
      busy: false,
      messages: DEMO_SESSION.messages,
      permissions: DEMO_SESSION.permissions,
      forms: DEMO_SESSION.forms,
    });
    for (const event of DEMO_EVENTS) {
      const sid = (event.data as { sessionID?: string } | undefined)?.sessionID;
      if (sid) expect(sid).toBe(DEMO_SESSION_ID);
      state = chatReducer(state, { type: "event", event });
    }
    expect(state.messages.length).toBeGreaterThan(0);
    expect(state.busy).toBe(false);
    expect(state.turns.length).toBeGreaterThan(0);
    const text = state.messages.map((m) => ("parts" in m ? m.parts.map((p) => ("text" in p ? p.text : "")).join(" ") : "")).join(" ");
    expect(text).toContain("Done");
  });

  it("paces streaming deltas faster than structural events", () => {
    expect(demoEventDelay({ type: "session.text.delta" } as never)).toBeLessThan(demoEventDelay({ type: "session.step.started" } as never));
    expect(demoEventDelay({ type: "session.reasoning.delta" } as never)).toBe(70);
  });
});
