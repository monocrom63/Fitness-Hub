import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  acceptStaffInvitation, afterAuthInviteUrl, clearInvite, enterInvitation, pendingInvitationPath,
} from './invitation-return';

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