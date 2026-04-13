const extensionName = 'simpleStatTracker';
const metadataKey = 'simpleStatTracker';
const localSettingsKey = 'simpleStatTracker.settings';
const localStateKey = 'simpleStatTracker.chatState';
const modelCacheKey = 'simpleStatTracker.openRouterModels';
const settingsTargets = ['#extensions_settings2', '#extensions_settings'];

const defaultSettings = {
    enabled: true,
    profiles: {
        'Default RPG': ['{{char}} Health', '{{char}} Money', '{{user}} Health'],
    },
    activeProfile: 'Default RPG',
    autoRefresh: true,
    injectTrackedState: false,
    recentMessageCount: 4,
    maxValueLength: 80,
    openRouter: {
        apiKey: '',
        modelId: '',
        modelLabel: '',
        maxCompletionTokens: 180,
        temperature: 0.1,
        favorites: {},
        activeFavorite: '',
    },
    charProfileMap: {},   // { "CharacterName": "ProfileName" }
    scene: {
        enabled: false,
        xaiApiKey: '',
        model: '',
        locationStatHint: 'location',
        scenePrompt: "You are a visual scene describer for an image generation AI.\nThe roleplay is currently set in: {location}\nRecent chat context:\n{messages}\n\nWrite a single vivid image generation prompt (1-3 sentences, max 120 words) describing this location as a pure visual scene. Focus on: lighting, time of day, weather, atmosphere, architecture or nature. Do NOT mention character names or dialogue. Return ONLY the image prompt text, nothing else.",
        promptTemplates: {},
        activeTemplate: '',
    },
};

let booted = false;
let refreshInFlight = null;
let refreshQueued = false;
let refreshTimer = null;
let activeSnapshot = { stats: {}, updatedAt: null };
let modelCache = loadModelCache();
let lastLocationValue = '';

// Scene image history (last 5 images, most recent first)
const sceneHistory = [];
const SCENE_HISTORY_MAX = 5;
let sceneHistoryIndex = 0;

function pushSceneHistory(url, label) {
    sceneHistory.unshift({ url, label, ts: Date.now() });
    if (sceneHistory.length > SCENE_HISTORY_MAX) sceneHistory.pop();
    sceneHistoryIndex = 0;
}

function updateSceneNav() {
    const nav   = document.getElementById('sst-scene-nav');
    const prev  = document.getElementById('sst-scene-prev');
    const next  = document.getElementById('sst-scene-next');
    const lbl   = document.getElementById('sst-scene-nav-label');
    const thumbs = document.getElementById('sst-scene-thumbs');

    if (!nav) return;
    nav.style.display = sceneHistory.length > 1 ? 'flex' : 'none';
    if (prev) prev.disabled = sceneHistoryIndex >= sceneHistory.length - 1;
    if (next) next.disabled = sceneHistoryIndex <= 0;
    if (lbl)  lbl.textContent = sceneHistory.length > 1
        ? `${sceneHistory.length - sceneHistoryIndex} / ${sceneHistory.length}`
        : '';

    // Thumbnail strip
    if (thumbs) {
        thumbs.style.display = sceneHistory.length > 1 ? 'flex' : 'none';
        thumbs.replaceChildren();
        sceneHistory.forEach((entry, i) => {
            const thumb = document.createElement('img');
            thumb.src = entry.url;
            thumb.className = 'sst-scene-thumb' + (i === sceneHistoryIndex ? ' sst-scene-thumb-active' : '');
            thumb.title = entry.label;
            thumb.addEventListener('click', () => {
                sceneHistoryIndex = i;
                showSceneHistoryImage(i);
            });
            thumbs.appendChild(thumb);
        });
    }
}

function showSceneHistoryImage(index) {
    const entry = sceneHistory[index];
    if (!entry) return;
    const img = document.getElementById('sst-scene-img');
    const ph  = document.getElementById('sst-scene-placeholder');
    const label = document.getElementById('sst-scene-location-label');
    if (img) { img.src = entry.url; img.style.display = 'block'; }
    if (ph)  ph.style.display = 'none';
    if (label) label.textContent = entry.label;
    updateSceneNav();
}

// ─── Core helpers ────────────────────────────────────────────────────────────

