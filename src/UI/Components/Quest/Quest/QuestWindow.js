/**
 * UI/Components/Quest/QuestWindow.js
 *
 * Manage interface for Quest Window
 *
 * This file is part of ROBrowser, (http://www.robrowser.com/).
 *
 * @author Vincent Thibault
 */

import DB from 'DB/DBManager.js';
import Preferences from 'Core/Preferences.js';
import UIManager from 'UI/UIManager.js';
import GUIComponent from 'UI/GUIComponent.js';
import Navigation from 'UI/Components/Navigation/Navigation.js';
import htmlText from './QuestWindow.html?raw';
import cssText from './QuestWindow.css?raw';

const _preferences = Preferences.get(
	'Quest',
	{
		x: 200,
		y: 200,
		show: false,
		showwindow: true
	},
	1.0
);

/**
 * Create Component
 */
const QuestWindow = new GUIComponent('QuestWindow', cssText);

QuestWindow.render = () => htmlText;

/**
 * Mouse can cross this UI
 */
QuestWindow.mouseMode = GUIComponent.MouseMode.CROSS;

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

function mobNaviLinkHtml(mobName) {
	const raw = String(mobName || '');
	const clean = stripRoColorCodes(raw).replace(/^'+|'+$/g, '').trim();
	if (!clean) {
		return escapeAttr(raw);
	}
	return `<span class="navi-link" data-mob-navi="${escapeAttr(clean)}">${escapeAttr(clean)}</span>`;
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
 * Initialize the component (event listener, etc.)
 */
QuestWindow.init = function init() {
	const root = this.getRoot();
	if (!root) {
		return;
	}
	root.addEventListener('click', event => {
		const naviLink = event.target.closest('.navi-link');
		if (!naviLink) {
			return;
		}
		const mobName = naviLink.dataset.mobNavi;
		if (mobName) {
			navigateToMobName(mobName);
		}
	});
};

/**
 * Once append to the DOM, start to position the UI
 */
QuestWindow.onAppend = function onAppend() {
	if (!_preferences.showwindow) {
		this.ui.hide();
	}
};

/**
 * Clean up UI
 */
QuestWindow.clean = function clean() {
	QuestWindow.ui.hide();
};

/**
 * Set Quest list
 *
 * @param {Array} quests
 */
QuestWindow.setQuestList = function setQuestList(quests, questNotShowList) {
	let already_show = 0;
	for (const questID in quests) {
		if (!questNotShowList.includes(quests[questID].questID)) {
			if (!isInCooldown(quests[questID])) {
				if (quests[questID].active == 1 && already_show < 4) {
					QuestWindow.addQuestToUI(quests[questID]);
					already_show++;
				}
			}
		}
	}
};

function isInCooldown(quest) {
	if (quest.end_time == 0) {
		return false;
	}
	const epoch_seconds = new Date() / 1000;
	if (quest.end_time > epoch_seconds) {
		return true;
	}
	return false;
}

QuestWindow.ClearQuestList = function ClearQuestList() {
	const root = this.getRoot();
	if (!root) {
		return;
	}
	const ul = root.querySelector('.quest-window-ul');
	if (ul) {
		ul.innerHTML = '';
	}
};

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

QuestWindow.addQuestToUI = function addQuestToUI(quest) {
	const root = this.getRoot();
	if (!root) {
		return;
	}
	// Prefer hunt_list links; also link ^color'Mob'^000000 inside summary when present.
	const titleRaw = String(quest.title || '');
	const summaryRaw = String(quest.summary || '');
	const titlePlain = stripRoColorCodes(titleRaw);
	const summaryPlain = stripRoColorCodes(summaryRaw);
	const title =
		titlePlain.length > 25 ? `${escapeAttr(titlePlain.substr(0, 25))}...` : escapeAttr(titlePlain);
	let summary =
		summaryPlain.length > 40 ? `${escapeAttr(summaryPlain.substr(0, 40))}...` : escapeAttr(summaryPlain);
	if (/\^[0-9A-Fa-f]{6}'[^']+'/.test(summaryRaw)) {
		summary = processMobNaviQuotes(summaryRaw);
	}
	let list = '';
	for (const huntID in quest.hunt_list) {
		const hunt = quest.hunt_list[huntID];
		list += `<li>${mobNaviLinkHtml(hunt.mobName)} ( ${hunt.huntCount} / ${hunt.maxCount} )</li>`;
	}
	const ul = root.querySelector('.quest-window-ul');
	if (ul) {
		ul.insertAdjacentHTML(
			'beforeend',
			`<li class="quest-window-li"> <div class="quest-window-li-title">${title}</div> <div class="quest-window-li-summary">${summary}</div> <div class="quest-window-li-monster"><ul>${list}</ul></div> </li>`
		);
	}
};

/**
 * Export
 */
export default UIManager.addComponent(QuestWindow);
