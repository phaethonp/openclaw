import { render } from "lit";
import { describe, expect, it } from "vitest";
import { renderChatWorkingIndicator } from "./chat-working-indicator.ts";

describe("renderChatWorkingIndicator", () => {
  it("renders neutral dots and forwards authored phrases", () => {
    const container = document.createElement("div");
    const workingPhrases = ["Building"];
    render(
      renderChatWorkingIndicator(
        { kind: "reading-indicator", key: "run:1", startedAt: 1 },
        { workingPhrases },
      ),
      container,
    );
    const bubble = container.querySelector(".chat-reading-indicator--neutral");
    expect(bubble?.querySelectorAll("span")).toHaveLength(3);
    expect(bubble?.querySelector("svg")).toBeNull();
    expect(
      [...bubble!.classList].filter((name) => name.startsWith("chat-reading-indicator--")),
    ).toEqual(["chat-reading-indicator--neutral"]);
    expect(container.querySelector("openclaw-working-phrase")).toHaveProperty(
      "phrases",
      workingPhrases,
    );
  });

  it("keeps approval waits on the neutral dots", () => {
    const container = document.createElement("div");
    render(
      renderChatWorkingIndicator(
        { kind: "reading-indicator", key: "run:2", startedAt: 1 },
        { waitingApproval: true },
      ),
      container,
    );
    expect(container.querySelector(".chat-reading-indicator--neutral")).not.toBeNull();
  });
});
