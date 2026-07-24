/**
 * UI/Components/Quest/QuestHelper.js
 *
 * Manage interface for Quest List
 *
 * This file is part of ROBrowser, (http://www.robrowser.com/).
 *
 * @author Vincent Thibault
 */

import DB from 'DB/DBManager.js';
import Client from 'Core/Client.js';
import Preferences from 'Core/Preferences.js';
import Renderer from 'Renderer/Renderer.js';
import UIManager from 'UI/UIManager.js';
import GUIComponent from 'UI/GUIComponent.js';
import 'UI/Elements/Elements.js';
import ItemInfo from 'UI/Components/ItemInfo/ItemInfo.js';
import Navigation from 'UI/Components/Navigation/Navigation.js';
import htmlText from './QuestHelper.html?raw';
import cssText from './QuestHelper.css?raw';

/**
 * Create Component
 */
const QuestHelper = new GUIComponent('QuestHelper', cssText);

QuestHelper.render = () => htmlText;

/**
 * @var {Preferences} structure
 */
const _preferences = Preferences.get(
	'Quest',
	{
		x: 200,
		y: 200,
		show: false
	},
	1.0
);

function escapeAttr(value) {
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

function stripRoColorCodes(text) {
	return String(text || '')
		.replace(/\^[0-9A-Fa-f]{6}/g, '')
		.replace(/\^0\b/g, '')
		.trim();
}

/**
 * Process text with color codes (^RRGGBB)
 * @param {string} text - The text to process
 * @returns {string} HTML with color spans
 */
function processColorCodes(text) {
	// ragnarok-quest-msg-color-v1 — delegate to DB.formatMsgToHtml (^RRGGBB + ^0 reset)
	if (text == null || text === '') {
		return '';
	}
	return DB.formatMsgToHtml(String(text));
}

/**
 * Process item tags in text (<ITEM>Name<INFO>ID</INFO></ITEM>)
 * @param {string} text - The text to process
 * @returns {string} HTML with processed item tags
 */
function processItemTags(text) {
	if (!text) {
		return '';
	}
	text = String(text);
	return text.replace(/<ITEM>([^<]+)<INFO>(\d+)<\/INFO><\/ITEM>/g, (match, itemName, itemId) => {
		return `<span class="item-link" data-item-id="${itemId}">${itemName}</span>`;
	});
}

/**
 * Process NAVI tags in text (<NAVI>Display Name<INFO>mapname,x,y,0,000,flag</INFO></NAVI>)
 * @param {string} text - The text to process
 * @returns {string} HTML with processed NAVI tags
 */
function processNAVITags(text) {
	if (!text) {
		return '';
	}
	text = String(text);
	return text.replace(/<NAVI>([^<]+)<INFO>([^<]+)<\/INFO><\/NAVI>/g, (match, displayName, naviInfo) => {
		return `<span class="navi-link" data-navi-info="${naviInfo}" data-navi-name="${displayName}">${displayName}</span>`;
	});
}

/**
 * OngoingQuestInfoList paints hunt targets as ^4d4dff'MobName'^000000 — not <NAVI>.
 * Turn those quoted colored names into clickable mob navigation links.
 */
function processMobNaviQuotes(text) {
	if (!text) {
		return '';
	}
	return String(text).replace(
		/\^([0-9A-Fa-f]{6})'([^']+)'(?:\^000000|\^0)?/g,
		(match, color, mobName) => {
			const name = String(mobName || '').trim();
			if (!name) {
				return match;
			}
			return (
				`<span class="navi-link" data-mob-navi="${escapeAttr(name)}" ` +
				`style="color:#${color}">'${escapeAttr(name)}'</span>`
			);
		}
	);
}

/**
 * Wrap a hunt-list mob name as a navi link (spawn via DB.searchNavigation).
 */
function mobNaviLinkHtml(mobName) {
	const raw = String(mobName || '');
	const clean = stripRoColorCodes(raw).replace(/^'+|'+$/g, '').trim();
	if (!clean) {
		return processColorCodes(raw);
	}
	const label = processColorCodes(raw) || escapeAttr(clean);
	return `<span class="navi-link" data-mob-navi="${escapeAttr(clean)}">${label}</span>`;
}

