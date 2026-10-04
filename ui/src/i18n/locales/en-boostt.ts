import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Settings → Profile → Boostt account. Registered under the profile page's
// catalog beside the identity and access copy, loaded with its element.
const enBoostt = {
  profilePage: {
    identity: {
      boosttAccount: "Boostt account",
      boosttAccountDescription:
        "Verified sign-in identity: the Boostt account this profile is. The credential for Boostt tools is managed under Boostt account below.",
      boosttVerified: "Verified from your Boostt sign-in",
      boosttUnavailable: "Not signed in with Boostt",
      boosttUnavailableDescription:
        "A Boostt-backed sign-in through the trusted proxy provides this identity.",
    },
    boosttAccount: {
      title: "Boostt account",
      description:
        "Connect the Boostt account this profile uses. The connection is a credential for Boostt; it does not change who is signed in here.",
      status: "Status",
      connected: "Connected",
      disconnected: "Not connected",
      reconnectRequired: "Reconnect required",
      checking: "Checking…",
      account: "Account",
      memberId: "Boostt user id",
      connectedSince: "Connected since",
      connect: "Connect Boostt account",
      connecting: "Waiting for your approval at Boostt…",
      openBoostt: "Open Boostt sign-in",
      cancel: "Cancel",
      disconnect: "Disconnect",
      disconnectConfirmTitle: "Disconnect this Boostt account?",
      disconnectConfirmMessage:
        "This profile stops holding the Boostt credential. Nothing at Boostt is changed; you can connect again at any time.",
      signInRequired: "Connect from an authenticated Gateway connection.",
      readRequired: "Connecting a Boostt account requires operator.read access.",
      expired: "The connection link expired. Start again.",
      refreshFailed: "Boostt refused to renew the session. Disconnect and connect again.",
      popupBlocked: "Your browser blocked the Boostt window. Use the link below.",
    },
  },
} satisfies TranslationMap;

export const registerBoosttEnglish = Object.assign(
  () => {
    Object.assign(en.profilePage.identity, enBoostt.profilePage.identity);
    Object.assign(en.profilePage, { boosttAccount: enBoostt.profilePage.boosttAccount });
  },
  { catalog: enBoostt },
);
