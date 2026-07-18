/**
 * UI/Components/AutoBattle/AutoBattle.js
 * Client-side autobattle HUD component for roBrowserLegacy.
 * ragnarok-autobattle-v1
 */
import htmlText from './AutoBattle.html?raw';
import cssText  from './AutoBattle.css?raw';
import GUIComponent from 'UI/GUIComponent.js';
import UIManager  from 'UI/UIManager.js';
import Session    from 'Engine/SessionStorage.js';
import Entity     from 'Renderer/Entity/Entity.js';
import EntityManager from 'Renderer/EntityManager.js';
import MapRenderer from 'Renderer/MapRenderer.js';
import Network    from 'Network/NetworkManager.js';
import PACKET     from 'Network/PacketStructure.js';
import PACKETVER  from 'Network/PacketVerManager.js';
import DB         from 'DB/DBManager.js';
import PathFinding from 'Utils/PathFinding.js';

// ── module-level state ────────────────────────────────────────────────────────
let _active        = false;
let _targetClasses = new Set(); // empty = attack any mob
let _intervalId    = null;

const TICK_MS  = 600;
const MAX_RANGE = 14;  // cells

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns null when `name` appears to be a garbled EUC-KR/windows-949 string
 * that was decoded as windows-1252.  Heuristic: if more than 30 % of codepoints
 * are outside printable ASCII (0x20–0x7E) the string is considered garbled.
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

    // Build the attack packet
    let atkPkt;
    if (PACKETVER.value >= 20180307) {
        atkPkt = new PACKET.CZ.REQUEST_ACT2();
    } else {
        atkPkt = new PACKET.CZ.REQUEST_ACT();
    }
    atkPkt.action    = 7;
    atkPkt.targetGID = target.GID;

    // Send CHANGE_DIRECTION so the server sees the player facing the target
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

    // PathFinding range check: attack_range + 1 matches EntityControl behaviour
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

    console.log('[AutoBattle] sendAttack: out of range → walking, queuing attack');
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

    const px = player.position[0];
    const py = player.position[1];
    const rangeSq = MAX_RANGE * MAX_RANGE;
    const mobs = [];

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
        const dx = m.position[0] - px;
        const dy = m.position[1] - py;
        const d  = dx * dx + dy * dy;
        const bdx = best.position[0] - px;
        const bdy = best.position[1] - py;
        const bd  = bdx * bdx + bdy * bdy;
        return d < bd ? m : best;
    });
}

function _tick() {
    if (!_active) return;
    const player = Session.Entity;
    if (!player || !player.position) {
        console.warn('[AutoBattle] tick: no player entity or position');
        return;
    }
    const target = _findTarget();
    if (!target) return;
    console.log('[AutoBattle] tick → attack GID', target.GID, 'job', target.job,
        'pos', target.position[0], target.position[1]);
    _sendAttack(target);
}

// ── map mob list helpers ──────────────────────────────────────────────────────
function _getCurrentMapName() {
    try {
        // MapRenderer.currentMap is e.g. "prontera.gat" — strip the extension
        return (MapRenderer.currentMap || '').replace(/\.gat$/i, '');
    } catch (_) { return ''; }
}

/**
 * Returns {classId -> {classId, name, mapCount, visibleCount}} for all mobs
 * that either (a) appear in NaviMobTable for the current map, or (b) are
 * currently visible in the entity list.
 */
