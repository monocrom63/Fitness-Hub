import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pulseArchiveHref, readPulseArchiveLocation } from './PulseArchiveLocation.ts';

test('Pulse search and unread filter survive reloads, navigation and clearing independently', () => {
  const searched = pulseArchiveHref('', { searchTerm: '  Trainingsplan  ' });
  assert.equal(searched, '/pulse?search=Trainingsplan');
  const unread = pulseArchiveHref(searched.split('?')[1], { filter: 'unread' });
  assert.deepEqual(readPulseArchiveLocation(unread.split('?')[1]), { filter: 'unread', searchTerm: 'Trainingsplan' });
  const all = pulseArchiveHref(unread.split('?')[1], { filter: 'all' });
  assert.deepEqual(readPulseArchiveLocation(all.split('?')[1]), { filter: 'all', searchTerm: 'Trainingsplan' });
  const cleared = pulseArchiveHref(unread.split('?')[1], { searchTerm: '' });
  assert.deepEqual(readPulseArchiveLocation(cleared.split('?')[1]), { filter: 'unread', searchTerm: '' });
  assert.equal(cleared, '/pulse?filter=unread');
});

test('Pulse archive URLs encode literal text, preserve unrelated parameters and bound API searches', () => {
  const href = pulseArchiveHref('compose=1&filter=unread', { searchTerm: '  Raum & Yoga?  ' });
  assert.deepEqual(readPulseArchiveLocation(href.split('?')[1]), { filter: 'unread', searchTerm: 'Raum & Yoga?' });
  assert.equal(new URLSearchParams(href.split('?')[1]).get('compose'), '1');
  assert.deepEqual(readPulseArchiveLocation(`filter=unknown&search=${'x'.repeat(200)}`), {
    filter: 'all', searchTerm: 'x'.repeat(120),
  });
  assert.deepEqual(readPulseArchiveLocation('search=%20%20'), { filter: 'all', searchTerm: '' });
});