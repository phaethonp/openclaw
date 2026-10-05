/**
 * The plugin's work, independent of the Gateway's HTTP and state plumbing so
 * it can be tested with a stub Boostt and a temp workspace.
 */
import {
  handleOf,
  readOwnerCard,
  whoIs,
  type BoosttAccount,
  type BoosttSettings,
} from "./account.js";
import { removeCardFile, renderCardFile, writeCardFile } from "./workspace.js";

export type OwnerStore = {
  lookup: (key: string) => Promise<BoosttAccount | undefined>;
  register: (key: string, value: BoosttAccount) => Promise<void>;
  delete: (key: string) => Promise<boolean>;
};

export const OWNER_KEY = "owner";

export type UrbicanaServiceOptions = {
  settings: BoosttSettings;
  store: OwnerStore;
  /** The agent workspace the card is written into. */
  workspaceDir: () => string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  log?: { info: (msg: string) => void; warn: (msg: string) => void };
};

export type OwnerStatus = {
  connected: boolean;
  userId?: number;
  email?: string;
  handle?: string | null;
  displayName?: string | null;
  connectedAt?: string;
  cardWrittenAt?: string;
  cardVersion?: string | null;
  cardFile: string;
};

export function createUrbicanaService(opts: UrbicanaServiceOptions) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? { info: () => undefined, warn: () => undefined };

  async function status(): Promise<OwnerStatus> {
    const owner = await opts.store.lookup(OWNER_KEY);
    if (!owner) {
      return { connected: false, cardFile: opts.settings.cardFile };
    }
    const { accessToken: _token, ...rest } = owner;
    return { connected: true, ...rest, cardFile: opts.settings.cardFile };
  }

  /** Writes the owner's card into the workspace from Boostt; the stored token is used. */
  async function refreshCard(owner: BoosttAccount): Promise<BoosttAccount> {
    const ownerCard = await readOwnerCard(opts.settings, owner.accessToken, fetchImpl);
    const withHandle: BoosttAccount = {
      ...owner,
      handle: handleOf(ownerCard.card) ?? owner.handle,
    };
    const writtenAt = now();
    writeCardFile(
      opts.workspaceDir(),
      opts.settings.cardFile,
      renderCardFile(withHandle, ownerCard, writtenAt),
    );
    const version = typeof ownerCard.card.version === "string" ? ownerCard.card.version : null;
    const updated: BoosttAccount = {
      ...withHandle,
      cardWrittenAt: writtenAt.toISOString(),
      cardVersion: version,
    };
    await opts.store.register(OWNER_KEY, updated);
    log.info(`owner card written to ${opts.settings.cardFile} (version ${version ?? "none"})`);
    return updated;
  }

  /**
   * The proxy hands over the signed-in person's Boostt token. The plugin asks
   * Boostt whose it is; a Gateway already connected to another person refuses,
   * since one Gateway acts for one owner.
   */
  async function connect(accessToken: string): Promise<OwnerStatus> {
    if (!opts.settings.railsUrl) {
      throw new Error("the plugin has no Boostt API origin (railsUrl)");
    }
    const who = await whoIs(opts.settings, accessToken, fetchImpl);
    const current = await opts.store.lookup(OWNER_KEY);
    if (current && current.userId !== who.userId) {
      throw new Error(
        `this Gateway acts for Boostt user ${current.userId}; it does not take a second owner`,
      );
    }
    // The Gateway's state store refuses a value with an undefined field, so
    // the card fields are present only once a card has been written.
    const owner: BoosttAccount = {
      ...who,
      accessToken,
      connectedAt: current?.connectedAt ?? now().toISOString(),
      ...(current?.cardWrittenAt
        ? { cardWrittenAt: current.cardWrittenAt, cardVersion: current.cardVersion ?? null }
        : {}),
    };
    await opts.store.register(OWNER_KEY, owner);
    try {
      await refreshCard(owner);
    } catch (error) {
      log.warn(
        `owner connected but the card could not be written: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return status();
  }

  async function refresh(): Promise<OwnerStatus> {
    const owner = await opts.store.lookup(OWNER_KEY);
    if (!owner) {
      throw new Error("no owner is connected");
    }
    await refreshCard(owner);
    return status();
  }

  async function disconnect(): Promise<OwnerStatus> {
    await opts.store.delete(OWNER_KEY);
    removeCardFile(opts.workspaceDir(), opts.settings.cardFile);
    return status();
  }

  return { status, connect, refresh, disconnect };
}

export type UrbicanaService = ReturnType<typeof createUrbicanaService>;