function navigateToMobName(mobName) {
	const query = String(mobName || '').trim();
	if (!query || query.length < 2) {
		return;
	}
	const results = DB.searchNavigation(query, 'MOB');
	if (!results.length) {
		return;
	}
	const q = query.toLowerCase();
	const exact = results.find(r => String(r.name).toLowerCase() === q);
	const result = exact || results[0];
	Navigation.show();
	Navigation.uid = `mob:${result.id}:${result.mapName}`;
	Navigation.navigateToSearchResult(result);
}

/**
 * Process all text formatting (color codes and item tags)
 * @param {string} text - The text to process
 * @returns {string} Fully processed HTML
 */
function processText(text) {
	// ragnarok-quest-helper-rewards-v1
	// ragnarok-quest-mob-navi-v1
	if (text == null || text === '') {
		return '';
	}
	if (Array.isArray(text)) {
		text = text.filter(Boolean).join('\n');
	} else {
		text = String(text);
	}
	text = processItemTags(text);
	text = processNAVITags(text);
	text = processMobNaviQuotes(text);
	text = processColorCodes(text);
	// Preserve multi-line quest descriptions in the detail panel.
	text = text.replace(/\r\n/g, '\n').replace(/\n/g, '<br>');
	return text;
}

/**
 * Initialize the component (event listener, etc.)
 */
QuestHelper.init = function init() {
	const root = QuestHelper.getRoot();

	const closeBtn = root.querySelector('.quest-info-bottom-btn');
	if (closeBtn) {
		closeBtn.addEventListener('mousedown', e => e.stopImmediatePropagation());
		closeBtn.addEventListener('click', () => onClickClose());
	}

	// Add click handler for item links (delegated)
	root.addEventListener('click', event => {
		const itemLink = event.target.closest('.item-link');
		if (itemLink) {
			const itemId = parseInt(itemLink.dataset.itemId, 10);
			if (!itemId) {
				return;
			}
			if (ItemInfo.uid === itemId) {
				ItemInfo.remove();
				return;
			}
			ItemInfo.append();
			ItemInfo.uid = itemId;
			ItemInfo.setItem({ ITID: itemId, IsIdentified: true });
			return;
		}

		const naviLink = event.target.closest('.navi-link');
		if (naviLink) {
			const mobName = naviLink.dataset.mobNavi;
			if (mobName) {
				navigateToMobName(mobName);
				return;
			}
			const naviInfo = naviLink.dataset.naviInfo;
			const displayName = naviLink.dataset.naviName;
			if (!naviInfo) {
				return;
			}
			const navHostDisplay = Navigation._host ? getComputedStyle(Navigation._host).display : 'none';
			if (Navigation.uid === naviInfo && navHostDisplay !== 'none') {
				Navigation.hide();
				return;
			}
			Navigation.show();
			Navigation.uid = naviInfo;
			Navigation.setNaviInfo(naviInfo, displayName);
		}
	});

	this.draggable('.titlebar');

	// Load poring images
	root.querySelectorAll('.quest-ui-img-poring').forEach(el => {
		Client.loadFile(`${DB.INTERFACE_PATH}renew_questui/img_poring.bmp`, data => {
			el.style.backgroundImage = `url(${data})`;
		});
	});

	// Load titlebar background
	Client.loadFile(`${DB.INTERFACE_PATH}renew_questui/bg_questsub.bmp`, data => {
		const titlebar = root.querySelector('.titlebar');
		if (titlebar) {
			titlebar.style.backgroundImage = `url(${data})`;
		}
	});
};

/**
 * Once append to the DOM, start to position the UI
 */
QuestHelper.onAppend = function onAppend() {
	this._host.style.left = `${Math.min(Math.max(0, _preferences.x + 382), Renderer.width - 342)}px`;
	this._host.style.top = `${Math.min(Math.max(0, _preferences.y), Renderer.height - 412)}px`;
};

