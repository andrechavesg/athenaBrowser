/**
 * Plugins/AutoBattle/AutoBattle.js
 *
 * AutoBattle plugin — initialises a floating HUD panel via vanilla DOM/CSS,
 * with no dependency on GUIComponent or UIManager.
 *
 * Usage (plugin convention):
 *   import AutoBattle from 'Plugins/AutoBattle/AutoBattle.js';
 *   AutoBattle();   // called on every map load; safe to call multiple times
 *
 * This file is part of the roBrowserLegacy private fork.
 */
import Session       from 'Engine/SessionStorage.js';
import Entity        from 'Renderer/Entity/Entity.js';
import EntityManager from 'Renderer/EntityManager.js';
import MapRenderer   from 'Renderer/MapRenderer.js';
import Network       from 'Network/NetworkManager.js';
import PACKET        from 'Network/PacketStructure.js';
import PACKETVER     from 'Network/PacketVerManager.js';
import DB            from 'DB/DBManager.js';
import PathFinding   from 'Utils/PathFinding.js';
import Altitude      from 'Renderer/Map/Altitude.js';

// ── module-level state ────────────────────────────────────────────────────────
let _active        = false;
let _targetClasses = new Set(); // empty = attack any mob
let _intervalId    = null;
let _root          = null; // the injected container div

const TICK_MS        = 600;
const MAX_RANGE      = 14;  // cells
const WANDER_STEP    = 3;   // max cells per wander move
const WANDER_COOL_MS = 1500; // minimum ms between wander moves

let _lastWanderPos  = null; // [x, y] of last wander destination
let _wanderCooldown = 0;    // Date.now() timestamp after which next wander is allowed

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns null when `name` appears to be a garbled EUC-KR/windows-949 string
 * that was decoded as windows-1252 (latin1).  Such strings contain a high ratio
 * of characters in the 0x80–0xFF range that form non-sensical latin sequences.
 *
 * Heuristic: if more than 30 % of codepoints are outside printable ASCII (0x20–
 * 0x7E) the string is considered garbled and null is returned so callers can
 * fall back to the English MonsterNameTable.
 */
function _sanitizeName(name) {
    if (!name || typeof name !== 'string') return null;
    const trimmed = name.trim();
    if (!trimmed || trimmed === 'Unknown') return null;
    let nonAscii = 0;
    for (let i = 0; i < trimmed.length; i++) {
        const c = trimmed.charCodeAt(i);
        if (c < 0x20 || c > 0x7E) nonAscii++;
    }
    if (nonAscii / trimmed.length > 0.30) return null;
    return trimmed;
}

function _sendAttack(target) {
    const player = Session.Entity;
    if (!player || !player.position) return;

    let atkPkt;
    if (PACKETVER.value >= 20180307) {
        atkPkt = new PACKET.CZ.REQUEST_ACT2();
    } else {
        atkPkt = new PACKET.CZ.REQUEST_ACT();
    }
    atkPkt.action    = 7;
    atkPkt.targetGID = target.GID;

    player.lookTo(target.position[0], target.position[1]);
    let dirPkt;
    if (PACKETVER.value >= 20180307) {
        dirPkt = new PACKET.CZ.CHANGE_DIRECTION2();
    } else {
        dirPkt = new PACKET.CZ.CHANGE_DIRECTION();
    }
    dirPkt.headDir = player.headDir;
    dirPkt.dir     = player.direction;
    Network.sendPacket(dirPkt);

    const range = (player.attack_range || 1) + 1;
    const out   = [];
    const count = PathFinding.search(
        player.position[0] | 0,
        player.position[1] | 0,
        target.position[0] | 0,
        target.position[1] | 0,
        range,
        out
    );

    console.log('[AutoBattle] sendAttack: range='+range+' pathCount='+count+
        ' player=('+player.position[0]+'|0,'+player.position[1]+'|0)'+
        ' target=('+target.position[0]+','+target.position[1]+')');

    if (!count) {
        console.warn('[AutoBattle] sendAttack: PathFinding returned 0 (no path)');
        return;
    }

    if (count < 2) {
        console.log('[AutoBattle] sendAttack: in range → sending attack packet');
        Network.sendPacket(atkPkt);
        return;
    }

    console.log('[AutoBattle] sendAttack: out of range → walking to (' +
        out[(count-1)*2] + ',' + out[(count-1)*2+1] + '), queuing attack');
    Session.moveAction = atkPkt;

    let movePkt;
    if (PACKETVER.value >= 20180307) {
        movePkt = new PACKET.CZ.REQUEST_MOVE2();
    } else {
        movePkt = new PACKET.CZ.REQUEST_MOVE();
    }
    movePkt.dest[0] = out[(count - 1) * 2 + 0];
    movePkt.dest[1] = out[(count - 1) * 2 + 1];
    Network.sendPacket(movePkt);
}

