// Matrix homeserver API helpers for the manual room-upgrade utility. Kept free
// of DOM/session state so the upgrade logic can be reasoned about in isolation.
//
// A room's encryption setting is immutable once enabled (MSC4245), and the
// built-in upgrade endpoint (POST .../rooms/{id}/upgrade) gives no control over
// the new room. Landing in an upgraded room that is also (un)encrypted requires
// reproducing the upgrade by hand: create a fresh room with the desired
// version/encryption, copy the relevant state and power structure, tombstone
// the old room, and invite the members.

export const DEFAULT_HS_SCHEME = 'https://';

// Algorithm used when enabling encryption on a room that had none.
export const DEFAULT_ENCRYPTION_ALGORITHM = 'm.megolm.v1.aes-sha2';

export const DEFAULT_TOMBSTONE_MESSAGE = 'This room has been upgraded.';

export const DEFAULT_TIMEOUT_MS = 30000;

// fetch() with an abort-based timeout so a hung homeserver can't stall the UI.
export async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } catch (e) {
        if (e.name === 'AbortError') {
            throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s. The homeserver may be slow or unreachable.`);
        }
        throw e;
    } finally {
        clearTimeout(timer);
    }
}

// State event types we copy verbatim from the old room into the new room's
// initial_state. This mirrors the fixed set a normal server-side upgrade copies
// (Synapse: power_levels, name, topic, join_rules, guest_access,
// history_visibility, avatar, canonical_alias, server_acl, encryption, type).
// name/topic are passed as top-level createRoom params instead; power_levels via
// power_level_content_override; canonical_alias via the directory step;
// encryption is conditional on the encryption-mode selection (keep/on/off).
export const CARRY_STATE_TYPES = [
    'm.room.avatar',
    'm.room.join_rules',
    'm.room.history_visibility',
    'm.room.guest_access',
    'm.room.server_acl'
];

// State events that are never copied generically: either server-generated,
// handled specially, or meaningless in the new room.
export const SKIP_STATE_TYPES = new Set([
    'm.room.create',
    'm.room.member',
    'm.room.power_levels',
    'm.room.canonical_alias',
    'm.room.tombstone',
    'm.room.name',
    'm.room.topic',
    'm.room.encryption'
]);

// Resolve a domain or URL to an https homeserver base URL via .well-known.
// Plaintext http is rejected so credentials/tokens never leave over the wire
// unencrypted, and a .well-known base_url is only trusted if it is https.
export async function resolveHomeserver(domain) {
    domain = (domain || '').trim().replace(/\/+$/, "");
    if (!domain) {
        throw new Error('Please enter a homeserver URL or domain.');
    }

    if (/^http:\/\//i.test(domain)) {
        throw new Error('Insecure http:// homeservers are not allowed. Use https://.');
    }

    let baseUrl = domain;
    if (!/^https:\/\//i.test(baseUrl)) {
        baseUrl = `${DEFAULT_HS_SCHEME}${domain}`;
    }

    let parsedBase;
    try {
        parsedBase = new URL(baseUrl);
    } catch {
        throw new Error('Invalid homeserver URL or domain.');
    }

    try {
        const res = await fetchWithTimeout(`${parsedBase.origin}/.well-known/matrix/client`);
        if (res.ok) {
            const data = await res.json();
            const discovered = data["m.homeserver"] && data["m.homeserver"].base_url;
            if (discovered) {
                const parsed = new URL(discovered);
                if (parsed.protocol === 'https:') {
                    return parsed.origin + parsed.pathname.replace(/\/+$/, "");
                }
                // Discovery pointed somewhere insecure; ignore it.
            }
        }
    } catch (e) {
        // No/invalid .well-known: fall back to the entered https base URL.
        console.warn('.well-known discovery failed; using entered base URL', e);
    }

    return parsedBase.origin;
}

export function randomState() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

// Discover the room versions this homeserver supports. The right endpoint is
// /capabilities (m.room_versions); /_matrix/client/versions returns *spec*
// versions, not room versions, and must not be used here.
export async function fetchRoomVersionCapabilities(hs, authedFetch) {
    const res = await authedFetch(`${hs}/_matrix/client/v3/capabilities`);
    if (!res.ok) throw new Error(`Could not read server capabilities (HTTP ${res.status}).`);
    const data = await res.json();
    const caps = (data.capabilities && data.capabilities['m.room_versions']) || {};
    const available = caps.available || {};
    const versions = Object.keys(available);
    if (versions.length === 0) {
        // Fall back to a reasonable spread if the server doesn't advertise.
        return { default: caps.default || '11', available: { '12': 'stable', '11': 'stable', '10': 'stable', '9': 'stable', '6': 'stable', '5': 'stable' } };
    }
    return { default: caps.default || versions[0], available };
}

// True when the target room version uses the v12+ "creators have infinite,
// unrepresentable power level" model (MSC4289). Non-numeric / unstable version
// strings are treated as pre-v12 for the purposes of creator handling.
export function isCreatorPrivilegedVersion(version) {
    const n = parseInt(version, 10);
    return Number.isInteger(n) && String(n) === String(version).trim() && n >= 12;
}

// Full current state of a room as an array of state events.
export async function fetchRoomState(roomId, hs, authedFetch) {
    const res = await authedFetch(`${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state`);
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Could not read room state (HTTP ${res.status}). Are you joined to this room?`);
    }
    return res.json();
}

