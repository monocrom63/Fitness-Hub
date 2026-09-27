const pendingInviteKey = 'fiudia-member-pending-invite';

type InviteStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function pendingInvite(storage: InviteStorage): string | null {
  return storage.getItem(pendingInviteKey);
}

export function rememberInvite(storage: InviteStorage, token: string): void {
  storage.setItem(pendingInviteKey, token);
}

export function clearInvite(storage: InviteStorage): void {
  storage.removeItem(pendingInviteKey);
}

export function invitePath(token: string): string {
  return `/invite/${encodeURIComponent(token)}`;
}

export function enterInvitation(storage: InviteStorage, token: string, isSignedIn: boolean | undefined): '/sign-in' | null {
  rememberInvite(storage, token);
  return isSignedIn ? null : '/sign-in';
}

export function pendingInvitationPath(storage: InviteStorage): string | null {
  const token = pendingInvite(storage);
  return token ? invitePath(token) : null;
}

export function afterAuthPath(storage: InviteStorage, basePath: string, fallback: '/' | '/connect'): string {
  return `${basePath}${pendingInvitationPath(storage) ?? fallback}`;
}

export async function acceptInvitation(
  storage: InviteStorage,
  token: string,
  accept: (data: { token: string }) => Promise<unknown>,
): Promise<void> {
  await accept({ token });
  clearInvite(storage);
}