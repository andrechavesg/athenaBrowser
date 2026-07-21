addEventListener(
	'message',
	function OnMessage(event) {
		// Only accept messages from the parent window or opener (the page that loaded us)
		if (event.source !== window.parent && event.source !== window.opener) {
			return;
		}

		removeEventListener('message', OnMessage, false);

		const incomingConfig = event.data && typeof event.data === 'object' ? event.data : {};
		const worldMapDefaults = { episode: 21, add: [], remove: [] };
		incomingConfig.loadLua = true;
		incomingConfig.enableMapName = true;
		if (!incomingConfig.worldMapSettings || typeof incomingConfig.worldMapSettings !== 'object') {
			incomingConfig.worldMapSettings = worldMapDefaults;
		}
		if (Array.isArray(incomingConfig.servers)) {
			incomingConfig.servers = incomingConfig.servers.map(server => {
				if (!server || typeof server !== 'object') {
					return server;
				}
				if (!server.worldMapSettings || typeof server.worldMapSettings !== 'object') {
					return {
						...server,
						worldMapSettings: incomingConfig.worldMapSettings
					};
				}
				return server;
			});
		}
		window.ROConfig = incomingConfig;

		const worldMapLabelOverrides = {
			worldmap: 'Midgard',
			worldmap_dimension: 'New World',
			worldmap_localizing1: 'Eastern Kingdoms',
			worldmap_localizing2: 'Far Lands'
		};
		const normalizeMapAssetId = value =>
			String(value || '')
				.toLowerCase()
				.replace(/\.(bmp|jpg|jpeg|png)$/i, '');
		const getFriendlyWorldMapLabel = option => {
			const normalizedId = normalizeMapAssetId(option.value);
			if (worldMapLabelOverrides[normalizedId]) {
				return worldMapLabelOverrides[normalizedId];
			}
			const label = String(option.textContent || '').trim();
			if (!label || /^localizing\s*0?\d+$/i.test(label)) {
				return normalizedId || 'World Map';
			}
			return label;
		};
		const ensureWorldMapEnhancements = () => {
			const host = document.getElementById('WorldMap');
			const root = host && host.shadowRoot;
			if (!root) {
				return;
			}

			if (!root.querySelector('style[data-ragnarok-worldmap-hotfix]')) {
				const style = document.createElement('style');
				style.dataset.ragnarokWorldmapHotfix = '1';
				style.textContent = `
#WorldMap .worldmap .section.is-dungeon .displayname,
#WorldMap .worldmap .section.is-dungeon-stacked .displayname {
	display: none !important;
}
#WorldMap .worldmap .section:hover .displayname,
#WorldMap .worldmap .section.currentmap .displayname,
#WorldMap .worldmap .section.allmapvisible .displayname {
	display: block !important;
}
#WorldMap .worldmap .section .displayname {
	pointer-events: none;
}`;
				root.appendChild(style);
			}

			const select = root.querySelector('#WorldMaps');
			if (!select) {
				return;
			}

			const optionSignature = Array.from(select.options)
				.map(option => String(option.value || ''))
				.join('|');
			if (select.dataset.ragnarokLabelHotfix !== optionSignature) {
				Array.from(select.options).forEach(option => {
					const friendly = getFriendlyWorldMapLabel(option);
					option.dataset.baseLabel = friendly;
					option.disabled = false;
					option.textContent = friendly;
				});
				select.dataset.ragnarokLabelHotfix = optionSignature;
			}

			if (!select.dataset.ragnarokSwitchHotfix) {
				let lastWorkingValue = select.value;
				let switchProbeToken = 0;

				select.addEventListener('change', () => {
					const requested = select.value;
					switchProbeToken += 1;
					const currentProbe = switchProbeToken;
					const deadline = Date.now() + 8000;

					const requestedOption = Array.from(select.options).find(option => option.value === requested);
					if (requestedOption) {
						requestedOption.disabled = false;
						requestedOption.textContent =
							requestedOption.dataset.baseLabel || getFriendlyWorldMapLabel(requestedOption);
					}

					const verifySwitch = () => {
						if (currentProbe !== switchProbeToken) {
							return;
						}
						const mapView = root.querySelector('.worldmap .map-view');
						if (!mapView) {
							if (Date.now() < deadline) {
								setTimeout(verifySwitch, 250);
							}
							return;
						}
						const currentMapId = normalizeMapAssetId(mapView.id);
						const requestedMapId = normalizeMapAssetId(requested);
						if (currentMapId === requestedMapId) {
							lastWorkingValue = requested;
							return;
						}
						if (Date.now() < deadline) {
							setTimeout(verifySwitch, 250);
							return;
						}

						// In fallback mode image loads may be delayed or sparse; keep options selectable.
						console.warn(
							'[ragnarok-hotfix] world map switch timeout',
							JSON.stringify({
								requested,
								currentMap: mapView.id,
								lastWorkingValue
							})
						);
					};

					setTimeout(verifySwitch, 250);
				});
				select.dataset.ragnarokSwitchHotfix = '1';
			}
		};
		const ensureNavigationUiEnhancements = () => {
			const host = document.getElementById('Navigation');
			const root = host && host.shadowRoot;
			if (!root) {
				return;
			}
			const searchType = root.querySelector('.search-type');
			if (!searchType) {
				return;
			}
			const hasMapOption = Array.from(searchType.options).some(option => option.value === 'MAP');
			if (!hasMapOption) {
				const mapOption = document.createElement('option');
				mapOption.value = 'MAP';
				mapOption.textContent = 'MAP';
				searchType.appendChild(mapOption);
			}
		};
		// Build English map name index from mapnametable.txt (mapid#English Name#\n format)
		const englishMapIndex = {};
		const loadEnglishMapIndex = async () => {
			try {
				const remoteClient =
					(window.ROConfig && window.ROConfig.remoteClient) ||
					(window.ROConfigLocal && window.ROConfigLocal.remoteClient) ||
					'';
				if (!remoteClient) return;
				const base = remoteClient.replace(/\/+$/, '');
				const resp = await fetch(`${base}/data/mapnametable.txt`);
				if (!resp.ok) return;
				const text = await resp.text();
				text.split(/\r?\n/).forEach(line => {
					const parts = line.split('#');
					if (parts.length >= 2) {
						const mapId = parts[0]
							.trim()
							.replace(/\.rsw$/i, '')
							.toLowerCase();
						const engName = parts[1].trim();
						if (mapId && engName) {
							englishMapIndex[mapId] = engName;
						}
					}
				});
				console.log('[ragnarok-hotfix] loaded ' + Object.keys(englishMapIndex).length + ' English map names');
			} catch (err) {
				console.warn('[ragnarok-hotfix] failed to load mapnametable.txt', err);
			}
		};

		const installNavigationSearchPatch = async () => {
			try {
				await loadEnglishMapIndex();
				const module = await import('../../src/DB/DBManager.js');
				const DB = module && module.default;
				if (!DB || DB.__ragnarokSearchPatched) {
					return;
				}

				const getEnglishMapName = mapId => {
					const key = String(mapId || '')
						.toLowerCase()
						.replace(/\.rsw$/i, '')
						.replace(/\.gat$/i, '');
					return englishMapIndex[key] || null;
				};

				const originalSearchNavigation = DB.searchNavigation.bind(DB);
				DB.searchNavigation = function patchedSearchNavigation(query, type) {
					const results = originalSearchNavigation(query, type);
					const normalizedQuery = String(query || '')
						.trim()
						.toLowerCase();
					if (!normalizedQuery || normalizedQuery.length < 2) {
						return results;
					}

					const seen = new Set(
						results.map(result => {
							const typeKey = String(result && result.type ? result.type : '').toUpperCase();
							const mapKey = String(result && result.mapName ? result.mapName : '').toLowerCase();
							const nameKey = String(result && result.name ? result.name : '').toLowerCase();
							return `${typeKey}:${mapKey}:${nameKey}`;
						})
					);

					// Update existing MAP results to use English names where available
					for (const result of results) {
						if (result && result.type === 'MAP' && result.mapName) {
							const engName = getEnglishMapName(result.mapName);
							if (engName) result.name = engName;
						}
					}

					if (type === 'ALL' || type === 'MAP') {
						// Search englishMapIndex values for English name matches
						for (const [mapId, engName] of Object.entries(englishMapIndex)) {
							if (!engName.toLowerCase().includes(normalizedQuery) && !mapId.includes(normalizedQuery)) {
								continue;
							}
							const key = `MAP:${mapId}:${engName.toLowerCase()}`;
							if (seen.has(key)) continue;
							seen.add(key);
							// Try to get coordinates from navi link table
							let x = 150,
								y = 150;
							const naviLinks = Array.isArray(DB.getNaviLinkTable && DB.getNaviLinkTable())
								? DB.getNaviLinkTable()
								: [];
							for (const link of naviLinks) {
								if (!Array.isArray(link) || link.length < 11) continue;
								const lm = String(link[0] || '')
									.toLowerCase()
									.replace(/\.gat$/i, '');
								if (lm === mapId) {
									x = Math.floor(Number(link[6]) || 150);
									y = Math.floor(Number(link[7]) || 150);
									break;
								}
								const lm2 = String(link[8] || '')
									.toLowerCase()
									.replace(/\.gat$/i, '');
								if (lm2 === mapId) {
									x = Math.floor(Number(link[9]) || 150);
									y = Math.floor(Number(link[10]) || 150);
									break;
								}
							}
							results.push({ type: 'MAP', id: mapId, name: engName, mapName: mapId, x, y });
						}

						// Also search NaviMapTable map IDs that weren't in englishMapIndex
						const naviLinks = Array.isArray(DB.getNaviLinkTable && DB.getNaviLinkTable())
							? DB.getNaviLinkTable()
							: [];
						const mapHints = new Map();
						for (const link of naviLinks) {
							if (!Array.isArray(link) || link.length < 11) continue;
							const addHint = (rawMap, rawX, rawY) => {
								const mapName = String(rawMap || '')
									.toLowerCase()
									.replace(/\.gat$/i, '')
									.trim();
								if (!mapName || mapHints.has(mapName)) return;
								mapHints.set(mapName, {
									x: Math.floor(Number(rawX) || 150),
									y: Math.floor(Number(rawY) || 150)
								});
							};
							addHint(link[0], link[6], link[7]);
							addHint(link[8], link[9], link[10]);
						}
						for (const [mapName, coords] of mapHints.entries()) {
							const engName = getEnglishMapName(mapName);
							const displayName =
								engName ||
								String((DB.getMapName && DB.getMapName(`${mapName}.rsw`, mapName)) || mapName).trim();
							const displayLower = displayName.toLowerCase();
							if (!displayLower.includes(normalizedQuery) && !mapName.includes(normalizedQuery)) continue;
							const key = `MAP:${mapName}:${displayLower}`;
							if (seen.has(key)) continue;
							seen.add(key);
							results.push({
								type: 'MAP',
								id: mapName,
								name: displayName,
								mapName,
								x: coords.x,
								y: coords.y
							});
						}
					}

					// Mob search: search monster names via NaviMobTable keys
					if (type === 'ALL' || type === 'MOB') {
						try {
							const naviMob = DB.getNaviMobTable ? DB.getNaviMobTable() : [];
							const mobKeys = Array.isArray(naviMob) ? naviMob : Object.keys(naviMob || {});
							const checkedClasses = new Set();
							for (const entry of mobKeys) {
								let classId;
								if (Array.isArray(entry) && entry.length >= 2) classId = Number(entry[0]);
								else if (typeof entry === 'number') classId = entry;
								else continue;
								if (!classId || checkedClasses.has(classId)) continue;
								checkedClasses.add(classId);
								const mobName = DB.getMonsterName ? String(DB.getMonsterName(classId) || '') : '';
								if (!mobName || !mobName.toLowerCase().includes(normalizedQuery)) continue;
								const mobKey = `MOB:${classId}:${mobName.toLowerCase()}`;
								if (seen.has(mobKey)) continue;
								seen.add(mobKey);
								results.push({ type: 'MOB', id: classId, name: mobName, classId });
							}
						} catch (_e) {}
					}

					results.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
					return results.slice(0, 50);
				};

				DB.__ragnarokSearchPatched = true;
				console.log('[ragnarok-hotfix] navigation search patch enabled (with English map names + mob search)');
			} catch (err) {
				console.warn('[ragnarok-hotfix] failed to patch navigation search', err);
			}
		};

		// Load the engine entry point as an ES6 module
		import('../../src/main.js')
			.then(() => {
				installNavigationSearchPatch();
				const hotfixWindowMs = 10 * 60 * 1000;
				const startedAt = Date.now();
				const applyUiHotfixes = () => {
					ensureWorldMapEnhancements();
					ensureNavigationUiEnhancements();
					if (Date.now() - startedAt >= hotfixWindowMs) {
						clearInterval(timer);
					}
				};
				applyUiHotfixes();
				const timer = setInterval(applyUiHotfixes, 1200);
				event.source.postMessage('ready', '*');
			})
			.catch(err => {
				console.error('Failed to load roBrowser engine:', err);
			});
	},
	false
);
