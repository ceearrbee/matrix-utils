// Unit tests for the pure plan-building logic (what the recreated room becomes).
// Run with: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    buildCreateRoomBody,
    computeTombstoneAuth,
    isCreatorPrivilegedVersion,
    DEFAULT_ENCRYPTION_ALGORITHM
} from './matrix-api.js';

const OP = '@op:example.org';

// Build a state-event array from the pieces a test cares about.
function makeState(opts = {}) {
    const {
        creator = OP,
        roomVersion = '10',
        additionalCreators,
        powerLevels,
        encryption,            // content object or undefined
        name,
        topic,
        members = [],          // [{ user, membership }]
        roomType,              // e.g. 'm.space'
        extraState = []        // raw extra state events
    } = opts;

    const createContent = { room_version: roomVersion };
    if (roomType) createContent.type = roomType;
    if (additionalCreators) createContent.additional_creators = additionalCreators;

    const events = [
        { type: 'm.room.create', state_key: '', sender: creator, content: createContent }
    ];
    if (powerLevels) events.push({ type: 'm.room.power_levels', state_key: '', content: powerLevels });
    if (encryption) events.push({ type: 'm.room.encryption', state_key: '', content: encryption });
    if (name) events.push({ type: 'm.room.name', state_key: '', content: { name } });
    if (topic) events.push({ type: 'm.room.topic', state_key: '', content: { topic } });
    for (const m of members) {
        events.push({ type: 'm.room.member', state_key: m.user, content: { membership: m.membership } });
    }
    return events.concat(extraState);
}

function build(opts, overrides = {}) {
    return buildCreateRoomBody({
        stateEvents: makeState(opts),
        operatorUserId: OP,
        oldRoomId: '!old:example.org',
        targetVersion: overrides.targetVersion || '10',
        encryptionMode: overrides.encryptionMode || 'keep',
        inviteMode: overrides.inviteMode || 'all',
        predecessorEventId: '$pred',
        directoryVisibility: 'private'
    });
}

function encryptionEvent(initialState) {
    return initialState.find(s => s.type === 'm.room.encryption');
}

// --- Encryption tri-state ----------------------------------------------------

test('encryption keep: preserves existing encryption', () => {
    const { body, plan } = build({ encryption: { algorithm: 'm.megolm.v1.aes-sha2', rotation_period_ms: 999 } }, { encryptionMode: 'keep' });
    const ev = encryptionEvent(body.initial_state);
    assert.ok(ev, 'encryption carried over');
    assert.equal(ev.content.rotation_period_ms, 999, 'exact old content reused');
    assert.equal(plan.willBeEncrypted, true);
    assert.equal(plan.wasEncrypted, true);
});

test('encryption keep: unencrypted room stays unencrypted', () => {
    const { body, plan } = build({}, { encryptionMode: 'keep' });
    assert.equal(encryptionEvent(body.initial_state), undefined);
    assert.equal(plan.willBeEncrypted, false);
    assert.equal(plan.wasEncrypted, false);
});

test('encryption off: drops existing encryption', () => {
    const { body, plan } = build({ encryption: { algorithm: 'm.megolm.v1.aes-sha2' } }, { encryptionMode: 'off' });
    assert.equal(encryptionEvent(body.initial_state), undefined);
    assert.equal(plan.willBeEncrypted, false);
    assert.equal(plan.wasEncrypted, true);
});

test('encryption on: enables fresh on an unencrypted room with the default algorithm', () => {
    const { body, plan } = build({}, { encryptionMode: 'on' });
    const ev = encryptionEvent(body.initial_state);
    assert.ok(ev, 'encryption added');
    assert.equal(ev.content.algorithm, DEFAULT_ENCRYPTION_ALGORITHM);
    assert.equal(plan.willBeEncrypted, true);
    assert.equal(plan.wasEncrypted, false);
});

test('encryption on: reuses old content when already encrypted', () => {
    const { body } = build({ encryption: { algorithm: 'm.megolm.v1.aes-sha2', rotation_period_ms: 42 } }, { encryptionMode: 'on' });
    assert.equal(encryptionEvent(body.initial_state).content.rotation_period_ms, 42);
});

// --- Invite modes ------------------------------------------------------------

const MEMBERS = [
    { user: OP, membership: 'join' },
    { user: '@a:example.org', membership: 'join' },
    { user: '@b:example.org', membership: 'invite' },
    { user: '@c:example.org', membership: 'leave' }
];

test('invite all: joined + already-invited, excluding the operator', () => {
    const { body, plan, invite } = build({ members: MEMBERS }, { inviteMode: 'all' });
    assert.deepEqual([...invite].sort(), ['@a:example.org', '@b:example.org']);
    assert.equal(plan.inviteCount, 2);
    assert.ok(!invite.includes(OP), 'operator never invited');
    assert.ok(!invite.includes('@c:example.org'), 'left members not invited');
    assert.equal(body.invite, undefined, 'invites are sent post-creation, not via createRoom');
});

test('invite joined: only currently-joined members', () => {
    const { invite } = build({ members: MEMBERS }, { inviteMode: 'joined' });
    assert.deepEqual(invite, ['@a:example.org']);
});

