import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enBoostt = {
  boosttAccount: {
    title: "Boostt account",
    description:
      "Connect the Boostt account this agent acts for. Your name, your card and your record come from it.",
    status: "Status",
    connected: "Connected",
    disconnected: "Not connected",
    checking: "Checking…",
    account: "Account",
    memberId: "Member id",
    connectedSince: "Connected since",
    connect: "Connect Boostt account",
    connecting: "Waiting for your approval at Boostt…",
    openBoostt: "Open Boostt sign-in",
    cancel: "Cancel",
    disconnect: "Disconnect",
    disconnectConfirmTitle: "Disconnect this Boostt account?",
    disconnectConfirmMessage:
      "The agent stops acting for this account. Nothing at Boostt is changed; you can connect again at any time.",
    signInRequired: "Connect from an authenticated Gateway connection.",
    readRequired: "Connecting a Boostt account requires operator.read access.",
    expired: "The connection link expired. Start again.",
    failed: "The connection failed: {reason}",
    popupBlocked: "Your browser blocked the Boostt window. Use the link below.",
  },
} satisfies TranslationMap;

export const registerBoosttEnglish = Object.assign(
  () => Object.assign(en as Record<string, unknown>, { boosttAccount: enBoostt.boosttAccount }),
  { catalog: enBoostt },
);