// Best-effort: the event ID of the most recent event in the room, used for the
// new room's m.room.create predecessor link. Returns null if unavailable.
async function fetchLatestEventId(roomId, hs, authedFetch) {
    try {
        const res = await authedFetch(`${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=1`);
        if (!res.ok) return null;
        const data = await res.json();
        const chunk = data.chunk || [];
        return chunk[0] && chunk[0].event_id ? chunk[0].event_id : null;
    } catch {
        return null;
    }
}

// The room's listing visibility in the public directory ("public"/"private").
async function fetchDirectoryVisibility(roomId, hs, authedFetch) {
    try {
        const res = await authedFetch(`${hs}/_matrix/client/v3/directory/list/room/${encodeURIComponent(roomId)}`);
        if (!res.ok) return 'private';
        const data = await res.json();
        return data.visibility === 'public' ? 'public' : 'private';
    } catch {
        return 'private';
    }
}

// Index a state-event array by type for events with an empty state_key.
function indexState(stateEvents) {
    const byType = {};
    const members = []; // {userId, membership}
    for (const ev of stateEvents) {
        if (ev.type === 'm.room.member') {
            members.push({ userId: ev.state_key, membership: (ev.content && ev.content.membership) });
            continue;
        }
        if (ev.state_key === '') byType[ev.type] = ev;
    }
    return { byType, members };
}

// The operator is always the creator of the new room. On v12+ the other
// original creators are preserved via additional_creators so they keep their
// (now permanent, infinite) power.
function resolveCreators(byType, operatorUserId, v12plus) {
    const createEv = byType['m.room.create'];
    const oldCreate = (createEv && createEv.content) || {};
    const oldCreators = new Set();
    if (createEv && createEv.sender) oldCreators.add(createEv.sender);
    if (Array.isArray(oldCreate.additional_creators)) {
        for (const c of oldCreate.additional_creators) oldCreators.add(c);
    }
    const additionalCreators = [...oldCreators].filter(u => u && u !== operatorUserId);
    const newRoomCreators = new Set([operatorUserId, ...(v12plus ? additionalCreators : [])]);
    return { oldCreate, additionalCreators, newRoomCreators };
}

function buildCreationContent(oldCreate, oldRoomId, predecessorEventId, v12plus, additionalCreators) {
    const creationContent = {};
    if (oldCreate.type) creationContent.type = oldCreate.type; // preserve room type (e.g. space)
    if (oldCreate['m.federate'] === false) creationContent['m.federate'] = false;
    creationContent.predecessor = predecessorEventId
        ? { room_id: oldRoomId, event_id: predecessorEventId }
        : { room_id: oldRoomId };
    if (v12plus && additionalCreators.length > 0) {
        creationContent.additional_creators = additionalCreators;
    }
    return creationContent;
}

