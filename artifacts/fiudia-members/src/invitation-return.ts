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

export function afterAuthPath(storage: InviteStorage, basePath: string, fallback: '/' | '/connect'): string {
  const token = pendingInvite(storage);
  return `${basePath}${token ? invitePath(token) : fallback}`;
}