function _getNearbyMobs() {
    const player = Session.Entity;
    if (!player || !player.position) return [];

    const px      = player.position[0];
    const py      = player.position[1];
    const rangeSq = MAX_RANGE * MAX_RANGE;
    const mobs    = [];

    EntityManager.forEach(function (e) {
        if (
            e.objecttype !== Entity.TYPE_MOB ||
            e.action === e.ACTION.DIE ||
            e.remove_tick !== 0
        ) return;

        const dx = e.position[0] - px;
        const dy = e.position[1] - py;
        if (dx * dx + dy * dy > rangeSq) return;

        mobs.push(e);
    });

    return mobs;
}

function _findTarget() {
    const mobs = _getNearbyMobs();
    if (!mobs.length) return null;

    // If no specific targets selected, attack any mob
    let candidates = mobs;
    if (_targetClasses.size > 0) {
        candidates = mobs.filter(m => _targetClasses.has(m.job));
        if (!candidates.length) return null;
    }

    const player = Session.Entity;
    const px = player.position[0];
    const py = player.position[1];

    return candidates.reduce((best, m) => {
        const dx  = m.position[0] - px,    dy  = m.position[1] - py;
        const bdx = best.position[0] - px, bdy = best.position[1] - py;
        return (dx * dx + dy * dy) < (bdx * bdx + bdy * bdy) ? m : best;
    });
}

/**
 * Returns true when cell (x, y) is walkable according to the loaded GAT data.
 * Uses Altitude.getCellType() & Altitude.TYPE.WALKABLE — the same check used
 * by MapRenderer and EntityManager throughout roBrowserLegacy.
 *
 * Falls back to a permissive bounds-only check when the GAT/Altitude module is
 * unavailable or returns undefined (e.g. before the map data has fully loaded).
 * The server will silently ignore a move to a non-walkable cell, so a false
 * positive here is harmless while a false negative kills wander entirely.
 */
function _isCellWalkable(x, y) {
    try {
        const cellType = Altitude.getCellType(x, y);
        if (cellType === undefined || cellType === null) {
            return x > 0 && y > 0 && x < 512 && y < 512;
        }
        return !!(cellType & Altitude.TYPE.WALKABLE);
    } catch (_) {
        return x > 0 && y > 0 && x < 512 && y < 512;
    }
}

/**
 * Move the player one random step when there is no target in range.
 * Shuffles the 8 cardinal/diagonal directions and picks the first walkable
 * cell that is not the cell we just came from.  Throttled to once per
 * WANDER_COOL_MS to avoid flooding the server with move packets.
 */