function getContext() {
    if (!globalThis.SillyTavern || typeof globalThis.SillyTavern.getContext !== 'function') {
        throw new Error('SillyTavern.getContext is unavailable.');
    }
    return globalThis.SillyTavern.getContext();
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function clampInt(value, min, max, fallback) {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

function clampFloat(value, min, max, fallback) {
    const n = Number.parseFloat(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

// ─── Settings storage ─────────────────────────────────────────────────────────

function loadLocalSettings() {
    try {
        const raw = localStorage.getItem(localSettingsKey);
        return raw ? JSON.parse(raw) : null;
    } catch (_error) {
        return null;
    }
}

function saveLocalSettings(settings) {
    localStorage.setItem(localSettingsKey, JSON.stringify(settings));
}

function loadModelCache() {
    try {
        const raw = localStorage.getItem(modelCacheKey);
        if (!raw) return { fetchedAt: null, models: [] };
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return { fetchedAt: null, models: [] };
        if (!Array.isArray(parsed.models)) parsed.models = [];
        return parsed;
    } catch (_error) {
        return { fetchedAt: null, models: [] };
    }
}

function saveModelCache(cache) {
    modelCache = cache;
    localStorage.setItem(modelCacheKey, JSON.stringify(cache));
}

function getSettingsStore() {
    const context = getContext();
    if (context.extensionSettings && typeof context.extensionSettings === 'object') {
        return { mode: 'context', root: context.extensionSettings };
    }

    let localRoot = loadLocalSettings();
    if (!localRoot || typeof localRoot !== 'object') {
        localRoot = {};
    }
    return { mode: 'local', root: localRoot };
}

function sanitizeApiKey(rawValue) {
    let key = typeof rawValue === 'string' ? rawValue.trim() : '';
    key = key.replace(/^Bearer\s+/i, '');
    key = key.replace(/^["'`\s]+|["'`\s]+$/g, '');
    return key.trim();
}

function normalizeSettings(settings) {
    if (!settings || typeof settings !== 'object') {
        settings = clone(defaultSettings);
    }

    settings.enabled = settings.enabled !== false;

    if (!settings.profiles || typeof settings.profiles !== 'object' || Array.isArray(settings.profiles)) {
        settings.profiles = clone(defaultSettings.profiles);
    }

    if (Object.keys(settings.profiles).length === 0) {
        settings.profiles = clone(defaultSettings.profiles);
    }

    if (!settings.activeProfile || !settings.profiles[settings.activeProfile]) {
        settings.activeProfile = Object.keys(settings.profiles)[0];
    }

    settings.autoRefresh = Boolean(settings.autoRefresh);
    settings.injectTrackedState = Boolean(settings.injectTrackedState);
    settings.recentMessageCount = clampInt(settings.recentMessageCount, 1, 12, defaultSettings.recentMessageCount);
    settings.maxValueLength = clampInt(settings.maxValueLength, 12, 240, defaultSettings.maxValueLength);

    if (!settings.openRouter || typeof settings.openRouter !== 'object') {
        settings.openRouter = clone(defaultSettings.openRouter);
    }

    settings.openRouter.apiKey = sanitizeApiKey(settings.openRouter.apiKey);
    settings.openRouter.modelId = typeof settings.openRouter.modelId === 'string' ? settings.openRouter.modelId.trim() : '';
    settings.openRouter.modelLabel = typeof settings.openRouter.modelLabel === 'string' ? settings.openRouter.modelLabel : '';
    settings.openRouter.maxCompletionTokens = clampInt(settings.openRouter.maxCompletionTokens, 32, 1000, defaultSettings.openRouter.maxCompletionTokens);
    settings.openRouter.temperature = clampFloat(settings.openRouter.temperature, 0, 2, defaultSettings.openRouter.temperature);

    if (!settings.openRouter.favorites || typeof settings.openRouter.favorites !== 'object' || Array.isArray(settings.openRouter.favorites)) {
        settings.openRouter.favorites = {};
    }

    settings.openRouter.activeFavorite = typeof settings.openRouter.activeFavorite === 'string' ? settings.openRouter.activeFavorite : '';

    if (!settings.charProfileMap || typeof settings.charProfileMap !== 'object' || Array.isArray(settings.charProfileMap)) {
        settings.charProfileMap = {};
    }

    if (!settings.scene || typeof settings.scene !== 'object') {
        settings.scene = clone(defaultSettings.scene);
    }
    settings.scene.enabled        = Boolean(settings.scene.enabled);
    settings.scene.xaiApiKey      = typeof settings.scene.xaiApiKey === 'string' ? settings.scene.xaiApiKey.trim() : '';
    settings.scene.model          = typeof settings.scene.model === 'string' ? settings.scene.model.trim() : '';
    settings.scene.locationStatHint = typeof settings.scene.locationStatHint === 'string' ? settings.scene.locationStatHint.trim() : 'location';
    // migrate old stylePrompt field → scenePrompt
    if (typeof settings.scene.stylePrompt === 'string' && !settings.scene.scenePrompt) {
        settings.scene.scenePrompt = settings.scene.stylePrompt;
    }
    delete settings.scene.stylePrompt;
    const _sp = typeof settings.scene.scenePrompt === 'string' ? settings.scene.scenePrompt.trim() : '';
    // Reset if blank OR if it's a stale style-hint string with no {messages} placeholder
    settings.scene.scenePrompt = (_sp && _sp.includes('{messages}'))
        ? _sp
        : defaultSettings.scene.scenePrompt;
    if (!settings.scene.promptTemplates || typeof settings.scene.promptTemplates !== 'object' || Array.isArray(settings.scene.promptTemplates)) {
        settings.scene.promptTemplates = {};
    }
    settings.scene.activeTemplate = typeof settings.scene.activeTemplate === 'string' ? settings.scene.activeTemplate : '';

    return settings;
}

function getSettings() {
    const store = getSettingsStore();
    if (!store.root[extensionName]) {
        store.root[extensionName] = clone(defaultSettings);
    }

    store.root[extensionName] = normalizeSettings(store.root[extensionName]);

    if (store.mode === 'local') {
        saveLocalSettings(store.root);
    }

    return store.root[extensionName];
}

function persistSettings() {
    const context = getContext();
    const store = getSettingsStore();

    if (store.mode === 'local') {
        saveLocalSettings(store.root);
        return;
    }

    if (typeof context.saveSettingsDebounced === 'function') {
        context.saveSettingsDebounced();
        return;
    }

    if (typeof context.saveSettings === 'function') {
        context.saveSettings();
        return;
    }

    saveLocalSettings(store.root);
}

// ─── Chat state / metadata ────────────────────────────────────────────────────

function currentChatKey() {
    const context = getContext();
    const chatId = typeof context.getCurrentChatId === 'function' ? context.getCurrentChatId() : '';

    if (context.groupId && chatId) return `group:${context.groupId}:${chatId}`;
    if (Number.isInteger(context.characterId) && chatId) return `char:${context.characterId}:${chatId}`;
    if (chatId) return `chat:${chatId}`;
    return 'chat:none';
}

function getMetadataRoot(createIfMissing = true) {
    const context = getContext();
    if (!context.chatMetadata || typeof context.chatMetadata !== 'object') {
        return null;
    }

    if (!context.chatMetadata[metadataKey] && createIfMissing) {
        context.chatMetadata[metadataKey] = { version: 1, profiles: {} };
    }

    return context.chatMetadata[metadataKey] || null;
}

function loadLocalStates() {
    try {
        const raw = localStorage.getItem(localStateKey);
        return raw ? JSON.parse(raw) : {};
    } catch (_error) {
        return {};
    }
}

function saveLocalStates(states) {
    localStorage.setItem(localStateKey, JSON.stringify(states));
}

function getProfileState(profileName, createIfMissing = true) {
    const root = getMetadataRoot(createIfMissing);
    if (root) {
        if (!root.profiles[profileName] && createIfMissing) {
            root.profiles[profileName] = { stats: {}, updatedAt: null };
        }
        return root.profiles[profileName] || null;
    }

    const allStates = loadLocalStates();
    const key = currentChatKey();
    if (!allStates[key]) allStates[key] = { profiles: {} };
    if (!allStates[key].profiles[profileName] && createIfMissing) {
        allStates[key].profiles[profileName] = { stats: {}, updatedAt: null };
        saveLocalStates(allStates);
    }
    return allStates[key].profiles[profileName] || null;
}

async function persistMetadata() {
    const context = getContext();
    const root = getMetadataRoot(false);
    if (root && typeof context.saveMetadata === 'function') {
        await context.saveMetadata();
        return;
    }

    const allStates = loadLocalStates();
    const key = currentChatKey();
    if (!allStates[key]) allStates[key] = { profiles: {} };
    allStates[key].profiles[getActiveProfileName()] = clone(activeSnapshot);
    saveLocalStates(allStates);
}

// ─── Stat helpers ─────────────────────────────────────────────────────────────

function hashString(input) {
    let hash = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function makeStatId(template) {
    return `stat_${hashString(String(template).trim())}`;
}

function normalizeLines(rawText) {
    const seen = new Set();
    return String(rawText)
        .split(/\r?\n/)
        .map(x => x.trim())
        .filter(Boolean)
        .filter(x => {
            if (seen.has(x)) return false;
            seen.add(x);
            return true;
        });
}

function resolveMacroString(text) {
    const context = getContext();

    let charName =
        context.name2 ||
        context.characterName ||
        context.charName ||
        '';

    if (!charName && Number.isInteger(context.characterId) && Array.isArray(context.characters)) {
        charName = context.characters[context.characterId]?.name || '';
    }

    if (!charName && context.groupId && Array.isArray(context.groups)) {
        const group = context.groups.find(g => String(g.id) === String(context.groupId));
        if (group?.name) {
            charName = group.name;
        }
    }

    const userName =
        context.name1 ||
        context.userName ||
        context.username ||
        '';

    return String(text)
        .replace(/\{\{\s*char\s*\}\}/gi, charName || '{{char}}')
        .replace(/\{\{\s*user\s*\}\}/gi, userName || '{{user}}');
}

function getCurrentCharName() {
    const context = getContext();
    let name = context.name2 || context.characterName || context.charName || '';
    if (!name && Number.isInteger(context.characterId) && Array.isArray(context.characters)) {
        name = context.characters[context.characterId]?.name || '';
    }
    if (!name && context.groupId && Array.isArray(context.groups)) {
        const group = context.groups.find(g => String(g.id) === String(context.groupId));
        if (group?.name) name = group.name;
    }
    return name.trim();
}

function autoSwitchProfile() {
    const settings = getSettings();
    if (!settings.charProfileMap) return;
    const charName = getCurrentCharName();
    if (!charName) return;
    const mapped = settings.charProfileMap[charName];
    if (!mapped || !settings.profiles[mapped]) return;
    if (settings.activeProfile === mapped) return;  // already on correct profile
    settings.activeProfile = mapped;
    persistSettings();
    syncSnapshot();
    updateSettingsUi();
    safeToast('info', `Profile switched to "${mapped}" for ${charName}`);
}

function getActiveProfileName() {
    return getSettings().activeProfile;
}

function getProfileLines(profileName = getActiveProfileName()) {
    const settings = getSettings();
    const lines = settings.profiles[profileName];
    return Array.isArray(lines) ? lines : [];
}

function getDefinitions(profileName = getActiveProfileName()) {
    return getProfileLines(profileName).map(template => ({
        id: makeStatId(template),
        template,
        label: resolveMacroString(template),
    }));
}

function buildSnapshot(profileName = getActiveProfileName()) {
    const definitions = getDefinitions(profileName);
    const stored = getProfileState(profileName, true) || { stats: {}, updatedAt: null };
    const stats = {};

    for (const definition of definitions) {
        const existing = stored.stats?.[definition.id] || {};
        stats[definition.id] = {
            template: definition.template,
            label: definition.label,
            value: typeof existing.value === 'string' ? existing.value : '',
        };
    }

    return {
        stats,
        updatedAt: stored.updatedAt || null,
    };
}

function writeSnapshot() {
    const state = getProfileState(getActiveProfileName(), true);
    if (!state) return;
    state.stats = clone(activeSnapshot.stats);
    state.updatedAt = activeSnapshot.updatedAt;
}

function stripHtml(input) {
    const div = document.createElement('div');
    div.innerHTML = input || '';
    return (div.textContent || div.innerText || '').replace(/\s+/g, ' ').trim();
}

function getRecentMessages(limit = getSettings().recentMessageCount) {
    const context = getContext();
    const messages = Array.isArray(context.chat) ? context.chat : [];

    return messages
        .filter(message => message && typeof message.mes === 'string' && message.mes.trim())
        .slice(-limit)
        .map(message => ({
            speaker: message.name || (message.is_user ? 'User' : 'Assistant'),
            text: stripHtml(message.mes).slice(0, 1200),
        }))
        .filter(message => message.text);
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

function safeToast(level, text) {
    if (!globalThis.toastr || typeof globalThis.toastr[level] !== 'function') return;
    globalThis.toastr[level](text);
}

async function promptInput(title, defaultValue = '') {
    const context = getContext();
    if (context.Popup?.show?.input) {
        const result = await context.Popup.show.input(title, null, defaultValue);
        return typeof result === 'string' ? result.trim() : '';
    }
    return typeof globalThis.prompt === 'function' ? (globalThis.prompt(title, defaultValue) || '').trim() : '';
}

async function promptConfirm(text) {
    const context = getContext();
    if (context.Popup?.show?.confirm) {
        return Boolean(await context.Popup.show.confirm('Confirm', text));
    }
    return typeof globalThis.confirm === 'function' ? globalThis.confirm(text) : false;
}

// ─── OpenRouter helpers ───────────────────────────────────────────────────────

function getOpenRouterSettings() {
    const openRouter = getSettings().openRouter;
    const sanitized = sanitizeApiKey(openRouter.apiKey);
    if (sanitized !== openRouter.apiKey) {
        openRouter.apiKey = sanitized;
        persistSettings();
    }
    return openRouter;
}

async function fetchOpenRouterKeyInfo(apiKey) {
    const cleanKey = sanitizeApiKey(apiKey);
    if (!cleanKey) {
        throw new Error('OpenRouter API key is missing.');
    }

    const response = await fetch('https://openrouter.ai/api/v1/key', {
        method: 'GET',
        headers: {
            Authorization: `Bearer ${cleanKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': globalThis.location?.origin || 'http://localhost',
            'X-OpenRouter-Title': 'Simple Stat Tracker',
        },
    });

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        if (response.status === 401) {
            throw new Error('OpenRouter rejected the API key. Paste the raw sk-or-v1 key only. Do not include Bearer, quotes, or a masked placeholder.');
        }
        throw new Error(`OpenRouter key validation failed with status ${response.status}${text ? `: ${text.slice(0, 240)}` : ''}`);
    }

    const data = await response.json();
    return data?.data || null;
}

function buildFavoriteSnapshot() {
    const openRouter = getOpenRouterSettings();
    return {
        modelId: openRouter.modelId,
        modelLabel: openRouter.modelLabel || '',
        maxCompletionTokens: openRouter.maxCompletionTokens,
        temperature: openRouter.temperature,
    };
}

function applyFavorite(name) {
    const settings = getSettings();
    const favorite = settings.openRouter.favorites[name];
    if (!favorite) return false;

    settings.openRouter.modelId = favorite.modelId || '';
    settings.openRouter.modelLabel = favorite.modelLabel || favorite.modelId || '';
    settings.openRouter.maxCompletionTokens = clampInt(
        favorite.maxCompletionTokens,
        32,
        1000,
        defaultSettings.openRouter.maxCompletionTokens
    );
    settings.openRouter.temperature = clampFloat(
        favorite.temperature,
        0,
        2,
        defaultSettings.openRouter.temperature
    );
    settings.openRouter.activeFavorite = name;
    persistSettings();
    return true;
}

function sortModels(models) {
    return [...models].sort((a, b) => {
        const left = `${a.name || ''} ${a.id || ''}`.toLowerCase();
        const right = `${b.name || ''} ${b.id || ''}`.toLowerCase();
        return left.localeCompare(right);
    });
}

function isTextModel(model) {
    if (!model || typeof model !== 'object') return false;
    const arch = model.architecture || {};
    const input = Array.isArray(arch.input_modalities) ? arch.input_modalities : [];
    const output = Array.isArray(arch.output_modalities) ? arch.output_modalities : [];
    if (input.includes('text') && output.includes('text')) return true;
    if (typeof arch.modality === 'string' && arch.modality.includes('text')) return true;
    return false;
}

function normalizeModelEntry(raw) {
    return {
        id: typeof raw.id === 'string' ? raw.id : '',
        name: typeof raw.name === 'string' ? raw.name : (typeof raw.id === 'string' ? raw.id : ''),
        context_length: Number.isFinite(raw.context_length) ? raw.context_length : null,
        pricing: raw.pricing || null,
        architecture: raw.architecture || {},
    };
}

async function fetchOpenRouterModels(force = false) {
    const openRouter = getOpenRouterSettings();
    const apiKey = sanitizeApiKey(openRouter.apiKey);
    if (!apiKey) {
        throw new Error('OpenRouter API key is missing.');
    }

    if (apiKey !== openRouter.apiKey) {
        openRouter.apiKey = apiKey;
        persistSettings();
    }

    if (!force && Array.isArray(modelCache.models) && modelCache.models.length > 0) {
        return modelCache.models;
    }

    await fetchOpenRouterKeyInfo(apiKey);

    const response = await fetch('https://openrouter.ai/api/v1/models', {
        method: 'GET',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': globalThis.location?.origin || 'http://localhost',
            'X-OpenRouter-Title': 'Simple Stat Tracker',
        },
    });

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        if (response.status === 401) {
            throw new Error('OpenRouter rejected the API key while loading models. Paste the raw sk-or-v1 key only.');
        }
        throw new Error(`OpenRouter model list failed with status ${response.status}${text ? `: ${text.slice(0, 240)}` : ''}`);
    }

    const data = await response.json();
    const models = sortModels(
        (Array.isArray(data?.data) ? data.data : [])
            .map(normalizeModelEntry)
            .filter(model => model.id)
            .filter(isTextModel)
    );

    saveModelCache({ fetchedAt: new Date().toISOString(), models });
    return models;
}

// ─── Model / favorite select UI ───────────────────────────────────────────────

function ensureSelectedModelOption() {
    const select = document.getElementById('sst-or-model');
    const openRouter = getOpenRouterSettings();
    if (!select || !openRouter.modelId) return;

    const exists = Array.from(select.options).some(option => option.value === openRouter.modelId);
    if (exists) return;

    const option = document.createElement('option');
    option.value = openRouter.modelId;
    option.textContent = openRouter.modelLabel || openRouter.modelId;
    option.dataset.orphan = 'true';
    select.appendChild(option);
}

function updateModelSelectUi() {
    const select = document.getElementById('sst-or-model');
    const modelInfo = document.getElementById('sst-model-status');
    const openRouter = getOpenRouterSettings();
    if (!select) return;

    const previousValue = openRouter.modelId || '';
    select.replaceChildren();

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = modelCache.models.length > 0 ? 'Select a tracker model' : 'Load models first';
    placeholder.selected = !previousValue;
    select.appendChild(placeholder);

    for (const model of modelCache.models) {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = `${model.name || model.id} — ${model.id}`;
        option.selected = model.id === previousValue;
        select.appendChild(option);
    }

    ensureSelectedModelOption();
    select.value = previousValue;

    if (modelInfo) {
        const fetchedAt = modelCache.fetchedAt ? new Date(modelCache.fetchedAt).toLocaleString() : 'never';
        modelInfo.textContent = modelCache.models.length > 0
            ? `Cached ${modelCache.models.length} models · ${fetchedAt}`
            : 'No models cached yet.';
    }
}

function updateFavoriteUi() {
    const select = document.getElementById('sst-favorite-select');
    if (!select) return;

    const openRouter = getOpenRouterSettings();
    const names = Object.keys(openRouter.favorites).sort((a, b) => a.localeCompare(b));

    select.replaceChildren();

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = names.length > 0 ? 'Select saved preset' : 'No saved presets';
    placeholder.selected = !openRouter.activeFavorite;
    select.appendChild(placeholder);

    for (const name of names) {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        option.selected = name === openRouter.activeFavorite;
        select.appendChild(option);
    }
}

// ─── Floating tracker button ──────────────────────────────────────────────────

function ensureTrackerButton() {
    if (document.getElementById('sst-tracker-btn')) return;

    const btn = document.createElement('div');
    btn.id = 'sst-tracker-btn';
    btn.title = 'Open Stat Tracker';
    btn.innerHTML = '<i class="fa-solid fa-chart-bar"></i>';
    btn.addEventListener('click', () => openTrackerModal());
    document.body.appendChild(btn);
}

function removeTrackerButton() {
    document.getElementById('sst-tracker-btn')?.remove();
}

// ─── Tracker floating window ──────────────────────────────────────────────────

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function buildWindowBody(container) {
    const definitions = getDefinitions();
    container.replaceChildren();

    if (definitions.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'sst-win-empty';
        empty.textContent = 'No tracked stats defined for this profile.';
        container.appendChild(empty);
        return;
    }

    for (const def of definitions) {
        const value = activeSnapshot.stats?.[def.id]?.value || '';

        const row = document.createElement('div');
        row.className = 'sst-win-row';
        row.dataset.statId = def.id;

        const label = document.createElement('div');
        label.className = 'sst-win-label';
        label.textContent = def.label;

        const valueEl = document.createElement('div');
        valueEl.className = 'sst-win-value';

        if (value) {
            valueEl.textContent = value;
        } else {
            const pending = document.createElement('span');
            pending.className = 'sst-win-pending';
            pending.textContent = 'Pending…';
            valueEl.appendChild(pending);
        }

        // Click value to edit inline
        valueEl.title = 'Click to edit';
        valueEl.style.cursor = 'text';
        valueEl.addEventListener('click', () => {
            if (valueEl.querySelector('input')) return; // already editing
            const current = activeSnapshot.stats?.[def.id]?.value || '';
            const input = document.createElement('input');
            input.type = 'text';
            input.value = current;
            input.className = 'sst-win-edit-input';
            valueEl.replaceChildren(input);
            input.focus();
            input.select();

            const commit = () => {
                const newVal = input.value.trim();
                if (!activeSnapshot.stats[def.id]) {
                    activeSnapshot.stats[def.id] = { template: def.template, label: def.label, value: '' };
                }
                activeSnapshot.stats[def.id].value = newVal;
                activeSnapshot.updatedAt = new Date().toISOString();
                writeSnapshot();
                void persistMetadata();
                refreshWindowBody();
            };
            input.addEventListener('blur', commit);
            input.addEventListener('keydown', e => {
                if (e.key === 'Enter') { e.preventDefault(); commit(); }
                if (e.key === 'Escape') { refreshWindowBody(); }
            });
        });

        row.append(label, valueEl);
        container.appendChild(row);
    }
}

function refreshWindowBody() {
    const win = document.getElementById('sst-window');
    if (!win) return;

    const body  = win.querySelector('#sst-win-body');
    const ts    = win.querySelector('#sst-win-timestamp');
    const badge = win.querySelector('#sst-win-profile-badge');
    const copyBtn = win.querySelector('#sst-win-copy');

    if (body)  buildWindowBody(body);
    if (ts)    ts.textContent = activeSnapshot.updatedAt
        ? `Updated ${new Date(activeSnapshot.updatedAt).toLocaleTimeString()}`
        : 'Not yet refreshed';
    if (badge) badge.textContent = getActiveProfileName();
}

function makeDraggable(win, handle) {
    let startX, startY, startLeft, startTop;

    handle.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        e.preventDefault();
        const rect = win.getBoundingClientRect();
        startX = e.clientX;
        startY = e.clientY;
        startLeft = rect.left;
        startTop  = rect.top;

        win.classList.add('sst-win-dragging');

        function onMove(e) {
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            const newLeft = Math.max(0, Math.min(window.innerWidth  - win.offsetWidth,  startLeft + dx));
            const newTop  = Math.max(0, Math.min(window.innerHeight - win.offsetHeight, startTop  + dy));
            win.style.left = `${newLeft}px`;
            win.style.top  = `${newTop}px`;
            win.style.right  = 'auto';
            win.style.bottom = 'auto';
        }

        function onUp() {
            win.classList.remove('sst-win-dragging');
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup',   onUp);
            // Persist position so it survives chat changes
            localStorage.setItem('simpleStatTracker.winPos', JSON.stringify({
                left: win.style.left,
                top:  win.style.top,
            }));
        }

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup',   onUp);
    });
}

function ensureTrackerWindow() {
    if (document.getElementById('sst-window')) return;

    const win = document.createElement('div');
    win.id = 'sst-window';

    win.innerHTML = `
        <div id="sst-win-titlebar">
            <div id="sst-win-title">
                <i class="fa-solid fa-chart-bar"></i>
                <span>Stat Tracker</span>
                <span id="sst-win-profile-badge"></span>
            </div>
            <div id="sst-win-controls">
                <button id="sst-win-refresh" class="sst-win-btn" title="Refresh tracker">
                    <i class="fa-solid fa-rotate-right"></i>
                </button>
                <button id="sst-win-scene" class="sst-win-btn" title="Generate scene image">
                    <i class="fa-solid fa-camera"></i>
                </button>
                <button id="sst-win-close" class="sst-win-btn sst-win-btn-close" title="Close">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
        </div>
        <div id="sst-win-body"></div>
        <div id="sst-win-footer">
            <span id="sst-win-timestamp">Not yet refreshed</span>
            <button id="sst-win-copy" class="sst-win-btn" title="Copy stats to clipboard" style="opacity:0.5">
                <i class="fa-solid fa-copy"></i>
            </button>
        </div>
        <div id="sst-win-location-bar">
            <input id="sst-win-location-input" class="sst-win-location-input" type="text" placeholder="Override location & generate scene…">
            <button id="sst-win-location-gen" class="sst-win-btn" title="Generate scene for this location">
                <i class="fa-solid fa-wand-magic-sparkles"></i>
            </button>
        </div>
    `;

    // Restore saved position or default to bottom-right
    const savedPos = (() => {
        try { return JSON.parse(localStorage.getItem('simpleStatTracker.winPos') || 'null'); }
        catch (_) { return null; }
    })();

    if (savedPos?.left && savedPos?.top) {
        win.style.left   = savedPos.left;
        win.style.top    = savedPos.top;
        win.style.right  = 'auto';
        win.style.bottom = 'auto';
    }

    document.body.appendChild(win);

    // Draggable via titlebar
    makeDraggable(win, win.querySelector('#sst-win-titlebar'));

    // Close button
    win.querySelector('#sst-win-close').addEventListener('click', () => {
        win.classList.add('sst-win-hidden');
        const btn = document.getElementById('sst-tracker-btn');
        if (btn) btn.classList.remove('sst-tracker-btn-active');
    });

    // Refresh button
    win.querySelector('#sst-win-refresh').addEventListener('click', async () => {
        const btn = win.querySelector('#sst-win-refresh');
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
        await refreshTrackedState('manual');
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-rotate-right"></i>';
    });

    // Camera / scene button
    win.querySelector('#sst-win-scene').addEventListener('click', async () => {
        const btn = win.querySelector('#sst-win-scene');
        const settings = getSettings();
        if (!settings.scene?.xaiApiKey) {
            safeToast('warning', 'Set your xAI API key in Scene Image settings first.');
            return;
        }
        const locId = getLocationStatId();
        const loc = locId ? (activeSnapshot.stats?.[locId]?.value || '') : '';
        if (!loc) {
            safeToast('warning', 'No location stat tracked yet.');
            return;
        }
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
        openSceneWindow();
        try {
            const result = await buildLocationImageDescription(loc);
            await renderSceneImage(result.description, result);
        } catch (err) {
            await renderSceneImage(loc, { locationValue: loc, messagesCount: 0, messagesText: '' });
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-camera"></i>';
        }
    });

    // Copy stats to clipboard
    win.querySelector('#sst-win-copy')?.addEventListener('click', async () => {
        const definitions = getDefinitions();
        const lines = definitions.map(def => {
            const val = activeSnapshot.stats?.[def.id]?.value || '—';
            return `${def.label}: ${val}`;
        });
        const text = `[${getActiveProfileName()}]\n${lines.join('\n')}`;
        try {
            await navigator.clipboard.writeText(text);
            safeToast('success', 'Stats copied to clipboard.');
        } catch (_) {
            safeToast('error', 'Clipboard copy failed.');
        }
    });

    // Manual location override → generate scene
    const locInput = win.querySelector('#sst-win-location-input');
    win.querySelector('#sst-win-location-gen')?.addEventListener('click', async () => {
        const loc = locInput?.value.trim();
        if (!loc) { safeToast('warning', 'Enter a location first.'); return; }
        const settings = getSettings();
        if (!settings.scene?.xaiApiKey) { safeToast('warning', 'Set your xAI API key in Scene Image settings first.'); return; }
        const btn = win.querySelector('#sst-win-location-gen');
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
        openSceneWindow();
        try {
            const result = await buildLocationImageDescription(loc);
            await renderSceneImage(result.description, result);
        } catch (err) {
            await renderSceneImage(loc, { locationValue: loc, messagesCount: 0, messagesText: '' });
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i>';
        }
    });
    locInput?.addEventListener('keydown', e => {
        if (e.key === 'Enter') win.querySelector('#sst-win-location-gen')?.click();
    });

    refreshWindowBody();
}

function openTrackerWindow() {
    ensureTrackerWindow();
    const win = document.getElementById('sst-window');
    if (!win) return;
    win.classList.remove('sst-win-hidden');
    const btn = document.getElementById('sst-tracker-btn');
    if (btn) btn.classList.add('sst-tracker-btn-active');
    refreshWindowBody();
}

// Keep old name so settings "View state" button still works
async function openTrackerModal() {
    openTrackerWindow();
}

// Called after every refresh to update window in place
function updateTrackerModal() {
    refreshWindowBody();
}


// ─── xAI image generation ─────────────────────────────────────────────────────

function getLocationStatId() {
    const settings = getSettings();
    const hint = (settings.scene.locationStatHint || 'location').toLowerCase();
    const definitions = getDefinitions();
    // Find first stat whose label contains the hint word
    const match = definitions.find(def => def.label.toLowerCase().includes(hint));
    return match ? match.id : null;
}

async function fetchXaiModels(apiKey) {
    const response = await fetch('https://api.x.ai/v1/models', {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
    });
    if (!response.ok) return [];
    const data = await response.json();
    // Filter to image-capable models only
    const models = Array.isArray(data?.data) ? data.data : [];
    return models
        .filter(m => {
            const id = (m.id || '').toLowerCase();
            return id.includes('image') || id.includes('imagine') || id.includes('aurora');
        })
        .map(m => m.id);
}

async function resolveXaiImageModel(apiKey, preferred) {
    // If user set a model manually, try it first
    if (preferred && preferred.trim()) return preferred.trim();
    // Otherwise auto-detect from account
    const models = await fetchXaiModels(apiKey);
    if (models.length > 0) return models[0];
    // Last-resort fallbacks in order of likelihood
    return 'grok-2-image-1212';
}

async function generateSceneImage(locationText, aspectRatio = '16:9') {
    const settings = getSettings();
    const apiKey = settings.scene.xaiApiKey;
    if (!apiKey) throw new Error('xAI API key is not set.');

    // prompt is already fully built by buildLocationImageDescription — passed in as locationText
    const prompt = locationText;

    // Resolve the correct model for this account
    const preferred = settings.scene.model?.trim() || '';
    const model = await resolveXaiImageModel(apiKey, preferred);

    // If auto-detected a different model, save it so we don't re-query each time
    if (!preferred && model !== settings.scene.model) {
        settings.scene.model = model;
        persistSettings();
        const modelInput = document.getElementById('sst-scene-model');
        if (modelInput) modelInput.value = model;
    }

    const response = await fetch('https://api.x.ai/v1/images/generations', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model,
            prompt,
            n: 1,
            ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
        }),
    });

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`xAI image generation failed (${response.status})${text ? ': ' + text.slice(0, 300) : ''}`);
    }

    const data = await response.json();
    const url = data?.data?.[0]?.url || data?.data?.[0]?.b64_json;
    if (!url) throw new Error('xAI returned no image URL.');
    return { url, prompt, model };
}

// ─── Scene / location image window ───────────────────────────────────────────

function updateSceneTemplateUi() {
    const select = document.getElementById('sst-scene-template-select');
    if (!select) return;
    const settings = getSettings();
    const names = Object.keys(settings.scene.promptTemplates || {}).sort((a, b) => a.localeCompare(b));
    select.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = names.length > 0 ? 'Select saved template' : 'No saved templates';
    placeholder.selected = !settings.scene.activeTemplate;
    select.appendChild(placeholder);
    for (const name of names) {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        option.selected = name === settings.scene.activeTemplate;
        select.appendChild(option);
    }
}

function ensureSceneWindow() {
    if (document.getElementById('sst-scene-window')) return;

    const win = document.createElement('div');
    win.id = 'sst-scene-window';
    win.classList.add('sst-win-hidden');

    win.innerHTML = `
        <div id="sst-scene-titlebar">
            <div id="sst-scene-title">
                <i class="fa-solid fa-image"></i>
                <span id="sst-scene-location-label">Scene</span>
            </div>
            <div id="sst-scene-controls">
                <select id="sst-scene-aspect" class="sst-scene-aspect-select" title="Aspect ratio">
                    <option value="">auto</option>
                    <option value="16:9" selected>16:9</option>
                    <option value="4:3">4:3</option>
                    <option value="1:1">1:1</option>
                    <option value="9:16">9:16</option>
                    <option value="3:2">3:2</option>
                </select>
                <button id="sst-scene-regen" class="sst-win-btn" title="Regenerate image">
                    <i class="fa-solid fa-rotate-right"></i>
                </button>
                <button id="sst-scene-download" class="sst-win-btn" title="Download image">
                    <i class="fa-solid fa-download"></i>
                </button>
                <button id="sst-scene-close" class="sst-win-btn sst-win-btn-close" title="Close">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
        </div>
        <div id="sst-scene-body">
            <div id="sst-scene-placeholder">
                <i class="fa-solid fa-mountain-sun"></i>
                <span>Waiting for location…</span>
            </div>
            <img id="sst-scene-img" style="display:none" alt="Scene">
            <div id="sst-scene-spinner" style="display:none">
                <i class="fa-solid fa-spinner fa-spin"></i>
                <span id="sst-scene-spinner-text">Generating scene…</span>
            </div>
            <div id="sst-scene-error" style="display:none"></div>
            <div id="sst-scene-nav">
                <button id="sst-scene-prev" class="sst-scene-nav-btn" title="Previous image">
                    <i class="fa-solid fa-chevron-left"></i>
                </button>
                <span id="sst-scene-nav-label"></span>
                <button id="sst-scene-next" class="sst-scene-nav-btn" title="Next image">
                    <i class="fa-solid fa-chevron-right"></i>
                </button>
            </div>
        </div>
        <div id="sst-scene-thumbs"></div>
        <div id="sst-scene-footer">
            <div id="sst-scene-footer-bar">
                <span id="sst-scene-footer-model"></span>
                <button id="sst-scene-debug-toggle" class="sst-win-btn" title="Show debug info" style="width:auto;padding:0 6px;font-size:0.75em;opacity:0.5">
                    <i class="fa-solid fa-bug"></i> debug
                </button>
            </div>
            <div id="sst-scene-debug" style="display:none">
                <div class="sst-debug-row">
                    <div class="sst-debug-label">Location value</div>
                    <div id="sst-debug-location" class="sst-debug-value">—</div>
                </div>
                <div class="sst-debug-row">
                    <div class="sst-debug-label">LLM description sent to xAI</div>
                    <div id="sst-debug-description" class="sst-debug-value">—</div>
                </div>
                <div class="sst-debug-row">
                    <div class="sst-debug-label">xAI model used</div>
                    <div id="sst-debug-model" class="sst-debug-value">—</div>
                </div>
                <div class="sst-debug-row">
                    <div class="sst-debug-label">Recent messages seen</div>
                    <div id="sst-debug-messages" class="sst-debug-value">—</div>
                </div>
                <div class="sst-debug-row">
                    <div class="sst-debug-label">Full prompt sent to OpenRouter</div>
                    <div id="sst-debug-llm-prompt" class="sst-debug-value">—</div>
                </div>
            </div>
        </div>
    `;

    // Restore saved position
    const savedPos = (() => {
        try { return JSON.parse(localStorage.getItem('simpleStatTracker.scenWinPos') || 'null'); }
        catch (_) { return null; }
    })();
    if (savedPos?.left && savedPos?.top) {
        win.style.left   = savedPos.left;
        win.style.top    = savedPos.top;
        win.style.right  = 'auto';
        win.style.bottom = 'auto';
    }

    document.body.appendChild(win);
    makeDraggable(win, win.querySelector('#sst-scene-titlebar'));

    win.querySelector('#sst-scene-close').addEventListener('click', () => {
        win.classList.add('sst-win-hidden');
    });

    // Prev / next history navigation
    win.querySelector('#sst-scene-prev')?.addEventListener('click', () => {
        if (sceneHistoryIndex < sceneHistory.length - 1) {
            sceneHistoryIndex++;
            showSceneHistoryImage(sceneHistoryIndex);
        }
    });
    win.querySelector('#sst-scene-next')?.addEventListener('click', () => {
        if (sceneHistoryIndex > 0) {
            sceneHistoryIndex--;
            showSceneHistoryImage(sceneHistoryIndex);
        }
    });

    win.querySelector('#sst-scene-debug-toggle').addEventListener('click', () => {
        const panel = win.querySelector('#sst-scene-debug');
        const btn   = win.querySelector('#sst-scene-debug-toggle');
        const open  = panel.style.display === 'none';
        panel.style.display = open ? 'block' : 'none';
        btn.style.opacity   = open ? '1' : '0.5';
    });

    win.querySelector('#sst-scene-regen').addEventListener('click', async () => {
        const locId = getLocationStatId();
        const loc   = locId ? (activeSnapshot.stats?.[locId]?.value || '') : '';
        if (!loc) { safeToast('warning', 'No location value to generate from.'); return; }
        try {
            const result = await buildLocationImageDescription(loc);
            await renderSceneImage(result.description, result);
        } catch (err) {
            await renderSceneImage(loc, { locationValue: loc, messagesCount: 0, messagesText: '' });
        }
    });

    win.querySelector('#sst-scene-download')?.addEventListener('click', async () => {
        const img = win.querySelector('#sst-scene-img');
        const src = img?.src || '';
        if (!src) {
            safeToast('warning', 'No scene image to download yet.');
            return;
        }

        const activeEntry = sceneHistory[sceneHistoryIndex];
        const label = (activeEntry?.label || 'scene')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 48) || 'scene';
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `sst-${label}-${stamp}.png`;

        try {
            let downloadHref = src;
            let revokeUrl = null;

            // xAI may return raw base64 in b64_json format; normalize to data URL first.
            if (!/^https?:|^data:/i.test(src)) {
                downloadHref = `data:image/png;base64,${src}`;
            }

            // For remote URLs, fetch as blob so the browser consistently downloads with our filename.
            if (/^https?:/i.test(downloadHref)) {
                const response = await fetch(downloadHref);
                if (!response.ok) throw new Error(`Image fetch failed (${response.status})`);
                const blob = await response.blob();
                revokeUrl = URL.createObjectURL(blob);
                downloadHref = revokeUrl;
            }

            const a = document.createElement('a');
            a.href = downloadHref;
            a.download = filename;
            a.rel = 'noopener noreferrer';
            document.body.appendChild(a);
            a.click();
            a.remove();
            if (revokeUrl) setTimeout(() => URL.revokeObjectURL(revokeUrl), 1000);
            safeToast('success', 'Scene image download started.');
        } catch (err) {
            console.error('Scene image download failed:', err);
            safeToast('error', 'Could not download image. Try opening it in a new tab.');
        }
    });
}

function openSceneWindow() {
    ensureSceneWindow();
    document.getElementById('sst-scene-window')?.classList.remove('sst-win-hidden');
}

async function renderSceneImage(locationText, debugInfo = null) {
    ensureSceneWindow();
    const win      = document.getElementById('sst-scene-window');
    const img      = document.getElementById('sst-scene-img');
    const spinner  = document.getElementById('sst-scene-spinner');
    const errDiv   = document.getElementById('sst-scene-error');
    const ph       = document.getElementById('sst-scene-placeholder');
    const label    = document.getElementById('sst-scene-location-label');
    const regenBtn = document.getElementById('sst-scene-regen');

    if (!win || !img) return;

    if (label) label.textContent = locationText;

    // Show window
    win.classList.remove('sst-win-hidden');

    // Show spinner, hide others
    if (ph)      ph.style.display      = 'none';
    if (img)     img.style.display     = 'none';
    if (errDiv)  errDiv.style.display  = 'none';
    if (spinner) spinner.style.display = 'flex';
    const spinnerText = win.querySelector('#sst-scene-spinner-text');
    if (spinnerText) spinnerText.textContent = 'Generating scene…';
    if (regenBtn) { regenBtn.disabled = true; regenBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>'; }

    try {
        // Read aspect ratio from selector
        const aspectEl = win.querySelector('#sst-scene-aspect');
        const aspectRatio = aspectEl?.value || '16:9';

        const { url, prompt, model } = await generateSceneImage(locationText, aspectRatio);

        // Push to image history
        pushSceneHistory(url, locationText);
        updateSceneNav();

        // Populate footer model
        const modelEl = win.querySelector('#sst-scene-footer-model');
        if (modelEl) modelEl.textContent = model || '';

        // Populate debug panel
        const dbgLocation    = win.querySelector('#sst-debug-location');
        const dbgDescription = win.querySelector('#sst-debug-description');
        const dbgModel       = win.querySelector('#sst-debug-model');
        const dbgMessages    = win.querySelector('#sst-debug-messages');
        const dbgPrompt      = win.querySelector('#sst-debug-llm-prompt');
        if (dbgLocation)    dbgLocation.textContent    = debugInfo?.locationValue || locationText;
        if (dbgDescription) dbgDescription.textContent = prompt;
        if (dbgModel)       dbgModel.textContent       = model || '—';
        if (dbgMessages)    dbgMessages.textContent    = debugInfo
            ? `${debugInfo.messagesCount} message(s):\n${debugInfo.messagesText || '(none)'}`
            : '—';
        if (dbgPrompt)      dbgPrompt.textContent      = debugInfo?.filledPrompt || '—';
        img.src = url;
        img.onload = () => {
            if (spinner) spinner.style.display = 'none';
            img.style.display = 'block';
        };
        img.onerror = () => {
            if (spinner) spinner.style.display = 'none';
            if (errDiv) { errDiv.textContent = 'Failed to load image.'; errDiv.style.display = 'flex'; }
        };
    } catch (err) {
        console.error('Scene image generation failed:', err);
        if (spinner) spinner.style.display = 'none';
        if (errDiv) {
            errDiv.textContent = err?.message || 'Image generation failed.';
            errDiv.style.display = 'flex';
        }
    } finally {
        if (regenBtn) { regenBtn.disabled = false; regenBtn.innerHTML = '<i class="fa-solid fa-rotate-right"></i>'; }
    }
}

async function buildLocationImageDescription(locationValue) {
    const settings = getSettings();
    const recentMessages = getRecentMessages();

    const messagesText = recentMessages
        .map(m => `${m.speaker}: ${m.text}`)
        .join('\n') || '(no recent messages)';

    const template = settings.scene.scenePrompt || defaultSettings.scene.scenePrompt;
    const filledPrompt = template
        .replace(/\{location\}/gi, locationValue)
        .replace(/\{messages\}/gi, messagesText);

    console.log('[SST Scene] Prompt sent to OpenRouter:', filledPrompt);

    const raw = await callTextModel(filledPrompt);
    const cleaned = raw.replace(/^```[\w]*\s*/i, '').replace(/\s*```$/i, '').trim();

    console.log('[SST Scene] OpenRouter raw response:', raw);
    console.log('[SST Scene] Description sent to xAI:', cleaned);

    let description = cleaned;
    try {
        const parsed = JSON.parse(cleaned);
        const first = Object.values(parsed)[0];
        if (typeof first === 'string' && first.trim()) description = first.trim();
    } catch (_) {}

    description = description || locationValue;

    // Return everything so caller can populate debug panel
    return {
        description,
        locationValue,
        messagesText,
        messagesCount: recentMessages.length,
        filledPrompt,
    };
}

async function checkLocationChange(previousStats) {
    const settings = getSettings();
    if (!settings.scene?.enabled || !settings.scene?.xaiApiKey) return;

    const locId = getLocationStatId();
    if (!locId) return;

    const newValue  = activeSnapshot.stats?.[locId]?.value?.trim() || '';
    const prevValue = previousStats?.[locId]?.value?.trim() || '';

    if (!newValue) return;
    if (newValue === prevValue) return;  // no change

    // Toast notification for location change
    safeToast('info', `📍 Location: ${newValue}`);

    // Show the window immediately with spinner while we generate the description
    openSceneWindow();

    try {
        // Step 1: Ask OpenRouter to write a rich visual description from the chat context
        const result = await buildLocationImageDescription(newValue);
        await renderSceneImage(result.description, result);
    } catch (err) {
        console.error('Scene location description failed:', err);
        await renderSceneImage(newValue, { locationValue: newValue, messagesCount: 0, messagesText: '' });
    }
}

// ─── Settings panel ───────────────────────────────────────────────────────────

function buildSettingsPanel() {
    const container = document.createElement('div');
    container.id = 'simple-stat-tracker-settings';
    container.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Simple Stat Tracker</b>
                <div class="inline-drawer-icon fa-solid fa-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">

                <!-- Master toggle -->
                <div class="sst-settings-row sst-toggle-row">
                    <label class="sst-toggle-label" for="sst-enabled">
                        <input id="sst-enabled" type="checkbox">
                        <span>Enable extension</span>
                    </label>
                </div>

                <!-- ── OpenRouter Backend ── -->
                <div class="sst-settings-section">
                    <div class="sst-settings-section-title">
                        <i class="fa-solid fa-robot"></i> OpenRouter Backend
                    </div>

                    <div class="sst-field">
                        <label class="sst-field-label" for="sst-or-api-key">API Key</label>
                        <input id="sst-or-api-key" class="text_pole" type="password"
                               autocomplete="off" placeholder="sk-or-v1-…">
                    </div>

                    <div class="sst-field">
                        <label class="sst-field-label" for="sst-or-model">Model</label>
                        <div class="sst-row-inline">
                            <select id="sst-or-model" class="text_pole sst-select-grow"></select>
                            <button id="sst-or-load-models" class="menu_button sst-btn-compact">Load</button>
                        </div>
                        <div id="sst-model-status" class="sst-field-hint">No models cached yet.</div>
                    </div>

                    <div class="sst-field-grid-2">
                        <div class="sst-field">
                            <label class="sst-field-label" for="sst-or-max-tokens">Max tokens</label>
                            <input id="sst-or-max-tokens" class="text_pole" type="number"
                                   min="32" max="1000" step="1">
                        </div>
                        <div class="sst-field">
                            <label class="sst-field-label" for="sst-or-temperature">Temperature</label>
                            <input id="sst-or-temperature" class="text_pole" type="number"
                                   min="0" max="2" step="0.1">
                        </div>
                    </div>

                    <div class="sst-field">
                        <label class="sst-field-label" for="sst-favorite-select">Saved presets</label>
                        <div class="sst-row-inline">
                            <select id="sst-favorite-select" class="text_pole sst-select-grow"></select>
                            <button id="sst-favorite-load"   class="menu_button sst-btn-compact">Load</button>
                            <button id="sst-favorite-save"   class="menu_button sst-btn-compact">Save</button>
                            <button id="sst-favorite-delete" class="menu_button sst-btn-compact sst-btn-danger">Del</button>
                        </div>
                    </div>
                </div>

                <!-- ── Profiles & Stats ── -->
                <div class="sst-settings-section">
                    <div class="sst-settings-section-title">
                        <i class="fa-solid fa-list"></i> Profiles &amp; Stats
                    </div>

                    <div class="sst-field">
                        <label class="sst-field-label" for="sst-profile-select">Active profile</label>
                        <div class="sst-row-inline">
                            <select id="sst-profile-select" class="text_pole sst-select-grow"></select>
                            <button id="sst-new-profile"    class="menu_button sst-btn-compact">New</button>
                            <button id="sst-delete-profile" class="menu_button sst-btn-compact sst-btn-danger">Del</button>
                        </div>
                    </div>

                    <div class="sst-field">
                        <label class="sst-field-label" for="sst-stat-definitions">
                            Tracked stats
                            <span class="sst-field-hint-inline">— one per line, supports {{char}} &amp; {{user}}</span>
                        </label>
                        <textarea id="sst-stat-definitions" class="text_pole" rows="6"
                            placeholder="{{char}} Health&#10;{{user}} Mana&#10;Relationship"></textarea>
                    </div>

                    <button id="sst-save" class="menu_button sst-btn-full">
                        <i class="fa-solid fa-floppy-disk"></i> Save profile
                    </button>

                    <div class="sst-field" style="margin-top:6px">
                        <label class="sst-field-label">
                            <i class="fa-solid fa-user-tag"></i> Character → Profile binding
                            <span class="sst-field-hint-inline">— auto-switches on chat load</span>
                        </label>
                        <div id="sst-char-map-list" class="sst-char-map-list"></div>
                        <div class="sst-row-inline" style="margin-top:4px">
                            <span id="sst-char-map-current" class="sst-field-hint sst-char-map-current">Current character: —</span>
                            <button id="sst-char-map-bind" class="menu_button sst-btn-compact">
                                <i class="fa-solid fa-link"></i> Bind
                            </button>
                            <button id="sst-char-map-unbind" class="menu_button sst-btn-compact sst-btn-danger">
                                <i class="fa-solid fa-unlink"></i> Unbind
                            </button>
                        </div>
                    </div>
                </div>

                <!-- ── Behaviour ── -->
                <div class="sst-settings-section">
                    <div class="sst-settings-section-title">
                        <i class="fa-solid fa-sliders"></i> Behaviour
                    </div>

                    <div class="sst-settings-row sst-toggle-row">
                        <label class="sst-toggle-label" for="sst-auto-refresh">
                            <input id="sst-auto-refresh" type="checkbox">
                            <span>Auto-refresh after each reply</span>
                        </label>
                    </div>

                    <div class="sst-settings-row sst-toggle-row">
                        <label class="sst-toggle-label" for="sst-inject-state">
                            <input id="sst-inject-state" type="checkbox">
                            <span>Inject tracked state into next prompt</span>
                        </label>
                    </div>

                    <div class="sst-field-grid-2">
                        <div class="sst-field">
                            <label class="sst-field-label" for="sst-recent-count">Recent messages</label>
                            <input id="sst-recent-count" class="text_pole" type="number"
                                   min="1" max="12" step="1">
                        </div>
                        <div class="sst-field">
                            <label class="sst-field-label" for="sst-max-value-length">Max value length</label>
                            <input id="sst-max-value-length" class="text_pole" type="number"
                                   min="12" max="240" step="1">
                        </div>
                    </div>
                </div>

                <!-- ── Scene / Location Image ── -->
                <div class="sst-settings-section">
                    <div class="sst-settings-section-title">
                        <i class="fa-solid fa-mountain-sun"></i> Scene Image (xAI)
                    </div>

                    <div class="sst-settings-row sst-toggle-row">
                        <label class="sst-toggle-label" for="sst-scene-enabled">
                            <input id="sst-scene-enabled" type="checkbox">
                            <span>Auto-generate scene on location change</span>
                        </label>
                    </div>

                    <div class="sst-field">
                        <label class="sst-field-label" for="sst-scene-api-key">xAI API Key</label>
                        <input id="sst-scene-api-key" class="text_pole" type="password"
                               autocomplete="off" placeholder="xai-…">
                    </div>

                    <div class="sst-field">
                        <label class="sst-field-label" for="sst-scene-model">Image model
                            <span class="sst-field-hint-inline">— leave blank to auto-detect</span>
                        </label>
                        <div class="sst-row-inline">
                            <input id="sst-scene-model" class="text_pole sst-select-grow" type="text" placeholder="auto-detect from account…">
                            <button id="sst-scene-detect-model" class="menu_button sst-btn-compact">Detect</button>
                        </div>
                        <div id="sst-scene-model-status" class="sst-field-hint"></div>
                    </div>
                    <div class="sst-field">
                        <label class="sst-field-label" for="sst-scene-stat-hint">Location stat keyword</label>
                        <input id="sst-scene-stat-hint" class="text_pole" type="text" placeholder="location">
                    </div>

                    <div class="sst-field">
                        <label class="sst-field-label" for="sst-scene-style">
                            Scene description prompt
                            <span class="sst-field-hint-inline">— sent to OpenRouter to write the image prompt</span>
                        </label>
                        <div class="sst-field-hint" style="margin-bottom:4px">
                            Use <code>{location}</code> and <code>{messages}</code> as placeholders.
                        </div>
                        <textarea id="sst-scene-style" class="text_pole sst-scene-prompt-textarea"
                            rows="7"></textarea>
                        <div class="sst-row-inline sst-scene-template-row">
                            <select id="sst-scene-template-select" class="text_pole sst-select-grow"></select>
                            <button id="sst-scene-template-load"   class="menu_button sst-btn-compact" title="Load selected template">Load</button>
                            <button id="sst-scene-template-save"   class="menu_button sst-btn-compact" title="Save as template">Save</button>
                            <button id="sst-scene-template-delete" class="menu_button sst-btn-compact sst-btn-danger" title="Delete template">Del</button>
                            <button id="sst-scene-template-reset"  class="menu_button sst-btn-compact" title="Reset to default prompt">Reset</button>
                        </div>
                    </div>

                    <div class="sst-row-inline" style="gap:8px">
                        <button id="sst-scene-open" class="menu_button" style="flex:1">
                            <i class="fa-solid fa-image"></i> Open scene window
                        </button>
                        <button id="sst-scene-gen-now" class="menu_button" style="flex:1">
                            <i class="fa-solid fa-wand-magic-sparkles"></i> Generate now
                        </button>
                    </div>
                </div>

                <!-- ── Actions ── -->
                <div class="sst-settings-actions">
                    <button id="sst-refresh" class="menu_button">
                        <i class="fa-solid fa-rotate-right"></i> Recalculate
                    </button>
                    <button id="sst-view" class="menu_button">
                        <i class="fa-solid fa-chart-bar"></i> View state
                    </button>
                </div>

            </div>
        </div>
    `;
    return container;
}

function ensureSettingsPanel() {
    if (document.getElementById('simple-stat-tracker-settings')) return;

    const target = settingsTargets
        .map(selector => document.querySelector(selector))
        .find(Boolean);

    if (!target) throw new Error('Extension settings container not found.');

    target.appendChild(buildSettingsPanel());
}

// ─── Settings UI sync ─────────────────────────────────────────────────────────

function updateCharMapUi() {
    const settings = getSettings();
    const list = document.getElementById('sst-char-map-list');
    const currentLabel = document.getElementById('sst-char-map-current');
    if (!list) return;

    const charName = getCurrentCharName();
    if (currentLabel) {
        currentLabel.textContent = charName ? `Current: ${charName}` : 'Current: (no character loaded)';
    }

    const entries = Object.entries(settings.charProfileMap || {});
    list.replaceChildren();

    if (entries.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'sst-char-map-empty';
        empty.textContent = 'No bindings yet.';
        list.appendChild(empty);
        return;
    }

    for (const [char, profile] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
        const row = document.createElement('div');
        row.className = 'sst-char-map-row';

        const active = char === charName;
        row.innerHTML = `
            <span class="sst-char-map-char ${active ? 'sst-char-map-active' : ''}">${escapeHtml(char)}</span>
            <i class="fa-solid fa-arrow-right sst-char-map-arrow"></i>
            <span class="sst-char-map-profile">${escapeHtml(profile)}</span>
            <button class="sst-win-btn sst-char-map-del" data-char="${escapeHtml(char)}" title="Remove binding">
                <i class="fa-solid fa-xmark"></i>
            </button>
        `;
        row.querySelector('.sst-char-map-del').addEventListener('click', () => {
            delete settings.charProfileMap[char];
            persistSettings();
            updateCharMapUi();
        });
        list.appendChild(row);
    }
}

function updateSettingsUi() {
    const settings = getSettings();
    const select = document.getElementById('sst-profile-select');
    const textarea = document.getElementById('sst-stat-definitions');
    const enableToggle = document.getElementById('sst-enabled');
    const autoRefresh = document.getElementById('sst-auto-refresh');
    const injectState = document.getElementById('sst-inject-state');
    const recentCount = document.getElementById('sst-recent-count');
    const maxValueLength = document.getElementById('sst-max-value-length');
    const apiKey = document.getElementById('sst-or-api-key');
    const maxTokens = document.getElementById('sst-or-max-tokens');
    const temperature = document.getElementById('sst-or-temperature');

    if (!select || !textarea) return;

    select.replaceChildren();
    for (const name of Object.keys(settings.profiles)) {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        option.selected = name === settings.activeProfile;
        select.appendChild(option);
    }

    textarea.value = getProfileLines(settings.activeProfile).join('\n');

    if (enableToggle) enableToggle.checked = settings.enabled;
    if (autoRefresh) autoRefresh.checked = settings.autoRefresh;
    if (injectState) injectState.checked = settings.injectTrackedState;
    if (recentCount) recentCount.value = String(settings.recentMessageCount);
    if (maxValueLength) maxValueLength.value = String(settings.maxValueLength);
    if (apiKey) apiKey.value = settings.openRouter.apiKey;
    if (maxTokens) maxTokens.value = String(settings.openRouter.maxCompletionTokens);
    if (temperature) temperature.value = String(settings.openRouter.temperature);

    updateModelSelectUi();
    updateFavoriteUi();
    updateCharMapUi();

    // Scene settings
    const sceneEnabled  = document.getElementById('sst-scene-enabled');
    const sceneApiKey   = document.getElementById('sst-scene-api-key');
    const sceneModel    = document.getElementById('sst-scene-model');
    const sceneHint     = document.getElementById('sst-scene-stat-hint');
    const sceneStyle    = document.getElementById('sst-scene-style');
    if (sceneEnabled) sceneEnabled.checked = settings.scene?.enabled || false;
    if (sceneApiKey)  sceneApiKey.value    = settings.scene?.xaiApiKey || '';
    if (sceneModel)   sceneModel.value     = settings.scene?.model || 'grok-2-image';
    if (sceneHint)    sceneHint.value      = settings.scene?.locationStatHint || 'location';
    if (sceneStyle)   sceneStyle.value     = settings.scene?.scenePrompt || defaultSettings.scene.scenePrompt;
    updateSceneTemplateUi();

    // Show/hide tracker button based on enabled state
    const btn = document.getElementById('sst-tracker-btn');
    if (btn) btn.style.display = settings.enabled ? '' : 'none';
}

// ─── Settings event binding ───────────────────────────────────────────────────

function bindSettingsEvents() {
    const select = document.getElementById('sst-profile-select');
    const textarea = document.getElementById('sst-stat-definitions');
    const enableToggle = document.getElementById('sst-enabled');
    const autoRefresh = document.getElementById('sst-auto-refresh');
    const injectState = document.getElementById('sst-inject-state');
    const recentCount = document.getElementById('sst-recent-count');
    const maxValueLength = document.getElementById('sst-max-value-length');
    const apiKey = document.getElementById('sst-or-api-key');
    const loadModelsButton = document.getElementById('sst-or-load-models');
    const modelSelect = document.getElementById('sst-or-model');
    const maxTokens = document.getElementById('sst-or-max-tokens');
    const temperature = document.getElementById('sst-or-temperature');
    const favoriteSelect = document.getElementById('sst-favorite-select');
    const favoriteLoad = document.getElementById('sst-favorite-load');
    const favoriteSave = document.getElementById('sst-favorite-save');
    const favoriteDelete = document.getElementById('sst-favorite-delete');
    const newProfile = document.getElementById('sst-new-profile');
    const deleteProfile = document.getElementById('sst-delete-profile');
    const saveButton = document.getElementById('sst-save');
    const refreshButton = document.getElementById('sst-refresh');
    const viewButton = document.getElementById('sst-view');

    if (!select || !textarea || !saveButton || !refreshButton || !viewButton) {
        throw new Error('Tracker settings UI binding failed.');
    }

    enableToggle?.addEventListener('change', () => {
        const settings = getSettings();
        settings.enabled = enableToggle.checked;
        persistSettings();
        updateSettingsUi();
        safeToast('info', settings.enabled ? 'Simple Stat Tracker enabled.' : 'Simple Stat Tracker disabled.');
    });

    select.addEventListener('change', () => {
        const settings = getSettings();
        settings.activeProfile = select.value;
        persistSettings();
        syncSnapshot();
        updateSettingsUi();
    });

    autoRefresh?.addEventListener('change', () => {
        const settings = getSettings();
        settings.autoRefresh = autoRefresh.checked;
        persistSettings();
    });

    injectState?.addEventListener('change', () => {
        const settings = getSettings();
        settings.injectTrackedState = injectState.checked;
        persistSettings();
    });

    recentCount?.addEventListener('change', () => {
        const settings = getSettings();
        settings.recentMessageCount = clampInt(recentCount.value, 1, 12, defaultSettings.recentMessageCount);
        recentCount.value = String(settings.recentMessageCount);
        persistSettings();
    });

    maxValueLength?.addEventListener('change', () => {
        const settings = getSettings();
        settings.maxValueLength = clampInt(maxValueLength.value, 12, 240, defaultSettings.maxValueLength);
        maxValueLength.value = String(settings.maxValueLength);
        persistSettings();
    });

    apiKey?.addEventListener('change', () => {
        const settings = getSettings();
        settings.openRouter.apiKey = sanitizeApiKey(apiKey.value);
        apiKey.value = settings.openRouter.apiKey;
        persistSettings();
    });

    maxTokens?.addEventListener('change', () => {
        const settings = getSettings();
        settings.openRouter.maxCompletionTokens = clampInt(maxTokens.value, 32, 1000, defaultSettings.openRouter.maxCompletionTokens);
        maxTokens.value = String(settings.openRouter.maxCompletionTokens);
        persistSettings();
    });

    temperature?.addEventListener('change', () => {
        const settings = getSettings();
        settings.openRouter.temperature = clampFloat(temperature.value, 0, 2, defaultSettings.openRouter.temperature);
        temperature.value = String(settings.openRouter.temperature);
        persistSettings();
    });

    loadModelsButton?.addEventListener('click', async () => {
        const buttonText = loadModelsButton.innerHTML;
        loadModelsButton.disabled = true;
        loadModelsButton.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

        try {
            const settings = getSettings();
            settings.openRouter.apiKey = sanitizeApiKey(apiKey?.value || settings.openRouter.apiKey);
            if (apiKey) apiKey.value = settings.openRouter.apiKey;
            persistSettings();

            await fetchOpenRouterModels(true);
            updateSettingsUi();
            safeToast('success', 'OpenRouter models loaded.');
        } catch (error) {
            console.error('Simple Stat Tracker model load failed.', error);
            safeToast('error', error?.message || 'Failed to load OpenRouter models.');
        } finally {
            loadModelsButton.disabled = false;
            loadModelsButton.innerHTML = buttonText;
        }
    });

    modelSelect?.addEventListener('change', () => {
        const settings = getSettings();
        settings.openRouter.modelId = modelSelect.value;
        const selectedOption = modelSelect.options[modelSelect.selectedIndex];
        settings.openRouter.modelLabel = selectedOption ? selectedOption.textContent : modelSelect.value;
        settings.openRouter.activeFavorite = '';
        persistSettings();
        updateFavoriteUi();
    });

    favoriteSelect?.addEventListener('change', () => {
        const settings = getSettings();
        settings.openRouter.activeFavorite = favoriteSelect.value;
        persistSettings();
    });

    favoriteLoad?.addEventListener('click', () => {
        const name = favoriteSelect?.value || '';
        if (!name) {
            safeToast('warning', 'Choose a saved preset first.');
            return;
        }
        if (!applyFavorite(name)) {
            safeToast('error', 'Preset not found.');
            return;
        }
        updateSettingsUi();
        safeToast('success', `Loaded preset '${name}'.`);
    });

    favoriteSave?.addEventListener('click', async () => {
        const settings = getSettings();
        const defaultName = settings.openRouter.activeFavorite || settings.openRouter.modelId || 'My preset';
        const name = await promptInput('Save preset as', defaultName);
        if (!name) return;
        if (!settings.openRouter.modelId) {
            safeToast('warning', 'Select an OpenRouter model first.');
            return;
        }
        settings.openRouter.favorites[name] = buildFavoriteSnapshot();
        settings.openRouter.activeFavorite = name;
        persistSettings();
        updateFavoriteUi();
        safeToast('success', `Saved preset '${name}'.`);
    });

    favoriteDelete?.addEventListener('click', async () => {
        const settings = getSettings();
        const name = favoriteSelect?.value || settings.openRouter.activeFavorite || '';
        if (!name || !settings.openRouter.favorites[name]) {
            safeToast('warning', 'Choose a saved preset first.');
            return;
        }
        const confirmed = await promptConfirm(`Delete preset '${name}'?`);
        if (!confirmed) return;
        delete settings.openRouter.favorites[name];
        if (settings.openRouter.activeFavorite === name) settings.openRouter.activeFavorite = '';
        persistSettings();
        updateFavoriteUi();
        safeToast('info', `Deleted preset '${name}'.`);
    });

    newProfile?.addEventListener('click', async () => {
        const settings = getSettings();
        const fallback = `Profile ${Object.keys(settings.profiles).length + 1}`;
        const name = await promptInput('New tracker profile name', fallback);
        if (!name) return;
        if (settings.profiles[name]) {
            safeToast('warning', 'A profile with that name already exists.');
            return;
        }
        settings.profiles[name] = ['{{char}} Status'];
        settings.activeProfile = name;
        persistSettings();
        syncSnapshot();
        updateSettingsUi();
    });

    deleteProfile?.addEventListener('click', async () => {
        const settings = getSettings();
        if (Object.keys(settings.profiles).length <= 1) {
            safeToast('warning', 'Cannot delete the last profile.');
            return;
        }

        const doomed = settings.activeProfile;
        const confirmed = await promptConfirm(`Delete profile '${doomed}'?`);
        if (!confirmed) return;

        delete settings.profiles[doomed];

        const root = getMetadataRoot(false);
        if (root?.profiles?.[doomed]) delete root.profiles[doomed];

        settings.activeProfile = Object.keys(settings.profiles)[0];
        persistSettings();
        await persistMetadata();
        syncSnapshot();
        updateSettingsUi();
    });

    saveButton.addEventListener('click', async () => {
        const settings = getSettings();
        settings.profiles[settings.activeProfile] = normalizeLines(textarea.value);
        persistSettings();
        syncSnapshot();
        writeSnapshot();
        await persistMetadata();
        updateSettingsUi();
        safeToast('success', 'Tracker profile saved.');
    });

    refreshButton.addEventListener('click', () => {
        void refreshTrackedState('manual');
    });

    viewButton.addEventListener('click', () => {
        void openTrackerModal();
    });

    // ── Character → Profile binding ──
    document.getElementById('sst-char-map-bind')?.addEventListener('click', () => {
        const settings = getSettings();
        const charName = getCurrentCharName();
        if (!charName) { safeToast('warning', 'No character is currently loaded.'); return; }
        const profile = settings.activeProfile;
        settings.charProfileMap[charName] = profile;
        persistSettings();
        updateCharMapUi();
        safeToast('success', `"${charName}" will now auto-switch to profile "${profile}"`);
    });

    document.getElementById('sst-char-map-unbind')?.addEventListener('click', () => {
        const settings = getSettings();
        const charName = getCurrentCharName();
        if (!charName) { safeToast('warning', 'No character is currently loaded.'); return; }
        if (!settings.charProfileMap[charName]) { safeToast('warning', `No binding found for "${charName}".`); return; }
        delete settings.charProfileMap[charName];
        persistSettings();
        updateCharMapUi();
        safeToast('info', `Binding removed for "${charName}"`);
    });

    // ── Scene settings events ──
    const sceneEnabled  = document.getElementById('sst-scene-enabled');
    const sceneApiKey   = document.getElementById('sst-scene-api-key');
    const sceneModel    = document.getElementById('sst-scene-model');
    const sceneHint     = document.getElementById('sst-scene-stat-hint');
    const sceneStyle    = document.getElementById('sst-scene-style');
    const sceneOpenBtn  = document.getElementById('sst-scene-open');

    sceneEnabled?.addEventListener('change', () => {
        const settings = getSettings();
        settings.scene.enabled = sceneEnabled.checked;
        persistSettings();
    });

    sceneApiKey?.addEventListener('change', () => {
        const settings = getSettings();
        settings.scene.xaiApiKey = sceneApiKey.value.trim();
        persistSettings();
    });

    sceneModel?.addEventListener('change', () => {
        const settings = getSettings();
        settings.scene.model = sceneModel.value.trim() || 'grok-2-image';
        persistSettings();
    });

    sceneHint?.addEventListener('change', () => {
        const settings = getSettings();
        settings.scene.locationStatHint = sceneHint.value.trim() || 'location';
        persistSettings();
    });

    sceneStyle?.addEventListener('change', () => {
        const settings = getSettings();
        settings.scene.scenePrompt = sceneStyle.value.trim() || defaultSettings.scene.scenePrompt;
        persistSettings();
    });

    sceneOpenBtn?.addEventListener('click', () => {
        openSceneWindow();
    });

    document.getElementById('sst-scene-detect-model')?.addEventListener('click', async () => {
        const btn = document.getElementById('sst-scene-detect-model');
        const status = document.getElementById('sst-scene-model-status');
        const settings = getSettings();
        const apiKey = settings.scene.xaiApiKey;
        if (!apiKey) { safeToast('warning', 'Enter your xAI API key first.'); return; }
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
        if (status) status.textContent = 'Querying xAI…';
        try {
            const models = await fetchXaiModels(apiKey);
            if (models.length === 0) {
                if (status) status.textContent = 'No image models found on your account.';
                safeToast('warning', 'No image models found. Check your xAI API key.');
            } else {
                // Show all found models in status, pick first
                if (status) status.textContent = `Found: ${models.join(', ')}`;
                const sceneModel = document.getElementById('sst-scene-model');
                if (sceneModel) sceneModel.value = models[0];
                settings.scene.model = models[0];
                persistSettings();
                safeToast('success', `Model set to ${models[0]}`);
            }
        } catch (err) {
            if (status) status.textContent = `Error: ${err.message}`;
            safeToast('error', err.message);
        } finally {
            btn.disabled = false;
            btn.innerHTML = 'Detect';
        }
    });

    document.getElementById('sst-scene-gen-now')?.addEventListener('click', async () => {
        const settings = getSettings();
        // Save current textarea value first
        if (sceneStyle) {
            settings.scene.scenePrompt = sceneStyle.value.trim() || defaultSettings.scene.scenePrompt;
            persistSettings();
        }
        const locId = getLocationStatId();
        const loc   = locId ? (activeSnapshot.stats?.[locId]?.value || '') : '';
        if (!loc) { safeToast('warning', 'No location value tracked yet.'); return; }
        openSceneWindow();
        try {
            const result = await buildLocationImageDescription(loc);
            await renderSceneImage(result.description, result);
        } catch (err) {
            await renderSceneImage(loc, { locationValue: loc, messagesCount: 0, messagesText: '' });
        }
    });

    document.getElementById('sst-scene-template-select')?.addEventListener('change', (e) => {
        const settings = getSettings();
        settings.scene.activeTemplate = e.target.value;
        persistSettings();
    });

    document.getElementById('sst-scene-template-load')?.addEventListener('click', () => {
        const settings = getSettings();
        const name = document.getElementById('sst-scene-template-select')?.value || '';
        if (!name || !settings.scene.promptTemplates[name]) {
            safeToast('warning', 'Select a template first.'); return;
        }
        settings.scene.scenePrompt = settings.scene.promptTemplates[name];
        settings.scene.activeTemplate = name;
        persistSettings();
        if (sceneStyle) sceneStyle.value = settings.scene.scenePrompt || defaultSettings.scene.scenePrompt;
        safeToast('success', `Loaded template '${name}'.`);
    });

    document.getElementById('sst-scene-template-save')?.addEventListener('click', async () => {
        const settings = getSettings();
        const currentPrompt = sceneStyle?.value.trim() || '';
        if (!currentPrompt) { safeToast('warning', 'Write a prompt first.'); return; }
        const defaultName = settings.scene.activeTemplate || 'My template';
        const name = await promptInput('Save prompt template as', defaultName);
        if (!name) return;
        settings.scene.promptTemplates[name] = currentPrompt;
        settings.scene.scenePrompt = currentPrompt;
        settings.scene.activeTemplate = name;
        persistSettings();
        updateSceneTemplateUi();
        safeToast('success', `Saved template '${name}'.`);
    });

    document.getElementById('sst-scene-template-reset')?.addEventListener('click', async () => {
        const confirmed = await promptConfirm('Reset scene prompt to default?');
        if (!confirmed) return;
        const settings = getSettings();
        settings.scene.scenePrompt = defaultSettings.scene.scenePrompt;
        settings.scene.activeTemplate = '';
        persistSettings();
        const sceneStyle = document.getElementById('sst-scene-style');
        if (sceneStyle) sceneStyle.value = defaultSettings.scene.scenePrompt;
        updateSceneTemplateUi();
        safeToast('info', 'Scene prompt reset to default.');
    });

    document.getElementById('sst-scene-template-delete')?.addEventListener('click', async () => {
        const settings = getSettings();
        const name = document.getElementById('sst-scene-template-select')?.value || '';
        if (!name || !settings.scene.promptTemplates[name]) {
            safeToast('warning', 'Select a template first.'); return;
        }
        const confirmed = await promptConfirm(`Delete template '${name}'?`);
        if (!confirmed) return;
        delete settings.scene.promptTemplates[name];
        if (settings.scene.activeTemplate === name) settings.scene.activeTemplate = '';
        persistSettings();
        updateSceneTemplateUi();
        safeToast('info', `Deleted template '${name}'.`);
    });
}

// ─── JSON / LLM helpers ───────────────────────────────────────────────────────

function parseGeneratedJson(text) {
    if (typeof text !== 'string') return {};
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    try {
        return JSON.parse(cleaned);
    } catch (_error) {
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        if (start !== -1 && end > start) {
            try {
                return JSON.parse(cleaned.slice(start, end + 1));
            } catch (_error2) {
                return {};
            }
        }
        return {};
    }
}

function normalizeValue(value, maxLength) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function extractChatCompletionText(data) {
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(part => {
            if (typeof part === 'string') return part;
            if (typeof part?.text === 'string') return part.text;
            if (typeof part?.content === 'string') return part.content;
            return '';
        }).join('');
    }
    return '';
}

async function callTextModel(prompt) {
    // Like callTrackerModel but returns plain text — no json_object constraint
    const openRouter = getOpenRouterSettings();
    const apiKey = sanitizeApiKey(openRouter.apiKey);

    if (!apiKey) throw new Error('OpenRouter API key is missing.');
    if (!openRouter.modelId) throw new Error('OpenRouter model is not selected.');

    const payload = {
        model: openRouter.modelId,
        temperature: openRouter.temperature,
        max_completion_tokens: openRouter.maxCompletionTokens,
        stream: false,
        messages: [
            {
                role: 'system',
                content: 'You are a precise scene describer. Follow the user instructions exactly. Use only the context provided. Do not invent generic landscapes. Do not add markdown formatting.',
            },
            {
                role: 'user',
                content: prompt,
            },
        ],
    };

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': globalThis.location?.origin || 'http://localhost',
            'X-OpenRouter-Title': 'Simple Stat Tracker',
        },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        if (response.status === 401) throw new Error('OpenRouter rejected the API key.');
        if (response.status === 402) throw new Error('OpenRouter: insufficient credits.');
        throw new Error(`OpenRouter call failed (${response.status})${text ? ': ' + text.slice(0, 260) : ''}`);
    }

    const data = await response.json();
    return extractChatCompletionText(data) || '';
}

async function callTrackerModel(prompt) {
    const openRouter = getOpenRouterSettings();
    const apiKey = sanitizeApiKey(openRouter.apiKey);

    if (!apiKey) throw new Error('OpenRouter API key is missing.');
    if (!openRouter.modelId) throw new Error('OpenRouter model is not selected.');

    const payload = {
        model: openRouter.modelId,
        temperature: openRouter.temperature,
        max_completion_tokens: openRouter.maxCompletionTokens,
        stream: false,
        response_format: { type: 'json_object' },
        messages: [
            {
                role: 'system',
                content: 'You are a compact state tracker. Return JSON only. No markdown. No prose. No explanation.',
            },
            {
                role: 'user',
                content: prompt,
            },
        ],
    };

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': globalThis.location?.origin || 'http://localhost',
            'X-OpenRouter-Title': 'Simple Stat Tracker',
        },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        if (response.status === 401) {
            throw new Error('OpenRouter rejected the API key. Paste the raw sk-or-v1 key only.');
        }
        if (response.status === 402) {
            throw new Error('OpenRouter: insufficient credits.');
        }
        throw new Error(`OpenRouter chat completion failed with status ${response.status}${text ? `: ${text.slice(0, 260)}` : ''}`);
    }

    const data = await response.json();
    return extractChatCompletionText(data) || '{}';
}

// ─── Refresh logic ────────────────────────────────────────────────────────────

async function refreshTrackedState(reason = 'auto') {
    const settings = getSettings();

    if (!settings.enabled) {
        if (reason === 'manual') safeToast('warning', 'Simple Stat Tracker is disabled.');
        return;
    }

    const definitions = getDefinitions();
    const recentMessages = getRecentMessages(settings.recentMessageCount);

    if (definitions.length === 0) {
        if (reason === 'manual') safeToast('warning', 'No tracked stats defined in the active profile.');
        return;
    }

    if (recentMessages.length === 0) {
        if (reason === 'manual') safeToast('warning', 'No recent chat messages to inspect.');
        return;
    }

    if (refreshInFlight) {
        refreshQueued = true;
        return refreshInFlight;
    }

    const previousState = Object.fromEntries(
        definitions.map(def => [def.id, activeSnapshot.stats?.[def.id]?.value || ''])
    );

    const prompt = JSON.stringify({
        task: 'Update the tracked roleplay state from the recent chat excerpt only.',
        rules: [
            'Return one short string value for every stat id.',
            'Keep the prior value if the excerpt does not clearly change it.',
            'Do not invent details not supported by the excerpt.',
            'Never output null. Use an empty string if necessary.',
            'Return valid JSON only. No markdown. No explanation.',
        ],
        tracked_stats: definitions.map(def => ({ id: def.id, label: def.label })),
        previous_state: previousState,
        recent_messages: recentMessages,
    }, null, 2);

    refreshInFlight = (async () => {
        try {
            const raw = await callTrackerModel(prompt);
            const parsed = parseGeneratedJson(raw);
            let changed = false;

            // Snapshot previous stats for location change detection
            const previousStats = clone(activeSnapshot.stats || {});

            for (const definition of definitions) {
                if (!activeSnapshot.stats[definition.id]) {
                    activeSnapshot.stats[definition.id] = {
                        template: definition.template,
                        label: definition.label,
                        value: '',
                    };
                }

                activeSnapshot.stats[definition.id].template = definition.template;
                activeSnapshot.stats[definition.id].label = definition.label;

                const nextValue = Object.prototype.hasOwnProperty.call(parsed, definition.id)
                    ? normalizeValue(parsed[definition.id], settings.maxValueLength)
                    : activeSnapshot.stats[definition.id].value;

                if (activeSnapshot.stats[definition.id].value !== nextValue) {
                    activeSnapshot.stats[definition.id].value = nextValue;
                    changed = true;
                }
            }

            activeSnapshot.updatedAt = new Date().toISOString();
            writeSnapshot();
            await persistMetadata();
            updateTrackerModal();

            // Check if location changed → generate new scene image
            void checkLocationChange(previousStats);

            if (reason === 'manual') {
                safeToast('info', changed ? 'Tracker state refreshed.' : 'Tracker state unchanged.');
            }
        } catch (error) {
            console.error('Simple Stat Tracker refresh failed.', error);
            safeToast('error', error?.message || 'Tracker refresh failed. Check the browser console.');
        } finally {
            refreshInFlight = null;
            if (refreshQueued) {
                refreshQueued = false;
                void refreshTrackedState('queued');
            }
        }
    })();

    return refreshInFlight;
}

function scheduleRefresh(reason = 'auto') {
    const settings = getSettings();
    if (!settings.enabled) return;
    if (reason === 'auto' && !settings.autoRefresh) return;

    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
        void refreshTrackedState(reason);
    }, 350);
}

// ─── Prompt injection ─────────────────────────────────────────────────────────

function buildInjectionNote() {
    const settings = getSettings();
    if (!settings.enabled || !settings.injectTrackedState) return '';

    const lines = [];
    for (const definition of getDefinitions()) {
        const value = activeSnapshot.stats?.[definition.id]?.value;
        if (value && value.trim()) {
            lines.push(`${definition.label}: ${value}`);
        }
    }

    if (lines.length === 0) return '';
    return `[TRACKED STATE | ${getActiveProfileName()}]\n${lines.join('\n')}`;
}

function injectTrackerData(payload) {
    if (!Array.isArray(payload)) return;
    const note = buildInjectionNote();
    if (!note) return;
    payload.push({
        role: 'system',
        content: note,
        extension: extensionName,
    });
}

// ─── Events & boot ────────────────────────────────────────────────────────────

function syncSnapshot() {
    activeSnapshot = buildSnapshot();
    updateTrackerModal();
}

function registerEvents() {
    const context = getContext();
    const source = context.eventSource;
    const types = context.event_types;
    if (!source || !types) throw new Error('eventSource or event_types missing.');

    source.on(types.CHAT_CHANGED, () => {
        autoSwitchProfile();   // switch to mapped profile before syncing
        syncSnapshot();
        updateSettingsUi();
    });

    source.on(types.MESSAGE_RECEIVED, () => {
        scheduleRefresh('auto');
    });

    if (types.MESSAGE_EDITED) {
        source.on(types.MESSAGE_EDITED, () => scheduleRefresh('auto'));
    }
    if (types.MESSAGE_SWIPED) {
        source.on(types.MESSAGE_SWIPED, () => scheduleRefresh('auto'));
    }
    if (types.MESSAGE_DELETED) {
        source.on(types.MESSAGE_DELETED, () => scheduleRefresh('auto'));
    }
    if (types.CHAT_COMPLETION_PROMPT_READY) {
        source.on(types.CHAT_COMPLETION_PROMPT_READY, payload => {
            if (payload?.chat) injectTrackerData(payload.chat);
        });
    }
}

function boot() {
    if (booted) return;
    booted = true;

    // ── One-time migration: clear stale 'aurora' model name from any saved settings ──
    try {
        const rawLocal = localStorage.getItem(localSettingsKey);
        if (rawLocal) {
            const parsed = JSON.parse(rawLocal);
            const staleModels = ['aurora', 'grok-2-image'];
            if (staleModels.includes(parsed?.[extensionName]?.scene?.model)) {
                parsed[extensionName].scene.model = '';
            }
            // Reset scenePrompt if it has no {messages} placeholder (stale style-hint string)
            const sp = parsed?.[extensionName]?.scene?.scenePrompt;
            if (sp !== undefined && !sp.includes('{messages}')) {
                parsed[extensionName].scene.scenePrompt = defaultSettings.scene.scenePrompt;
            }
            localStorage.setItem(localSettingsKey, JSON.stringify(parsed));
        }
        // Also patch extensionSettings if accessible
        const ctx = globalThis.SillyTavern?.getContext?.();
        if (['aurora', 'grok-2-image'].includes(ctx?.extensionSettings?.[extensionName]?.scene?.model)) {
            ctx.extensionSettings[extensionName].scene.model = '';
        }
    } catch (_) {}

    getSettings();
    ensureSettingsPanel();
    ensureTrackerButton();
    ensureSceneWindow();
    bindSettingsEvents();
    syncSnapshot();
    updateSettingsUi();
    registerEvents();
}

boot();