// Can the operator tombstone the old room? Required power is
// events['m.room.tombstone'] ?? state_default ?? 50; the operator's is
// users[op] ?? users_default ?? 0. A creator in a v12+ room always can.
export function computeTombstoneAuth(byType, operatorUserId) {
    const createEv = byType['m.room.create'];
    const oldVersion = (createEv && createEv.content && createEv.content.room_version) || '1';
    const oldIsV12plus = isCreatorPrivilegedVersion(oldVersion);

    const oldCreators = new Set();
    if (createEv && createEv.sender) oldCreators.add(createEv.sender);
    const additional = createEv && createEv.content && createEv.content.additional_creators;
    if (Array.isArray(additional)) for (const c of additional) oldCreators.add(c);
    const operatorIsOldCreator = oldCreators.has(operatorUserId);

    if (oldIsV12plus && operatorIsOldCreator) {
        return { operatorLevel: Infinity, requiredLevel: 0, canTombstone: true, operatorIsOldCreator };
    }

    const pl = (byType['m.room.power_levels'] && byType['m.room.power_levels'].content) || {};
    const stateDefault = Number.isFinite(Number(pl.state_default)) ? Number(pl.state_default) : 50;
    const tombEvents = pl.events || {};
    const requiredLevel = Number.isFinite(Number(tombEvents['m.room.tombstone']))
        ? Number(tombEvents['m.room.tombstone'])
        : stateDefault;

    const users = pl.users || {};
    const usersDefault = Number.isFinite(Number(pl.users_default)) ? Number(pl.users_default) : 0;
    const operatorLevel = Number.isFinite(Number(users[operatorUserId]))
        ? Number(users[operatorUserId])
        : usersDefault;

    return { operatorLevel, requiredLevel, canTombstone: operatorLevel >= requiredLevel, operatorIsOldCreator };
}

function buildPowerLevelOverride(byType, operatorUserId, newRoomCreators, v12plus) {
    const oldPl = byType['m.room.power_levels'];
    if (!oldPl || !oldPl.content) return null;
    const pl = JSON.parse(JSON.stringify(oldPl.content));
    const users = { ...pl.users };
    if (v12plus) {
        // Creators must NOT appear in the users map: v12 auth rules reject it.
        for (const c of newRoomCreators) delete users[c];
    } else {
        // Pre-v12 creators have no inherent power; make sure the operator
        // keeps control of the new room they are creating.
        users[operatorUserId] = Math.max(Number(users[operatorUserId] || 0), 100);
    }
    pl.users = users;
    return pl;
}

// encryptionMode: 'keep' preserves the old setting, 'on' forces encryption
// (reusing old content when present), 'off' forces unencrypted.
function buildInitialState(stateEvents, byType, encryptionMode) {
    const initialState = [];
    for (const ev of stateEvents) {
        if (ev.type === 'm.room.encryption') continue; // handled below
        if (SKIP_STATE_TYPES.has(ev.type)) continue;
        if (!CARRY_STATE_TYPES.includes(ev.type)) continue;
        initialState.push({ type: ev.type, state_key: ev.state_key || '', content: ev.content || {} });
    }
    const oldEncryption = byType['m.room.encryption'];
    const wantEncrypted = encryptionMode === 'on' || (encryptionMode === 'keep' && oldEncryption);
    if (wantEncrypted) {
        const content = (oldEncryption && oldEncryption.content)
            ? oldEncryption.content
            : { algorithm: DEFAULT_ENCRYPTION_ALGORITHM };
        initialState.push({ type: 'm.room.encryption', state_key: '', content });
    }
    return initialState;
}

// inviteMode: 'all' (joined or already invited), 'joined' (joined only), 'none'.
function resolveInvites(members, operatorUserId, newRoomCreators, inviteMode) {
    if (inviteMode === 'none') return [];
    const allowed = inviteMode === 'joined'
        ? m => m.membership === 'join'
        : m => m.membership === 'join' || m.membership === 'invite';
    return members
        .filter(allowed)
        .map(m => m.userId)
        .filter(u => u && u !== operatorUserId && !newRoomCreators.has(u));
}