function _wander() {
    const now = Date.now();
    if (now < _wanderCooldown) return;

    const player = Session.Entity;
    if (!player || !player.position) return;

    const px = player.position[0] | 0;
    const py = player.position[1] | 0;

    // Eight possible step offsets scaled to WANDER_STEP
    const s = WANDER_STEP;
    const dirs = [
        [ 0,  s], [ 0, -s], [ s,  0], [-s,  0],
        [ s,  s], [-s,  s], [ s, -s], [-s, -s]
    ];

    // Fisher-Yates shuffle for variety
    for (let i = dirs.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = dirs[i]; dirs[i] = dirs[j]; dirs[j] = tmp;
    }

    for (const [dx, dy] of dirs) {
        const nx = px + dx;
        const ny = py + dy;

        if (!_isCellWalkable(nx, ny)) continue;

        // Avoid immediately reversing to the previous wander destination
        if (_lastWanderPos && _lastWanderPos[0] === nx && _lastWanderPos[1] === ny) continue;

        let movePkt;
        if (PACKETVER.value >= 20180307) {
            movePkt = new PACKET.CZ.REQUEST_MOVE2();
        } else {
            movePkt = new PACKET.CZ.REQUEST_MOVE();
        }
        movePkt.dest[0] = nx;
        movePkt.dest[1] = ny;
        Network.sendPacket(movePkt);

        _lastWanderPos  = [nx, ny];
        _wanderCooldown = now + WANDER_COOL_MS;

        console.log('[AutoBattle] wander → (' + nx + ',' + ny + ')');
        break;
    }
}

function _tick() {
    if (!_active) return;
    const player = Session.Entity;
    if (!player || !player.position) {
        console.warn('[AutoBattle] tick: no player entity or position');
        return;
    }
    const target = _findTarget();
    if (!target) {
        _wander(); // No mob in range — roam until one appears
        return;
    }
    // Reset wander state so we don't skip the first walkable cell next time
    _lastWanderPos = null;
    console.log('[AutoBattle] tick → attack GID', target.GID, 'job', target.job,
        'pos', target.position[0], target.position[1]);
    _sendAttack(target);
}

// ── map mob list helpers ──────────────────────────────────────────────────────
function _getCurrentMapName() {
    try {
        return (MapRenderer.currentMap || '').replace(/\.gat$/i, '');
    } catch (_) { return ''; }
}

function _getMobListForMap() {
    const mapName = _getCurrentMapName();
    const byClass = {};

    const naviMobs = DB.getNaviMobTable ? DB.getNaviMobTable() : [];
    for (let i = 0; i < naviMobs.length; i++) {
        const entry = naviMobs[i];
        if (!Array.isArray(entry) || entry.length < 6) continue;
        const entryMap = String(entry[0]).replace(/\.gat$/i, '');
        if (mapName && entryMap !== mapName) continue;
        // Navi_Mob entry layout (Hercules naviluagenerator format):
        //   [0] map_name  [1] global_spawn_id  [2] mob_type(300/301)
        //   [3] (amount<<16 | class) — packed field, NOT the plain class ID
        //   [4] mob_class  [5] mob_name  [6] sprite  [7] level  [8] race/ele/size
        const classId = Number(entry[4]);
        if (!classId || classId < 1000 || classId > 10000) continue;
        if (!byClass[classId]) {
            // Always prefer English MonsterNameTable; use NaviMobTable name only
            // as a last resort — NaviMobTable names are Korean (EUC-KR) and come
            // out garbled when the charpage is windows-1252.
            const tableName = DB.getMonsterName(classId);
            const naviName  = _sanitizeName(String(entry[5] || ''));
            const name = (tableName !== 'Unknown') ? tableName
                       : naviName                  ? naviName
                       : ('Monster #' + classId);
            byClass[classId] = { classId, name, mapCount: 0, visibleCount: 0 };
        }
        byClass[classId].mapCount++;
    }

    const visible = _getNearbyMobs();
    visible.forEach(function (m) {
        if (!byClass[m.job]) {
            const tableName = DB.getMonsterName(m.job);
            const dispName  = (m.display && m.display.name) ? _sanitizeName(String(m.display.name)) : null;
            const name = (tableName !== 'Unknown') ? tableName
                       : dispName                  ? dispName
                       : ('Monster #' + m.job);
            byClass[m.job] = { classId: m.job, name, mapCount: 0, visibleCount: 0 };
        }
        byClass[m.job].visibleCount++;
    });

    return Object.values(byClass);
}