test('invite none: nobody invited', () => {
    const { invite, plan } = build({ members: MEMBERS }, { inviteMode: 'none' });
    assert.deepEqual(invite, []);
    assert.equal(plan.inviteCount, 0);
});

// --- Creator / power-level handling -----------------------------------------

test('pre-v12 target: operator forced to >=100 in users map', () => {
    const { body } = build(
        { powerLevels: { users: { [OP]: 50, '@a:example.org': 100 } } },
        { targetVersion: '10' }
    );
    assert.equal(body.power_level_content_override.users[OP], 100);
    assert.equal(body.power_level_content_override.users['@a:example.org'], 100);
});

test('v12+ target: creators removed from users map and set as additional_creators', () => {
    const { body, plan } = build(
        {
            roomVersion: '12',
            creator: OP,
            additionalCreators: ['@cocreator:example.org'],
            powerLevels: { users: { [OP]: 100, '@cocreator:example.org': 100, '@a:example.org': 50 } }
        },
        { targetVersion: '12' }
    );
    assert.equal(plan.v12plus, true);
    assert.deepEqual(plan.additionalCreators, ['@cocreator:example.org']);
    assert.deepEqual(body.creation_content.additional_creators, ['@cocreator:example.org']);
    assert.ok(!(OP in body.power_level_content_override.users), 'operator-creator not in users map');
    assert.ok(!('@cocreator:example.org' in body.power_level_content_override.users), 'co-creator not in users map');
    assert.equal(body.power_level_content_override.users['@a:example.org'], 50, 'non-creator retained');
});

// --- Carryover ---------------------------------------------------------------

test('name/topic become top-level params, not initial_state', () => {
    const { body } = build({ name: 'My Room', topic: 'Hello' });
    assert.equal(body.name, 'My Room');
    assert.equal(body.topic, 'Hello');
    assert.ok(!body.initial_state.some(s => s.type === 'm.room.name'));
    assert.ok(!body.initial_state.some(s => s.type === 'm.room.topic'));
});

test('carried state types include avatar/join_rules and exclude skipped types', () => {
    const { body, plan } = build({
        extraState: [
            { type: 'm.room.avatar', state_key: '', content: { url: 'mxc://x/y' } },
            { type: 'm.room.join_rules', state_key: '', content: { join_rule: 'invite' } }
        ]
    });
    assert.ok(plan.carriedStateTypes.includes('m.room.avatar'));
    assert.ok(plan.carriedStateTypes.includes('m.room.join_rules'));
    assert.ok(!plan.carriedStateTypes.includes('m.room.create'));
});

test('space room type preserved and reported', () => {
    const { body, plan } = build({ roomType: 'm.space' });
    assert.equal(body.creation_content.type, 'm.space');
    assert.equal(plan.roomType, 'm.space');
});

// --- Tombstone auth ----------------------------------------------------------

function authState(opts) {
    const events = makeState(opts);
    const byType = {};
    for (const ev of events) if (ev.state_key === '') byType[ev.type] = ev;
    return byType;
}

test('canTombstone true when operator level meets the required state_default', () => {
    const byType = authState({ powerLevels: { users: { [OP]: 50 }, state_default: 50 } });
    const res = computeTombstoneAuth(byType, OP);
    assert.equal(res.requiredLevel, 50);
    assert.equal(res.operatorLevel, 50);
    assert.equal(res.canTombstone, true);
});

test('canTombstone false when operator is below the required level', () => {
    const byType = authState({ powerLevels: { users: { [OP]: 40 }, state_default: 50 } });
    assert.equal(computeTombstoneAuth(byType, OP).canTombstone, false);
});

test('explicit events override for m.room.tombstone is respected', () => {
    const byType = authState({ powerLevels: { users: { [OP]: 90 }, state_default: 50, events: { 'm.room.tombstone': 100 } } });
    const res = computeTombstoneAuth(byType, OP);
    assert.equal(res.requiredLevel, 100);
    assert.equal(res.canTombstone, false);
});

test('v12+ old-room creator can always tombstone regardless of power levels', () => {
    const byType = authState({
        roomVersion: '12',
        creator: OP,
        powerLevels: { users: {}, state_default: 100, events: { 'm.room.tombstone': 100 } }
    });
    const res = computeTombstoneAuth(byType, OP);
    assert.equal(res.canTombstone, true);
    assert.equal(res.operatorIsOldCreator, true);
});

test('defaults: no power_levels means required 50, operator 0 -> cannot tombstone', () => {
    const byType = authState({});
    const res = computeTombstoneAuth(byType, OP);
    assert.equal(res.requiredLevel, 50);
    assert.equal(res.operatorLevel, 0);
    assert.equal(res.canTombstone, false);
});

// --- Version classification --------------------------------------------------

test('isCreatorPrivilegedVersion classifies versions', () => {
    assert.equal(isCreatorPrivilegedVersion('12'), true);
    assert.equal(isCreatorPrivilegedVersion('13'), true);
    assert.equal(isCreatorPrivilegedVersion('11'), false);
    assert.equal(isCreatorPrivilegedVersion('1'), false);
    assert.equal(isCreatorPrivilegedVersion('org.example.unstable'), false);
    assert.equal(isCreatorPrivilegedVersion('12-unstable'), false);
});
