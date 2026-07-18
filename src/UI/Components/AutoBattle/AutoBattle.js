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

// ── module-level state ────────────────────────────────────────────────────────
let _active      = false;
let _targetClass = 0;   // 0 = any mob
let _intervalId  = null;

const TICK_MS  = 600;
const MAX_RANGE = 14;  // cells

// ── helpers ───────────────────────────────────────────────────────────────────
function _sendAttack(targetGID) {
    let pkt;
    if (PACKETVER.value >= 20180307) {
        pkt = new PACKET.CZ.REQUEST_ACT2();
    } else {
        pkt = new PACKET.CZ.REQUEST_ACT();
    }
    pkt.action    = 7;
    pkt.targetGID = targetGID;
    Network.sendPacket(pkt);
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

    let candidates = mobs;
    if (_targetClass > 0) {
        candidates = mobs.filter(m => m.job === _targetClass);
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
    const target = _findTarget();
    if (!target) return;
    // Send the attack packet directly — bypasses PathFinding/focus side-effects
    _sendAttack(target.GID);
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
        if (!Array.isArray(entry) || entry.length < 4) continue;
        const entryMap = String(entry[0]).replace(/\.gat$/i, '');
        if (mapName && entryMap !== mapName) continue;
        const classId = Number(entry[3]);
        if (!classId) continue;
        if (!byClass[classId]) {
            byClass[classId] = { classId, name: DB.getMonsterName(classId), mapCount: 0, visibleCount: 0 };
        }
        byClass[classId].mapCount++;
    }

    // 2. Overlay with visible entity counts (also catches mobs not in nav table)
    const visible = _getNearbyMobs();
    visible.forEach(function (m) {
        if (!byClass[m.job]) {
            byClass[m.job] = { classId: m.job, name: DB.getMonsterName(m.job), mapCount: 0, visibleCount: 0 };
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

    const toggle    = root.getElementById('ab-toggle');
    const panel     = root.getElementById('ab-panel');
    const closeBtn  = root.getElementById('ab-close-panel');
    const refreshBtn= root.getElementById('ab-refresh-btn');

    toggle.addEventListener('click', function (e) {
        if (e.target === toggle || e.target.classList.contains('ab-dot') || e.target.id === 'ab-label') {
            if (_active) {
                // Stop
                _toggleActive(root);
            } else if (_targetClass > 0) {
                // Target already selected — start immediately
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

    refreshBtn.addEventListener('click', function () { _refreshList(root); });
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

function _setTarget(classId, name, root) {
    _targetClass = classId;
    const cur = root.getElementById('ab-current-target');
    if (cur) cur.textContent = name;
    _refreshSelectedRow(root);
}

function _refreshSelectedRow(root) {
    root.querySelectorAll('.ab-mob-row').forEach(function (row) {
        const cls = parseInt(row.dataset.class || '0', 10);
        const btn = row.querySelector('.ab-mob-select');
        if (cls === _targetClass) {
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
            const countLabel = info.mapCount > 0
                ? (info.visibleCount + ' / ' + info.mapCount)
                : (info.visibleCount > 0 ? '~' + info.visibleCount : '?');
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
            const name = cls === 0 ? 'Any Monster' : DB.getMonsterName(cls);
            _setTarget(cls, name, root);
            if (cls > 0) {
                // Close panel and start attacking immediately
                panel.classList.remove('ab-panel-open');
                if (!_active) _toggleActive(root);
            }
        });
    });

    _refreshSelectedRow(root);

    // Add "Start (Any Monster)" button if not already present
    if (!root.getElementById('ab-start-any-btn')) {
        const startAnyBtn = document.createElement('button');
        startAnyBtn.id = 'ab-start-any-btn';
        startAnyBtn.className = 'ab-start-any-btn';
        startAnyBtn.textContent = '▶ Start (Any Monster)';
        startAnyBtn.addEventListener('click', function () {
            _setTarget(0, 'Any Monster', root);
            panel.classList.remove('ab-panel-open');
            if (!_active) _toggleActive(root);
        });
        list.parentNode.insertBefore(startAnyBtn, root.getElementById('ab-refresh-btn'));
    }
}

function _esc(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

export default UIManager.addComponent(AutoBattle);