// ── vanilla DOM panel ─────────────────────────────────────────────────────────
const CSS = `
#ab-host {
    position: fixed;
    bottom: 8px;
    right: 8px;
    z-index: 9000;
    font-family: Tahoma, Arial, sans-serif;
    font-size: 12px;
    pointer-events: none;
}
#ab-host * { box-sizing: border-box; }

#ab-toggle {
    pointer-events: all;
    width: 40px;
    height: 40px;
    border-radius: 8px;
    border: 2px solid #3a5a8a;
    background: rgba(15, 25, 50, 0.85);
    color: #90b8e0;
    font-size: 20px;
    cursor: pointer;
    user-select: none;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    box-shadow: 0 2px 8px rgba(0,0,0,0.5);
    transition: all 0.15s;
}
#ab-toggle:hover {
    border-color: #6090c0;
    background: rgba(20, 40, 80, 0.9);
    filter: brightness(1.15);
}
#ab-toggle.ab-active {
    border-color: #e06020;
    color: #ff8040;
    box-shadow: 0 0 8px rgba(255, 100, 0, 0.6);
}

#ab-panel {
    pointer-events: all;
    position: absolute;
    bottom: 48px;
    right: 0;
    width: 260px;
    border-radius: 8px;
    border: 1px solid #4a6a9a;
    background: rgba(8,18,40,0.97);
    box-shadow: 0 4px 20px rgba(0,0,0,0.7);
    padding: 8px;
    display: none;
}
#ab-panel.ab-panel-open { display: block; }

#ab-panel-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    color: #88aadd;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.6px;
    margin-bottom: 6px;
    padding-bottom: 5px;
    border-bottom: 1px solid rgba(74,106,154,0.4);
    text-transform: uppercase;
}
#ab-close-panel { cursor: pointer; color: #7090c0; font-size: 14px; line-height: 1; }
#ab-close-panel:hover { color: #b0c8f0; }

#ab-target-label {
    color: #7090c0; font-size: 10px; font-weight: 700;
    letter-spacing: 0.5px; text-transform: uppercase; margin-bottom: 4px;
}
#ab-current-target {
    color: #c0d8ff; font-size: 11px; font-weight: 600;
    margin-bottom: 8px; padding: 4px 6px;
    border-radius: 4px; background: rgba(40,70,130,0.35);
}

#ab-mob-list { max-height: 180px; overflow-y: auto; margin-bottom: 8px; }
#ab-mob-list::-webkit-scrollbar { width: 4px; }
#ab-mob-list::-webkit-scrollbar-track { background: rgba(0,0,0,0.3); border-radius: 2px; }
#ab-mob-list::-webkit-scrollbar-thumb { background: #3a5a8a; border-radius: 2px; }

.ab-mob-row {
    display: flex; align-items: center; gap: 6px;
    padding: 4px 5px; border-radius: 4px; margin-bottom: 2px;
    background: rgba(20,45,90,0.35); border: 1px solid transparent;
    transition: background 0.1s, border-color 0.1s;
}
.ab-mob-row:hover { background: rgba(40,70,140,0.5); border-color: #4a6a9a; }
.ab-mob-row.ab-row-selected { background: rgba(80,40,10,0.5); border-color: #e07030; }

.ab-mob-id  { color: #6080b0; font-size: 9px; font-weight: 600; min-width: 30px; text-align: center; }
.ab-mob-name { color: #c0d8ff; font-size: 11px; font-weight: 600; flex: 1; }
.ab-mob-count { color: #7090c0; font-size: 10px; min-width: 20px; text-align: right; }
.ab-mob-select {
    cursor: pointer; padding: 2px 6px; border-radius: 3px;
    border: 1px solid #3a5a8a; background: rgba(30,60,120,0.6);
    color: #88aadd; font-size: 10px; font-weight: 700;
}
.ab-mob-select:hover { background: rgba(60,100,180,0.7); border-color: #6a9acb; color: #c0d8ff; }
.ab-mob-row.ab-row-selected .ab-mob-select {
    background: rgba(100,40,5,0.7); border-color: #c05020; color: #ffbb66;
}
#ab-any-row { margin-bottom: 6px; }
#ab-no-mobs { color: #5070a0; font-size: 10px; text-align: center; padding: 8px 0; display: none; }

.ab-start-any-btn {
    width: 100%; padding: 5px 0; border-radius: 4px;
    border: 1px solid #5a8a3a; background: rgba(20,60,20,0.7);
    color: #88dd88; font-size: 11px; font-weight: 700;
    letter-spacing: 0.4px; cursor: pointer; margin-bottom: 4px;
}
.ab-start-any-btn:hover { background: rgba(40,100,40,0.8); color: #aaffaa; border-color: #7ab85a; }
`;