QuestHelper.setQuestInfo = function setQuestInfo(quest) {
	const root = QuestHelper.getRoot();
	if (!root) {
		return;
	}
	const titleEl = root.querySelector('.quest-info-title-panel-text');
	if (titleEl) {
		titleEl.innerHTML = processText(quest.title);
	}

	const descEl = root.querySelector('.quest-info-description-panel-text .quest-ui-text-span');
	if (descEl) {
		descEl.innerHTML = processText(quest.description);
	}

	let list = '';
	for (const huntID in quest.hunt_list) {
		const hunt = quest.hunt_list[huntID];
		list += `<li>${mobNaviLinkHtml(hunt.mobName)} ( ${hunt.huntCount} / ${hunt.maxCount} )</li>`;
	}
	const monsterEl = root.querySelector('.quest-info-monster-panel-text .quest-ui-text-span');
	if (monsterEl) {
		monsterEl.innerHTML = `<ul class="quest-ui-monster-list">${list}<ul>`;
	}

	const baseEl = root.querySelector('.quest-info-reward-li-base');
	if (baseEl) {
		const base = Number(quest.reward_exp_base) || 0;
		baseEl.textContent = base > 0 ? String(base) : '-';
	}
	const jobEl = root.querySelector('.quest-info-reward-li-job');
	if (jobEl) {
		const job = Number(quest.reward_exp_job) || 0;
		jobEl.textContent = job > 0 ? String(job) : '-';
	}

	for (let i = 0; i < quest.reward_item_list.length; i++) {
		const it = DB.getItemInfo(quest.reward_item_list[i].ItemID);
		const item_li =
			`<li class="quest-reward-item-li"><div class="quest-reward-item" data-index="${quest.reward_item_list[i].ItemID}">` +
			`<div class="quest-icon"></div></div><div class="quest-reward-item-info"><span class="quest-reward-item-name">${processText(it.identifiedDisplayName)}</span><br><span>${quest.reward_item_list[i].ItemNum}</span></div></li>`;
		const itemListEl = root.querySelector('.quest-info-reward-li-item-list');
		if (itemListEl) {
			itemListEl.insertAdjacentHTML('beforeend', item_li);
		}
		Client.loadFile(`${DB.INTERFACE_PATH}renew_questui/img_questiocn.bmp`, data => {
			const el = root.querySelector(`.quest-reward-item[data-index="${quest.reward_item_list[i].ItemID}"]`);
			if (el) {
				el.style.backgroundImage = `url(${data})`;
			}
		});
		Client.loadFile(`${DB.INTERFACE_PATH}item/${it.identifiedResourceName}.bmp`, data => {
			const el = root.querySelector(
				`.quest-reward-item[data-index="${quest.reward_item_list[i].ItemID}"] .quest-icon`
			);
			if (el) {
				el.style.backgroundImage = `url(${data})`;
			}
		});
	}

	if (quest.end_time) {
		const d = new Date(0);
		d.setUTCSeconds(quest.end_time);
		const deadlineEl = root.querySelector('.quest-info-bottom-deadline-info-text');
		if (deadlineEl) {
			deadlineEl.textContent = `Deadline [${d.toLocaleString()}]`;
		}
	}
};

QuestHelper.clearQuestDesc = function clearQuestDesc() {
	const root = QuestHelper.getRoot();
	if (!root) {
		return;
	}
	const titleEl = root.querySelector('.quest-info-title-panel-text');
	if (titleEl) {
		titleEl.innerHTML = '';
	}
	const descEl = root.querySelector('.quest-info-description-panel-text .quest-ui-text-span');
	if (descEl) {
		descEl.innerHTML = '';
	}
	const monsterEl = root.querySelector('.quest-info-monster-panel-text .quest-ui-text-span');
	if (monsterEl) {
		monsterEl.innerHTML = '<ul class="quest-ui-monster-list"><ul>';
	}
	const baseEl = root.querySelector('.quest-info-reward-li-base');
	if (baseEl) {
		baseEl.textContent = '';
	}
	const jobEl = root.querySelector('.quest-info-reward-li-job');
	if (jobEl) {
		jobEl.textContent = '';
	}
	const deadlineEl = root.querySelector('.quest-info-bottom-deadline-info-text');
	if (deadlineEl) {
		deadlineEl.textContent = '';
	}
	const itemListEl = root.querySelector('.quest-info-reward-li-item-list');
	if (itemListEl) {
		itemListEl.innerHTML = '';
	}
};

/**
 * Clean up UI
 */
QuestHelper.clean = function clean() {
	QuestHelper.ui.hide();
	onClose();
};

/**
 * Removing the UI from window, save preferences
 */
QuestHelper.onRemove = function onRemove() {};

/**
 * Show/Hide UI
 */
QuestHelper.toggle = function toggle() {
	const hostDisplay = this._host ? getComputedStyle(this._host).display : 'none';
	if (hostDisplay !== 'none') {
		this.ui.hide();
	} else {
		this.ui.show();
	}
};

function onClickClose() {
	QuestHelper.ui.hide();
}

/**
 * Close the window
 */
function onClose() {
	QuestHelper.ui.hide();
}

/**
 * Export
 */
export default UIManager.addComponent(QuestHelper);
