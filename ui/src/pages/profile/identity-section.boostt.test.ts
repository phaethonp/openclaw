/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UserProfile } from "../../../../packages/gateway-protocol/src/index.ts";
import { renderIdentitySection } from "./identity-section.ts";

type IdentitySectionProps = Parameters<typeof renderIdentitySection>[0];

const PROFILE: UserProfile = {
  id: "profile-1",
  displayName: "Linna Hunt",
  avatarMime: null,
  mergedInto: null,
  createdAt: 1,
  updatedAt: 2,
  emails: ["member@example.com"],
  githubIdentity: null,
  hasAvatar: false,
};

function props(profile: UserProfile): IdentitySectionProps {
  return {
    profile,
    avatarUrl: null,
    displayName: profile.displayName ?? "",
    gitCoauthorEnabled: false,
    busy: null,
    error: null,
    onDisplayNameInput: vi.fn(),
    onSaveDisplayName: vi.fn(),
    onAvatarSelect: vi.fn(),
    onGitCoauthorChange: vi.fn(),
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("identity section, Boostt account row", () => {
  it("shows the verified Boostt sign-in identity", () => {
    const container = document.createElement("div");
    render(
      renderIdentitySection(
        props({ ...PROFILE, boosttIdentity: { userId: 14145, handle: "linna-hunt" } }),
      ),
      container,
    );
    expect(container.textContent).toContain("Boostt account");
    expect(container.textContent).toContain("@linna-hunt");
    expect(container.textContent).toContain("Verified from your Boostt sign-in");
  });

  it("falls back to the user id without a handle, and says so when there is none", () => {
    const container = document.createElement("div");
    render(
      renderIdentitySection(props({ ...PROFILE, boosttIdentity: { userId: 14145, handle: null } })),
      container,
    );
    expect(container.textContent).toContain("#14145");
    render(renderIdentitySection(props(PROFILE)), container);
    expect(container.textContent).toContain("Not signed in with Boostt");
    expect(container.textContent).not.toContain("#14145");
  });
});