function _buildDOM() {
    if (!document.getElementById('ab-style')) {
        const style = document.createElement('style');
        style.id = 'ab-style';
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    const host = document.createElement('div');
    host.id = 'ab-host';
    host.innerHTML = `
        <div id="ab-panel">
            <div id="ab-panel-header">
                <span>Auto Battle</span>
                <span id="ab-close-panel" title="Close">✕</span>
            </div>
            <div id="ab-target-label">Target</div>
            <div id="ab-current-target">Any Monster</div>
            <div id="ab-mob-list">
                <div class="ab-mob-row ab-row-selected" id="ab-any-row" data-class="0">
                    <div class="ab-mob-id">—</div>
                    <div class="ab-mob-name">Any Monster</div>
                    <div class="ab-mob-count"></div>
                    <div class="ab-mob-select" data-class="0">✓ Select</div>
                </div>
            </div>
            <div id="ab-no-mobs">No monsters nearby</div>
        </div>
        <div id="ab-toggle" title="Auto Battle (⚔)">⚔</div>
    `;
    document.body.appendChild(host);
    return host;
}

// ── UI event wiring ───────────────────────────────────────────────────────────
function _wireEvents(root) {
    const toggle   = root.querySelector('#ab-toggle');
    const panel    = root.querySelector('#ab-panel');
    const closeBtn = root.querySelector('#ab-close-panel');

    toggle.addEventListener('click', function (e) {
        if (e.target === toggle) {
            if (_active) {
                _toggleActive(root);
            } else if (_targetClasses.size > 0) {
                // Targets already selected — start immediately
                _toggleActive(root);
            } else {
                // No target — open the mob selection panel
                panel.classList.add('ab-panel-open');
                _refreshList(root);
            }
        }
    });

    toggle.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        panel.classList.toggle('ab-panel-open');
        if (panel.classList.contains('ab-panel-open')) {
            _refreshList(root);
        }
    });

    closeBtn.addEventListener('click', function () {
        panel.classList.remove('ab-panel-open');
    });
}

function _toggleActive(root) {
    _active = !_active;
    const toggle = root.querySelector('#ab-toggle');
    if (_active) {
        toggle.classList.add('ab-active');
        if (!_intervalId) {
            _intervalId = setInterval(_tick, TICK_MS);
        }
    } else {
        toggle.classList.remove('ab-active');
        if (_intervalId) {
            clearInterval(_intervalId);
            _intervalId = null;
        }
    }
}

/** Toggle a classId in/out of _targetClasses and update the target display. */
function _toggleTarget(classId, root) {
    if (classId === 0) {
        // "Any Monster" — clear all specific selections
        _targetClasses.clear();
    } else {
        if (_targetClasses.has(classId)) {
            _targetClasses.delete(classId);
        } else {
            _targetClasses.add(classId);
        }
    }
    _updateTargetDisplay(root);
    _refreshSelectedRow(root);
}

function _updateTargetDisplay(root) {
    const cur = root.querySelector('#ab-current-target');
    if (!cur) return;
    if (_targetClasses.size === 0) {
        cur.textContent = 'Any Monster';
    } else {
        const names = Array.from(_targetClasses).map(function (id) {
            const n = DB.getMonsterName(id);
            return (n && n !== 'Unknown') ? n : ('Monster #' + id);
        });
        cur.textContent = names.join(', ');
    }
}