// Construct the createRoom request body for the replacement room. Pure: takes
// the gathered inputs and returns { body, plan } where plan summarises the
// decisions made (for display/confirmation).
export function buildCreateRoomBody(opts) {
    const {
        stateEvents,
        operatorUserId,
        oldRoomId,
        targetVersion,
        encryptionMode,
        inviteMode,
        predecessorEventId,
        directoryVisibility
    } = opts;

    const { byType, members } = indexState(stateEvents);
    const v12plus = isCreatorPrivilegedVersion(targetVersion);

    const { oldCreate, additionalCreators, newRoomCreators } = resolveCreators(byType, operatorUserId, v12plus);
    const creationContent = buildCreationContent(oldCreate, oldRoomId, predecessorEventId, v12plus, additionalCreators);
    const powerLevelOverride = buildPowerLevelOverride(byType, operatorUserId, newRoomCreators, v12plus);
    const initialState = buildInitialState(stateEvents, byType, encryptionMode);
    const invite = resolveInvites(members, operatorUserId, newRoomCreators, inviteMode);
    const oldEncryption = byType['m.room.encryption'];

    const nameEv = byType['m.room.name'];
    const topicEv = byType['m.room.topic'];
    const joinRulesEv = byType['m.room.join_rules'];
    const joinRule = (joinRulesEv && joinRulesEv.content && joinRulesEv.content.join_rule) || 'invite';
    const preset = joinRule === 'public' ? 'public_chat' : 'private_chat';

    const body = {
        room_version: targetVersion,
        creation_content: creationContent,
        preset,
        visibility: directoryVisibility === 'public' ? 'public' : 'private',
        initial_state: initialState
    };
    if (nameEv && nameEv.content && nameEv.content.name) body.name = nameEv.content.name;
    if (topicEv && topicEv.content && topicEv.content.topic) body.topic = topicEv.content.topic;
    if (powerLevelOverride) body.power_level_content_override = powerLevelOverride;
    // Invites are sent individually after creation (see performUpgrade), not via
    // createRoom's bulk invite, so one bad MXID can't fail room creation.

    const willBeEncrypted = initialState.some(s => s.type === 'm.room.encryption');
    const tombstoneAuth = computeTombstoneAuth(byType, operatorUserId);

    const plan = {
        targetVersion,
        v12plus,
        encryptionMode,
        wasEncrypted: Boolean(oldEncryption),
        willBeEncrypted,
        inviteMode,
        roomType: oldCreate.type || null,
        inviteCount: invite.length,
        carriedStateTypes: initialState.map(s => s.type),
        additionalCreators: v12plus ? additionalCreators : [],
        preservesPowerLevels: Boolean(powerLevelOverride),
        canTombstone: tombstoneAuth.canTombstone,
        requiredTombstoneLevel: tombstoneAuth.requiredLevel,
        operatorPowerLevel: tombstoneAuth.operatorLevel,
        name: body.name || null
    };

    return { body, plan, byType, invite };
}

// Gather everything needed to plan an upgrade, then build the createRoom body.
// Does not mutate anything; safe to call to preview the plan.
export async function planUpgrade(opts) {
    const { oldRoomId, hs, authedFetch, operatorUserId, targetVersion, encryptionMode, inviteMode } = opts;
    const stateEvents = await fetchRoomState(oldRoomId, hs, authedFetch);
    const [predecessorEventId, directoryVisibility] = await Promise.all([
        fetchLatestEventId(oldRoomId, hs, authedFetch),
        fetchDirectoryVisibility(oldRoomId, hs, authedFetch)
    ]);
    return buildCreateRoomBody({
        stateEvents,
        operatorUserId,
        oldRoomId,
        targetVersion,
        encryptionMode,
        inviteMode,
        predecessorEventId,
        directoryVisibility
    });
}

// Create the replacement room and return its ID. Fatal on failure.
async function createReplacementRoom(hs, authedFetch, createBody, log) {
    log('info', 'Creating the replacement room...');
    const createRes = await authedFetch(`${hs}/_matrix/client/v3/createRoom`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createBody)
    });
    const createData = await createRes.json().catch(() => ({}));
    if (!createRes.ok) {
        throw new Error(createData.error || `Failed to create the new room (HTTP ${createRes.status}).`);
    }
    log('ok', `New room created: ${createData.room_id}`);
    return createData.room_id;
}

// Invite members one at a time so one un-invitable user can't abort the rest.
// Best-effort: the core upgrade has already succeeded.
async function inviteMembers(newRoomId, hs, authedFetch, invite, log) {
    if (!invite || invite.length === 0) return;
    log('info', `Inviting ${invite.length} member(s)...`);
    let ok = 0;
    const failures = [];
    for (const userId of invite) {
        try {
            const res = await authedFetch(`${hs}/_matrix/client/v3/rooms/${encodeURIComponent(newRoomId)}/invite`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_id: userId })
            });
            if (res.ok) {
                ok++;
            } else {
                const body = await res.json().catch(() => ({}));
                failures.push(userId);
                log('warn', `Could not invite ${userId} (HTTP ${res.status}: ${body.error || 'unknown'}).`);
            }
        } catch (e) {
            if (e.message === 'Session expired') throw e;
            failures.push(userId);
            log('warn', `Could not invite ${userId}: ${e.message}`);
        }
    }
    if (failures.length === 0) {
        log('ok', `Invited all ${ok} member(s).`);
    } else {
        log('warn', `Invited ${ok}/${invite.length} member(s); ${failures.length} failed.`);
    }
}

