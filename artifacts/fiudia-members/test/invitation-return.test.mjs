import assert from 'node:assert/strict';
import { test } from 'node:test';
import { afterAuthPath, clearInvite, invitePath, pendingInvite, rememberInvite } from '../src/invitation-return.ts';

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