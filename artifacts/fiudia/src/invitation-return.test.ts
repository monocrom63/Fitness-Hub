import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  acceptStaffInvitation, afterAuthInviteUrl, clearInvite, enterInvitation, invitationReturnDestination, pendingInvitationPath,
} from './invitation-return.ts';

function tabStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value); },
    removeItem: (key: string) => { items.delete(key); },
  };
}

test('team invitation survives both auth screens and redirects only in its own tab', () => {
  const tab = tabStorage();
  const otherTab = tabStorage();
  const token = 'Studio/Neu?X=ä';
  assert.equal(afterAuthInviteUrl(tab, '/fiudia'), undefined, 'ordinary sign-in retains its default destination');
  assert.equal(enterInvitation(tab, token), '/sign-in');
  const path = '/invite/Studio%2FNeu%3FX%3D%C3%A4';
  assert.equal(pendingInvitationPath(tab), path);
  assert.equal(afterAuthInviteUrl(tab, '/fiudia'), `/fiudia${path}`, 'sign-in returns to the invitation');
  assert.equal(afterAuthInviteUrl(tab, '/fiudia'), `/fiudia${path}`, 'sign-up and auth callbacks use the same destination');
  assert.equal(pendingInvitationPath(otherTab), null);
  clearInvite(tab);
  assert.equal(afterAuthInviteUrl(tab, '/fiudia'), undefined);
});

test('new invitations replace old ones and only successful acceptance clears the destination', async () => {
  const tab = tabStorage();
  enterInvitation(tab, 'old-token');
  enterInvitation(tab, 'new-token');
  assert.equal(pendingInvitationPath(tab), '/invite/new-token');
  await assert.rejects(
    acceptStaffInvitation(tab, 'new-token', async () => { throw new Error('wrong account'); }),
    /wrong account/,
  );
  assert.equal(pendingInvitationPath(tab), '/invite/new-token');
  let accepted = '';
  await acceptStaffInvitation(tab, 'new-token', async token => { accepted = token; });
  assert.equal(accepted, 'new-token');
  assert.equal(pendingInvitationPath(tab), null);
});

test('authenticated fallback landings return to the invitation before onboarding or studio data loads', () => {
  const tab = tabStorage();
  enterInvitation(tab, 'studio-B');
  for (const path of ['/', '/dashboard', '/onboarding', '/members', '/courses', '/team', '/settings']) {
    assert.equal(invitationReturnDestination(tab, path, true, true), '/invite/studio-B', path);
    assert.equal(invitationReturnDestination(tab, path, false, true), null, 'wait for Clerk');
    assert.equal(invitationReturnDestination(tab, path, true, false), null, 'do not redirect signed-out users');
  }
  for (const path of ['/sign-in', '/sign-up', '/sign-in/sso-callback', '/sign-up/verify-email-address', '/invite/new-studio']) {
    assert.equal(invitationReturnDestination(tab, path, true, true), null, path);
  }
  clearInvite(tab);
  assert.equal(invitationReturnDestination(tab, '/onboarding', true, true), null);
});

test('root and prefixed deployments retain the exact invitation through callback and confirmed-email return', () => {
  for (const base of ['', '/fiudia']) {
    const tab = tabStorage();
    enterInvitation(tab, 'destination-studio');
    assert.equal(afterAuthInviteUrl(tab, base), `${base}/invite/destination-studio`);
    assert.equal(invitationReturnDestination(tab, '/sign-up/verify-email-address', true, true), null);
    assert.equal(invitationReturnDestination(tab, '/', true, true), '/invite/destination-studio');
    assert.equal(pendingInvitationPath(tab), '/invite/destination-studio', 'return is not acceptance');
  }
});