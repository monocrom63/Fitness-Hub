import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptInvitation, afterAuthPath, clearInvite, enterInvitation, invitePath, pendingInvitationPath, pendingInvite, rememberInvite } from '../src/invitation-return.ts';

function tabStorage() {
  const items = new Map();
  return {
    getItem: key => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, value),
    removeItem: key => items.delete(key),
  };
}

test('an invitation survives sign-in, sign-up and a protected-page redirect in the same tab', () => {
  const tab = tabStorage();
  const otherTab = tabStorage();
  rememberInvite(tab, 'studio-A-token');
  assert.equal(afterAuthPath(tab, '/fiudia-members', '/'), '/fiudia-members/invite/studio-A-token');
  assert.equal(afterAuthPath(tab, '/fiudia-members', '/connect'), '/fiudia-members/invite/studio-A-token');
  assert.equal(invitePath(pendingInvite(tab)), '/invite/studio-A-token');
  assert.equal(pendingInvite(otherTab), null);
  assert.equal(afterAuthPath(otherTab, '/fiudia-members', '/'), '/fiudia-members/');
});

test('a newer invitation replaces the older destination, and completion clears it', () => {
  const tab = tabStorage();
  rememberInvite(tab, 'studio-A-token');
  rememberInvite(tab, 'studio-B-token');
  assert.equal(afterAuthPath(tab, '/fiudia-members', '/'), '/fiudia-members/invite/studio-B-token');
  clearInvite(tab);
  assert.equal(pendingInvite(tab), null);
  assert.equal(afterAuthPath(tab, '/fiudia-members', '/connect'), '/fiudia-members/connect');
  assert.equal(invitePath('a/b'), '/invite/a%2Fb');
});

test('invite entry, both auth routes, protected redirect and acceptance share the same encoded destination', async () => {
  const tab = tabStorage();
  const token = 'studio/Neu?X=ä';
  const route = '/invite/studio%2FNeu%3FX%3D%C3%A4';
  assert.equal(enterInvitation(tab, token, false), '/sign-in');
  assert.equal(afterAuthPath(tab, '/fiudia-members', '/'), `/fiudia-members${route}`);
  assert.equal(afterAuthPath(tab, '/fiudia-members', '/connect'), `/fiudia-members${route}`);
  assert.equal(pendingInvitationPath(tab), route);
  assert.equal(enterInvitation(tab, token, true), null);

  const received = [];
  await assert.rejects(acceptInvitation(tab, token, async data => {
    received.push(data);
    throw new Error('request failed');
  }), /request failed/);
  assert.equal(pendingInvite(tab), token, 'failed acceptance must keep the invitation');

  await acceptInvitation(tab, token, async data => { received.push(data); });
  assert.deepEqual(received, [{ token }, { token }]);
  assert.equal(pendingInvitationPath(tab), null);
  assert.equal(afterAuthPath(tab, '/fiudia-members', '/connect'), '/fiudia-members/connect');
});

test('root and prefixed deployment returns preserve the invitation until explicit acceptance', () => {
  for (const base of ['', '/fiudia-members']) {
    const tab = tabStorage();
    assert.equal(enterInvitation(tab, 'studio-B', undefined), '/sign-in');
    for (const fallback of ['/', '/connect']) {
      assert.equal(afterAuthPath(tab, base, fallback), `${base}/invite/studio-B`);
    }
    // Restored identity after OAuth/email confirmation must not consume the token.
    assert.equal(enterInvitation(tab, 'studio-B', true), null);
    assert.equal(pendingInvitationPath(tab), '/invite/studio-B');
    clearInvite(tab);
    assert.equal(pendingInvitationPath(tab), null);
  }
});

test('member and staff invitation storage cannot overwrite or clear each other', async () => {
  const tab = tabStorage();
  tab.setItem('fiudia-staff-pending-invite', 'staff-studio');
  enterInvitation(tab, 'member-studio', false);
  await acceptInvitation(tab, 'member-studio', async () => {});
  assert.equal(pendingInvite(tab), null);
  assert.equal(tab.getItem('fiudia-staff-pending-invite'), 'staff-studio');
});