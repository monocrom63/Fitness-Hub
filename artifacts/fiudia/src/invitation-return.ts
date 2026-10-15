const pendingInviteKey = 'fiudia-staff-pending-invite';

type InviteStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function rememberInvite(storage: InviteStorage, token: string): void {
  storage.setItem(pendingInviteKey, token);
}

export function clearInvite(storage: InviteStorage): void {
  storage.removeItem(pendingInviteKey);
}

export function enterInvitation(storage: InviteStorage, token: string): '/sign-in' {
  rememberInvite(storage, token);
  return '/sign-in';
}

export function pendingInvitationPath(storage: InviteStorage): string | null {
  const token = storage.getItem(pendingInviteKey);
  return token ? `/invite/${encodeURIComponent(token)}` : null;
}

export function afterAuthInviteUrl(storage: InviteStorage, basePath: string): string | undefined {
  const path = pendingInvitationPath(storage);
  return path ? `${basePath}${path}` : undefined;
}

export function invitationReturnDestination(
  storage: InviteStorage,
  path: string,
  isLoaded: boolean,
  isSignedIn: boolean | undefined,
): string | null {
  // Do not interrupt Clerk's email verification / OAuth callback subroutes.
  // A directly opened invitation takes precedence over an older pending one.
  if (!isLoaded || !isSignedIn || /^\/(?:sign-in|sign-up|invite)(?:\/|$)/.test(path)) return null;
  return pendingInvitationPath(storage);
}

export async function acceptStaffInvitation(
  storage: InviteStorage,
  token: string,
  accept: (token: string) => Promise<unknown>,
): Promise<void> {
  await accept(token);
  clearInvite(storage);
}