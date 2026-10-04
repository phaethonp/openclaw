/** Connection-held identity synchronization contract, independent of its transport. */
type AuthenticatedIdentitySyncResult = { profileId: string; updatedAt: number };
export type AuthenticatedIdentitySync = () => Promise<AuthenticatedIdentitySyncResult>;