// Move canonical/alt aliases from the old room to the new one (best-effort).
// canonical_alias is a state event, so this still works after tombstoning.
async function moveAliases(oldRoomId, newRoomId, hs, authedFetch, byType, log) {
    const canonical = byType['m.room.canonical_alias'];
    const aliases = [];
    if (canonical && canonical.content) {
        if (canonical.content.alias) aliases.push(canonical.content.alias);
        if (Array.isArray(canonical.content.alt_aliases)) aliases.push(...canonical.content.alt_aliases);
    }
    const movedAliases = [];
    for (const alias of aliases) {
        try {
            const del = await authedFetch(`${hs}/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`, { method: 'DELETE' });
            if (!del.ok && del.status !== 404) {
                log('warn', `Could not release alias ${alias} from the old room (HTTP ${del.status}).`);
                continue;
            }
            const put = await authedFetch(`${hs}/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ room_id: newRoomId })
            });
            if (put.ok) {
                movedAliases.push(alias);
            } else {
                log('warn', `Could not point alias ${alias} at the new room (HTTP ${put.status}).`);
            }
        } catch (e) {
            log('warn', `Error moving alias ${alias}: ${e.message}`);
        }
    }
    if (movedAliases.length > 0) {
        // Clear the canonical alias on the old room, set it on the new one.
        await authedFetch(`${hs}/_matrix/client/v3/rooms/${encodeURIComponent(oldRoomId)}/state/m.room.canonical_alias/`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
        }).catch(() => {});
        await authedFetch(`${hs}/_matrix/client/v3/rooms/${encodeURIComponent(newRoomId)}/state/m.room.canonical_alias/`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alias: movedAliases[0], alt_aliases: movedAliases.slice(1) })
        }).catch(() => {});
        log('ok', `Moved ${movedAliases.length} alias(es) to the new room.`);
    }
}

// Raise the old room's power levels so no further messages land there, mirroring
// what a normal upgrade does. Best-effort.
async function freezeOldRoom(oldRoomId, hs, authedFetch, byType, log) {
    try {
        const oldPl = byType['m.room.power_levels'];
        const frozen = oldPl && oldPl.content ? JSON.parse(JSON.stringify(oldPl.content)) : {};
        frozen.events_default = Math.max(Number(frozen.events_default || 0), 100);
        frozen.invite = Math.max(Number(frozen.invite || 0), 100);
        const freezeRes = await authedFetch(`${hs}/_matrix/client/v3/rooms/${encodeURIComponent(oldRoomId)}/state/m.room.power_levels/`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(frozen)
        });
        if (freezeRes.ok) {
            log('ok', 'Froze the old room (no further messages).');
        } else {
            log('warn', `Could not freeze the old room (HTTP ${freezeRes.status}). It is still tombstoned.`);
        }
    } catch (e) {
        log('warn', `Could not freeze the old room: ${e.message}`);
    }
}

// Execute the upgrade. `log(level, message)` is called for each step so the UI
// can stream progress. Returns the new room ID. Throws only on fatal errors
// (room creation / tombstone failure); alias/freeze problems are logged as
// warnings since the core upgrade has already succeeded.
export async function performUpgrade(opts) {
    const { oldRoomId, hs, authedFetch, createBody, byType, log, tombstoneMessage, invite } = opts;

    const newRoomId = await createReplacementRoom(hs, authedFetch, createBody, log);
    await inviteMembers(newRoomId, hs, authedFetch, invite, log);
    await moveAliases(oldRoomId, newRoomId, hs, authedFetch, byType, log);

    // Tombstone the old room (the link members' clients render). This requires
    // upgrade rights; if it fails the upgrade is only half done, so it is fatal.
    log('info', 'Tombstoning the old room...');
    const tombBody = (tombstoneMessage && tombstoneMessage.trim()) || DEFAULT_TOMBSTONE_MESSAGE;
    const tombRes = await authedFetch(`${hs}/_matrix/client/v3/rooms/${encodeURIComponent(oldRoomId)}/state/m.room.tombstone/`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: tombBody, replacement_room: newRoomId })
    });
    if (!tombRes.ok) {
        const tErr = await tombRes.json().catch(() => ({}));
        const err = new Error(
            `New room ${newRoomId} was created, but tombstoning the old room failed ` +
            `(HTTP ${tombRes.status}: ${tErr.error || 'unknown'}). You likely lack the power level ` +
            `to upgrade this room. The new room exists but the old room was not linked to it.`
        );
        // Surface the orphaned room so the UI can offer a recovery link.
        err.newRoomId = newRoomId;
        throw err;
    }
    log('ok', 'Old room tombstoned and linked to the new room.');

    await freezeOldRoom(oldRoomId, hs, authedFetch, byType, log);
    return newRoomId;
}
