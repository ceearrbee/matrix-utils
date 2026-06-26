import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    isCreatorPrivilegedVersion,
    isPrivilegedCreator,
    myLevel,
    computeRoomCapabilities,
    formatLevel,
    parseMxc,
    thumbnailEndpoints,
    CAPABILITIES
} from './matrix-api.js';

const ME = '@me:example.org';

function findCap(result, key) {
    const c = result.caps.find(c => c.key === key);
    assert.ok(c, `capability ${key} should exist`);
    return c;
}

test('isCreatorPrivilegedVersion: only numeric versions >= 12', () => {
    assert.equal(isCreatorPrivilegedVersion('12'), true);
    assert.equal(isCreatorPrivilegedVersion('13'), true);
    assert.equal(isCreatorPrivilegedVersion('11'), false);
    assert.equal(isCreatorPrivilegedVersion('1'), false);
    assert.equal(isCreatorPrivilegedVersion('org.example.12'), false);
    assert.equal(isCreatorPrivilegedVersion(undefined), false);
});

test('no power_levels event: spec defaults apply and everything uses a default', () => {
    const r = computeRoomCapabilities(null, { room_version: '11' }, ME);
    assert.equal(r.myLevel, 0);
    assert.equal(r.hadPowerLevels, false);

    // At level 0: can send messages (events_default 0), cannot kick/ban (50).
    assert.equal(findCap(r, 'm.room.message').can, true);
    assert.equal(findCap(r, 'kick').can, false);
    assert.equal(findCap(r, 'ban').can, false);

    // All capability levels came from spec defaults, not explicit keys.
    assert.ok(r.caps.every(c => c.usesDefault === true));
});

test('explicit users[me]=100: can do everything; defined keys are not defaults', () => {
    const pl = {
        users: { [ME]: 100 },
        users_default: 0,
        events_default: 0,
        state_default: 50,
        kick: 50, ban: 50, redact: 50, invite: 50,
        events: { 'm.room.tombstone': 100 }
    };
    const r = computeRoomCapabilities(pl, { room_version: '10' }, ME);
    assert.equal(r.myLevel, 100);
    assert.equal(r.hadPowerLevels, true);
    assert.ok(r.caps.every(c => c.can === true));

    assert.equal(findCap(r, 'kick').usesDefault, false);
    assert.equal(findCap(r, 'm.room.tombstone').required, 100);
    assert.equal(findCap(r, 'm.room.tombstone').usesDefault, false);
});

test('v12+ creator in additional_creators: infinite power, all capabilities allowed', () => {
    const create = { room_version: '12', additional_creators: [ME] };
    // Power levels that would otherwise lock everything down.
    const pl = { users_default: 0, kick: 100, ban: 100, state_default: 100, events: { 'm.room.tombstone': 100 } };

    assert.equal(isPrivilegedCreator(create, ME), true);
    assert.equal(myLevel(pl, create, ME), Infinity);

    const r = computeRoomCapabilities(pl, create, ME);
    assert.equal(r.privilegedCreator, true);
    assert.ok(r.caps.every(c => c.can === true));
    assert.equal(formatLevel(r.myLevel), '∞');
});

test('pre-v11 recorded creator does NOT get infinite power', () => {
    const create = { room_version: '6', creator: ME };
    const pl = { users_default: 0, kick: 50 };
    assert.equal(isPrivilegedCreator(create, ME), false);
    assert.equal(myLevel(pl, create, ME), 0);
    const r = computeRoomCapabilities(pl, create, ME);
    assert.equal(r.recordedCreator, true);
    assert.equal(findCap(r, 'kick').can, false);
});

test('per-event override lets a low-level user set a specific state event', () => {
    const pl = { users: { [ME]: 0 }, state_default: 50, events: { 'm.room.name': 0 } };
    const r = computeRoomCapabilities(pl, { room_version: '10' }, ME);
    assert.equal(findCap(r, 'm.room.name').required, 0);
    assert.equal(findCap(r, 'm.room.name').can, true);
    // A different state event still needs state_default.
    assert.equal(findCap(r, 'm.room.topic').required, 50);
    assert.equal(findCap(r, 'm.room.topic').can, false);
});

test('events_default raises the bar for sending messages', () => {
    const pl = { users: { [ME]: 25 }, events_default: 50 };
    const r = computeRoomCapabilities(pl, { room_version: '10' }, ME);
    const msg = findCap(r, 'm.room.message');
    assert.equal(msg.required, 50);
    assert.equal(msg.can, false);
    assert.equal(msg.usesDefault, false); // came from events_default, explicitly set
});

test('v12+ founding creator (resolved sender) gets infinite power', () => {
    const create = { room_version: '12' }; // no additional_creators
    const pl = { users_default: 0, kick: 100, state_default: 100 };
    // Unknown sender: cannot tell from content alone.
    assert.equal(isPrivilegedCreator(create, ME), false);
    assert.equal(myLevel(pl, create, ME), 0);
    // Resolved sender == me: infinite power.
    assert.equal(isPrivilegedCreator(create, ME, ME), true);
    assert.equal(myLevel(pl, create, ME, ME), Infinity);

    const r = computeRoomCapabilities(pl, create, ME, ME);
    assert.equal(r.privilegedCreator, true);
    assert.equal(r.foundingCreatorKnown, true);
    assert.ok(r.caps.every(c => c.can === true));
});

test('foundingCreatorKnown reflects whether a v12+ sender was resolved', () => {
    const create = { room_version: '12' };
    assert.equal(computeRoomCapabilities({}, create, ME).foundingCreatorKnown, false);
    assert.equal(computeRoomCapabilities({}, create, ME, '@other:x').foundingCreatorKnown, true);
    // Pre-v12 rooms are always "known" (the caveat doesn't apply).
    assert.equal(computeRoomCapabilities({}, { room_version: '10' }, ME).foundingCreatorKnown, true);
});

test('m.space.child capability appears only for spaces', () => {
    const inRoom = computeRoomCapabilities({}, { room_version: '11' }, ME);
    assert.equal(inRoom.caps.some(c => c.key === 'm.space.child'), false);

    const inSpace = computeRoomCapabilities({}, { room_version: '11', type: 'm.space' }, ME);
    assert.equal(inSpace.caps.some(c => c.key === 'm.space.child'), true);
    // Pin-messages applies everywhere.
    assert.equal(inRoom.caps.some(c => c.key === 'm.room.pinned_events'), true);
});

test('parseMxc and thumbnailEndpoints', () => {
    assert.deepEqual(parseMxc('mxc://example.org/abc123'), { serverName: 'example.org', mediaId: 'abc123' });
    assert.equal(parseMxc('not-an-mxc'), null);
    const eps = thumbnailEndpoints('mxc://example.org/abc123', 'https://hs.example', 48);
    assert.equal(eps.length, 2);
    assert.ok(eps[0].includes('/_matrix/client/v1/media/thumbnail/example.org/abc123'));
    assert.ok(eps[0].includes('width=48'));
    assert.ok(eps[1].includes('/_matrix/media/v3/thumbnail/'));
    assert.deepEqual(thumbnailEndpoints('bad', 'https://hs.example'), []);
});

test('CAPABILITIES table is well-formed', () => {
    assert.ok(CAPABILITIES.length > 0);
    for (const c of CAPABILITIES) {
        assert.equal(typeof c.key, 'string');
        assert.equal(typeof c.label, 'string');
        assert.equal(typeof c.cat, 'string');
        const lvl = c.level({});
        assert.equal(typeof lvl.value, 'number');
        assert.equal(typeof lvl.explicit, 'boolean');
    }
});