function _getMobListForMap() {
    const mapName = _getCurrentMapName();
    const byClass = {};

    // 1. Seed from NaviMobTable (full spawn database for this map)
    const naviMobs = DB.getNaviMobTable ? DB.getNaviMobTable() : [];
    for (let i = 0; i < naviMobs.length; i++) {
        const entry = naviMobs[i];
        // entry: ["map_name", spawn_id, mob_type, mob_class, "mob_name", "sprite_name", level, mob_info]
        if (!Array.isArray(entry) || entry.length < 5) continue;
        const entryMap = String(entry[0]).replace(/\.gat$/i, '');
        if (mapName && entryMap !== mapName) continue;
        const classId = Number(entry[3]);
        if (!classId) continue;
        if (!byClass[classId]) {
            // Always prefer English MonsterNameTable; use NaviMobTable name only
            // as a last resort — NaviMobTable names are Korean (EUC-KR) and come
            // out garbled when the charpage is windows-1252.
            const tableName = DB.getMonsterName(classId);
            const naviName  = _sanitizeName(String(entry[4] || ''));
            const name = (tableName !== 'Unknown') ? tableName
                       : naviName                  ? naviName
                       : ('Monster #' + classId);
            byClass[classId] = { classId, name, mapCount: 0, visibleCount: 0 };
        }
        byClass[classId].mapCount++;
    }

    // 2. Overlay with visible entity counts (also catches mobs not in nav table)
    const visible = _getNearbyMobs();
    visible.forEach(function (m) {
        if (!byClass[m.job]) {
            // For entities not in NaviMobTable, try MonsterNameTable then sanitized entity display name
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

// ── GUIComponent ──────────────────────────────────────────────────────────────
const AutoBattle = new GUIComponent('AutoBattle', cssText);

AutoBattle.needFocus = false;

AutoBattle.render = function render() {
    return htmlText;
};

AutoBattle.init = function init() {
    const root = this.getRoot();

    // Override host position to fixed bottom-right
    this._host.style.position = 'fixed';
    this._host.style.bottom   = '8px';
    this._host.style.right    = '8px';
    this._host.style.top      = '';
    this._host.style.left     = '';
    this._host.style.zIndex   = '9000';

    const toggle   = root.getElementById('ab-toggle');
    const panel    = root.getElementById('ab-panel');
    const closeBtn = root.getElementById('ab-close-panel');

    toggle.addEventListener('click', function (e) {
        if (e.target === toggle || e.target.classList.contains('ab-dot') || e.target.id === 'ab-label') {
            if (_active) {
                // Stop
                _toggleActive(root);
            } else if (_targetClasses.size > 0) {
                // Targets already selected — start immediately
                _toggleActive(root);
            } else {
                // No target — open the mob selection panel instead of starting
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
};

/**
 * Called externally (e.g. from MapEngine) to refresh the mob list after a map change.
 */
AutoBattle.refreshMobList = function refreshMobList() {
    const root = this.getRoot ? this.getRoot() : null;
    if (root) _refreshList(root);
};

function _toggleActive(root) {
    _active = !_active;
    const toggle = root.getElementById('ab-toggle');
    const label  = root.getElementById('ab-label');
    if (_active) {
        toggle.classList.add('ab-active');
        label.textContent = 'Auto Battle ON';
        if (!_intervalId) {
            _intervalId = setInterval(_tick, TICK_MS);
        }
    } else {
        toggle.classList.remove('ab-active');
        label.textContent = 'Auto Battle';
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
    const cur = root.getElementById('ab-current-target');
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
    const anyRow = root.getElementById('ab-any-row');
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
    const list   = root.getElementById('ab-mob-list');
    const noMobs = root.getElementById('ab-no-mobs');
    const panel  = root.getElementById('ab-panel');
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
            // Show "visible/mapSpawns" counts: e.g. "2 / 12" means 2 on screen out of 12 map spawns
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
    if (!root.getElementById('ab-start-any-btn')) {
        const startAnyBtn = document.createElement('button');
        startAnyBtn.id = 'ab-start-any-btn';
        startAnyBtn.className = 'ab-start-any-btn';
        startAnyBtn.textContent = '▶ Start (Any Monster)';
        startAnyBtn.addEventListener('click', function () {
            _toggleTarget(0, root);
            panel.classList.remove('ab-panel-open');
            if (!_active) _toggleActive(root);
        });
        // Insert after the mob-list div (before noMobs or at end of panel)
        list.parentNode.insertBefore(startAnyBtn, noMobs.nextSibling);
    }
}

function _esc(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

export default UIManager.addComponent(AutoBattle);