function _refreshSelectedRow(root) {
    // "Any Monster" row: selected only when no specific targets chosen
    const anyRow = root.querySelector('#ab-any-row');
    if (anyRow) {
        const anyBtn = anyRow.querySelector('.ab-mob-select');
        if (_targetClasses.size === 0) {
            anyRow.classList.add('ab-row-selected');
            if (anyBtn) anyBtn.textContent = '✓ Select';
        } else {
            anyRow.classList.remove('ab-row-selected');
            if (anyBtn) anyBtn.textContent = 'Select';
        }
    }

    root.querySelectorAll('.ab-mob-row:not(#ab-any-row)').forEach(function (row) {
        const cls = parseInt(row.dataset.class || '0', 10);
        const btn = row.querySelector('.ab-mob-select');
        if (_targetClasses.has(cls)) {
            row.classList.add('ab-row-selected');
            if (btn) btn.textContent = '✓ Select';
        } else {
            row.classList.remove('ab-row-selected');
            if (btn) btn.textContent = 'Select';
        }
    });
}

function _refreshList(root) {
    const list   = root.querySelector('#ab-mob-list');
    const noMobs = root.querySelector('#ab-no-mobs');
    if (!list) return;

    const classes = _getMobListForMap();

    Array.from(list.children).forEach(function (child) {
        if (child.id !== 'ab-any-row') child.remove();
    });

    if (classes.length === 0) {
        noMobs.style.display = 'block';
    } else {
        noMobs.style.display = 'none';
        classes.sort(function (a, b) { return a.name.localeCompare(b.name); });
        classes.forEach(function (info) {
            const row = document.createElement('div');
            row.className = 'ab-mob-row';
            row.dataset.class = String(info.classId);
            const vis = Math.max(0, info.visibleCount);
            const tot = Math.max(0, info.mapCount);
            const countLabel = tot > 0
                ? (vis + ' / ' + tot)
                : (vis > 0 ? '~' + vis : '?');
            row.innerHTML =
                '<div class="ab-mob-id">#' + info.classId + '</div>' +
                '<div class="ab-mob-name">' + _esc(info.name) + '</div>' +
                '<div class="ab-mob-count">' + countLabel + '</div>' +
                '<div class="ab-mob-select" data-class="' + info.classId + '">Select</div>';
            list.appendChild(row);
        });
    }

    list.querySelectorAll('.ab-mob-select').forEach(function (btn) {
        btn.addEventListener('click', function () {
            const cls = parseInt(btn.dataset.class || '0', 10);
            _toggleTarget(cls, root);
        });
    });

    // "Any Monster" row toggle
    const anyBtn = root.querySelector('#ab-any-row .ab-mob-select');
    if (anyBtn) {
        anyBtn.onclick = function () { _toggleTarget(0, root); };
    }

    _refreshSelectedRow(root);

    // "Start (Any Monster)" shortcut button — create once
    if (!root.querySelector('#ab-start-any-btn')) {
        const startAnyBtn = document.createElement('button');
        startAnyBtn.id = 'ab-start-any-btn';
        startAnyBtn.className = 'ab-start-any-btn';
        startAnyBtn.textContent = '▶ Start (Any Monster)';
        startAnyBtn.addEventListener('click', function () {
            _toggleTarget(0, root);
            root.querySelector('#ab-panel').classList.remove('ab-panel-open');
            if (!_active) _toggleActive(root);
        });
        // Insert after the mob-list div
        list.parentNode.insertBefore(startAnyBtn, noMobs.nextSibling);
    }
}

function _esc(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// ── plugin entry point ────────────────────────────────────────────────────────

/**
 * Refresh the mob list from the outside (e.g. called by MapEngine on map load).
 * Safe to call even before Init().
 */
export function refreshMobList() {
    if (_root) _refreshList(_root);
}

export default function Init() {
    if (_root) {
        // Already initialised — just refresh the mob list for the new map
        _refreshList(_root);
        return;
    }
    _root = _buildDOM();
    _wireEvents(_root);
    // Auto-populate mob list on first load
    _refreshList(_root);
}
