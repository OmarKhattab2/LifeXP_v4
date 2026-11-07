// script.js
/**
 * LIFEXP // OS PROD v1.0
 * Clean Production Build with robust logic and local storage limiters.
 */

const STORAGE_KEY = 'lifexp_os_prod_v1';
const LEVELS = [0, 100, 250, 450, 700, 1000, 1400, 1900, 2500, 3200];

// --- AUDIO SYSTEM ---
let audioCtx = null;
let sfxEnabled = true;

function playSfx(type) {
    if (!sfxEnabled) return;
    try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();
        const now = audioCtx.currentTime;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(audioCtx.destination);

        if (type === 'click') {
            osc.type = 'square';
            osc.frequency.setValueAtTime(400, now);
            osc.frequency.exponentialRampToValueAtTime(100, now + 0.05);
            gain.gain.setValueAtTime(0.05, now);
            gain.gain.linearRampToValueAtTime(0.001, now + 0.05);
            osc.start(now);
            osc.stop(now + 0.05);
        } else if (type === 'success') {
            osc.type = 'sine';
            osc.frequency.setValueAtTime(800, now);
            osc.frequency.setValueAtTime(1200, now + 0.1);
            gain.gain.setValueAtTime(0.08, now);
            gain.gain.linearRampToValueAtTime(0.001, now + 0.2);
            osc.start(now);
            osc.stop(now + 0.2);
        }
    } catch (e) {
        console.warn("Audio playback failed:", e);
    }
}

window.toggleAudio = function () {
    sfxEnabled = !sfxEnabled;
    state.uiSettings.sfxOn = sfxEnabled;
    saveState();
    updateAudioUI();
    if (sfxEnabled) playSfx('click');
};

function updateAudioUI() {
    const statusEl = document.getElementById('sfx-status');
    const toggleEl = document.getElementById('sfx-toggle');
    if (statusEl && toggleEl) {
        statusEl.textContent = sfxEnabled ? 'SND: ON' : 'SND: OFF';
        toggleEl.style.color = sfxEnabled ? 'var(--c-text-main)' : 'var(--c-danger)';
    }
}

// --- STATE MANAGEMENT ---
let state = {
    profile: { name: 'OPERATIVE', level: 1, xp: 0, coins: 0 },
    quests: [],
    store: [],
    inventory: [],
    transactions: [],
    achievements: [],
    stats: { completedQuests: 0, totalEarned: 0, totalSpent: 0 },
    uiSettings: { lastView: 'dashboard', sfxOn: true, questFilter: 'all' }
};

const sysAchievements = [
    { id: 'A_01', title: 'العملية الأولى', desc: 'تم إنجاز وتوثيق أول عملية ميدانية بنجاح.', condition: (s) => s.stats.completedQuests >= 1 },
    { id: 'A_02', title: 'استمرارية تكتيكية', desc: 'تم إنجاز 10 مهام معتمدة.', condition: (s) => s.stats.completedQuests >= 10 },
    { id: 'A_03', title: 'رصيد مؤمّن', desc: 'تم جمع 500 وحدة مالية إجمالاً.', condition: (s) => s.stats.totalEarned >= 500 }
];

function generateId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// --- PERSISTENCE LAYER ---
// Primary store : localStorage (synchronous, same key as before -> old data is read as-is).
// Mirror store  : IndexedDB (durable second copy, used to recover if localStorage is wiped/corrupted).
// Safety rules  : (1) state is never written until the stored data has been read first,
//                 (2) unreadable data is quarantined, never overwritten,
//                 (3) the copy with the highest revision wins at startup.
const BACKUP_KEY = STORAGE_KEY + '_bak';
const CORRUPT_PREFIX = STORAGE_KEY + '_corrupt_';
const IDB_NAME = 'lifexp_db';
const IDB_STORE = 'kv';
const IDB_RECORD = 'state';

let storageReady = false;   // saves are blocked until the persisted data was read
let idbUsable = false;      // true once IndexedDB opened successfully
let idbHandle = null;
let lastPersistError = null;

function defaultState() {
    return {
        profile: { name: 'OPERATIVE', level: 1, xp: 0, coins: 0 },
        quests: [],
        store: [],
        inventory: [],
        transactions: [],
        achievements: [],
        stats: { completedQuests: 0, totalEarned: 0, totalSpent: 0 },
        uiSettings: { lastView: 'dashboard', sfxOn: true, questFilter: 'all' }
    };
}

// Fills in any missing section WITHOUT touching values that already exist.
function normalizeState(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const d = defaultState();
    const s = raw;
    if (!Array.isArray(s.quests)) s.quests = [];
    if (!Array.isArray(s.store)) s.store = [];
    if (!Array.isArray(s.inventory)) s.inventory = [];
    if (!Array.isArray(s.transactions)) s.transactions = [];
    if (!Array.isArray(s.achievements)) s.achievements = [];
    if (!s.profile || typeof s.profile !== 'object') s.profile = d.profile;
    if (typeof s.profile.name !== 'string') s.profile.name = d.profile.name;
    ['level', 'xp', 'coins'].forEach(k => {
        const n = Number(s.profile[k]);
        s.profile[k] = Number.isFinite(n) ? n : d.profile[k];
    });
    if (s.profile.level < 1) s.profile.level = 1;
    if (!s.stats || typeof s.stats !== 'object') s.stats = d.stats;
    ['completedQuests', 'totalEarned', 'totalSpent'].forEach(k => {
        const n = Number(s.stats[k]);
        s.stats[k] = Number.isFinite(n) ? n : 0;
    });
    if (!s.uiSettings || typeof s.uiSettings !== 'object') s.uiSettings = d.uiSettings;
    if (!s._meta || typeof s._meta !== 'object') s._meta = { rev: 0, savedAt: 0 };
    s._meta.rev = Number(s._meta.rev) || 0;
    s._meta.savedAt = Number(s._meta.savedAt) || 0;
    return s;
}

function parseStored(text) {
    if (typeof text !== 'string' || !text) return null;
    try { return normalizeState(JSON.parse(text)); } catch (e) { return null; }
}

function isNewer(a, b) { // is record a newer than record b?
    if (!a) return false;
    if (!b) return true;
    if (a._meta.rev !== b._meta.rev) return a._meta.rev > b._meta.rev;
    return a._meta.savedAt > b._meta.savedAt;
}

function lsGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return undefined; } // undefined = storage unreachable
}

function quarantine(raw) {
    // keep an unreadable payload for manual recovery instead of overwriting it
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith(CORRUPT_PREFIX) && localStorage.getItem(k) === raw) return; // already kept
        }
        localStorage.setItem(CORRUPT_PREFIX + Date.now(), raw);
    } catch (e) { /* nothing more we can do */ }
}

// --- IndexedDB helpers (all failures are swallowed: localStorage keeps working on its own) ---
function idbOpen() {
    return new Promise((resolve) => {
        try {
            if (!('indexedDB' in window) || !window.indexedDB) return resolve(null);
            const req = indexedDB.open(IDB_NAME, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
            };
            req.onsuccess = () => {
                const db = req.result;
                db.onversionchange = () => { try { db.close(); } catch (e) { } idbHandle = null; idbUsable = false; };
                resolve(db);
            };
            req.onerror = () => resolve(null);
            req.onblocked = () => resolve(null);
        } catch (e) { resolve(null); }
    });
}

function idbGetRecord(db) {
    return new Promise((resolve) => {
        try {
            const tx = db.transaction(IDB_STORE, 'readonly');
            const r = tx.objectStore(IDB_STORE).get(IDB_RECORD);
            r.onsuccess = () => resolve(typeof r.result === 'string' ? r.result : null);
            r.onerror = () => resolve(null);
            tx.onabort = () => resolve(null);
        } catch (e) { resolve(null); }
    });
}

function idbPutRecord(text) {
    if (!idbHandle) return;
    try {
        const tx = idbHandle.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(text, IDB_RECORD);
        tx.onerror = tx.onabort = () => console.warn('IndexedDB mirror write failed:', tx.error);
    } catch (e) {
        console.warn('IndexedDB mirror write failed:', e);
    }
}

function idbClearRecord() {
    return new Promise((resolve) => {
        if (!idbHandle) return resolve();
        try {
            const tx = idbHandle.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).delete(IDB_RECORD);
            tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
        } catch (e) { resolve(); }
    });
}

// Synchronous part of loading: reads localStorage (main copy, then rolling backup).
// Never writes anything.
function loadFromLocalStorage() {
    const main = lsGet(STORAGE_KEY);
    if (main === undefined) { lastPersistError = 'localStorage unavailable'; return { found: null, reachable: false }; }
    if (main !== null) {
        const parsed = parseStored(main);
        if (parsed) return { found: parsed, reachable: true };
        console.error('Stored state is unreadable; keeping a quarantined copy and trying backups.');
        quarantine(main);
    }
    const bak = lsGet(BACKUP_KEY);
    const parsedBak = parseStored(bak);
    if (parsedBak) return { found: parsedBak, reachable: true, fromBackup: true };
    return { found: null, reachable: true };
}

function writeLocal(text) {
    try {
        const prev = localStorage.getItem(STORAGE_KEY);
        if (prev && prev !== text) {
            if (parseStored(prev)) {
                try { localStorage.setItem(BACKUP_KEY, prev); } catch (e) { /* backup is best-effort */ }
            } else {
                quarantine(prev); // unreadable data is never copied over the good backup and never silently destroyed
            }
        }
        localStorage.setItem(STORAGE_KEY, text);
        return true;
    } catch (e) {
        lastPersistError = e;
        console.error('CRITICAL I/O ERROR: LocalStorage write blocked.', e);
        return false;
    }
}

function persistNow() {
    const text = JSON.stringify(state);
    const ok = writeLocal(text);
    idbPutRecord(text);
    return ok;
}

function loadState() {
    const res = loadFromLocalStorage();
    if (res.found) {
        state = res.found;
        storageReady = true;            // we have real data -> safe to save
        if (res.fromBackup) persistNow(); // main copy was lost: restore it from the backup
    } else {
        state = normalizeState(defaultState()); // placeholder only; NOT saved until IndexedDB was checked
    }
    return res;
}

function saveState() {
    if (!storageReady) {
        // Never let a default/placeholder state overwrite data that has not been read yet.
        console.warn('saveState skipped: persisted data not loaded yet.');
        return false;
    }
    try {
        if (state.transactions.length > 100) {
            state.transactions = state.transactions.slice(-100); // keep the NEWEST 100 (new entries are appended)
        }
        if (!state._meta) state._meta = { rev: 0, savedAt: 0 };
        state._meta.rev += 1;
        state._meta.savedAt = Date.now();
        const localOk = persistNow();
        return localOk || idbUsable;
    } catch (e) {
        console.error('saveState failed:', e);
        return false;
    }
}

// Opens IndexedDB, compares it with what localStorage gave us and keeps the newest copy.
// Resolves with true when the in-memory state was replaced by the IndexedDB copy.
async function reconcileWithIndexedDB() {
    const db = await idbOpen();
    if (!db) return false;
    idbHandle = db;
    idbUsable = true;
    const fromIdb = parseStored(await idbGetRecord(db));
    let adopted = false;
    if (fromIdb && (!storageReady || isNewer(fromIdb, state))) {
        state = fromIdb;
        storageReady = true;
        persistNow();
        adopted = true;
    } else if (!storageReady) {
        storageReady = true;            // nothing stored anywhere: genuinely a first run
    } else {
        idbPutRecord(JSON.stringify(state)); // make sure the mirror has the current data
    }
    return adopted;
}

// Asks the browser not to evict this origin's storage under pressure (best-effort).
async function requestPersistentStorage() {
    try {
        if (navigator.storage && navigator.storage.persist) {
            const already = navigator.storage.persisted ? await navigator.storage.persisted() : false;
            if (!already) await navigator.storage.persist();
        }
    } catch (e) { /* not supported / denied: ignore */ }
}

// Data is read here, at script start, BEFORE any UI handler can fire (the old code waited for window "load").
const bootLoad = loadState();
const storageBootPromise = (async () => {
    let replaced = false;
    try { replaced = await reconcileWithIndexedDB(); } catch (e) { console.warn('IndexedDB reconcile failed:', e); }
    if (!storageReady && bootLoad.reachable === false) {
        // storage is blocked entirely: run in memory so the app is still usable
        storageReady = true;
    }
    return replaced;
})();

// Flush on every way the app can go away (installed PWAs are often killed while in background).
function flushState() { if (storageReady) persistNow(); }
window.addEventListener('pagehide', flushState);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushState(); });

// --- NAVIGATION ---
let currentFilter = 'all';

document.querySelectorAll('.mech-nav-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        playSfx('click');
        navigateMain(e.currentTarget.getAttribute('data-target'), true);
    });
});

document.querySelectorAll('.profile-module-card, .profile-system-item').forEach(btn => {
    btn.addEventListener('click', (e) => {
        playSfx('click');
        navigateSub(e.currentTarget.getAttribute('data-sub'), true);
    });
});

document.querySelectorAll('[data-back]').forEach(btn => {
    btn.addEventListener('click', (e) => {
        playSfx('click');
        navigateMain(e.currentTarget.getAttribute('data-back'), true);
    });
});

document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        playSfx('click');
        const filter = e.currentTarget.getAttribute('data-filter');
        currentFilter = filter;

        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        e.currentTarget.classList.add('active');

        state.uiSettings.questFilter = filter;
        saveState();
        renderQuests();
    });
});

function navigateMain(target, recordHistory = false) {
    document.querySelectorAll('.mech-nav-btn').forEach(b => b.classList.remove('active'));
    const btn = document.querySelector(`.mech-nav-btn[data-target="${target}"]`);
    if (btn) btn.classList.add('active');

    document.querySelectorAll('.sys-view').forEach(v => {
        v.classList.remove('active');
        v.classList.add('hidden');
    });
    const view = document.getElementById(target);
    if (view) {
        view.classList.remove('hidden');
        view.classList.add('active');
    }

    if (recordHistory) {
        state.uiSettings.lastView = target;
        saveState();
    }
    window.scrollTo(0, 0);
}

function navigateSub(target, recordHistory = true) {
    document.querySelectorAll('.sys-view').forEach(v => {
        v.classList.remove('active');
        v.classList.add('hidden');
    });
    const view = document.getElementById(target);
    if (view) {
        view.classList.remove('hidden');
        view.classList.add('active');
    }
    if (target === 'stats') renderStats();

    if (recordHistory) {
        state.uiSettings.lastView = target;
        saveState();
    }
    window.scrollTo(0, 0);
}

// --- RENDER ENGINE ---
function updateUI() {
    renderDashboard();
    renderQuests();
    renderApprovals();
    renderStore();
    renderInventory();
    renderWallet();
    renderAchievements();
    checkLvlUp();
    checkAchieve();

    const pCount = state.quests.filter(q => q.status === 'pending').length;
    const badge1 = document.getElementById('pending-badge');
    const badge2 = document.getElementById('menu-pending-badge');
    if (pCount > 0) {
        if (badge1) badge1.classList.remove('hidden');
        if (badge2) badge2.classList.remove('hidden');
    } else {
        if (badge1) badge1.classList.add('hidden');
        if (badge2) badge2.classList.add('hidden');
    }
}

function renderDashboard() {
    const p = state.profile;
    document.querySelectorAll('#player-name-display').forEach(el => el.textContent = p.name);

    const settingName = document.getElementById('setting-name');
    if (settingName) settingName.value = p.name;

    const dashLevel = document.getElementById('dash-level');
    if (dashLevel) dashLevel.textContent = p.level < 10 ? `0${p.level}` : p.level;

    const dashXp = document.getElementById('dash-xp');
    if (dashXp) dashXp.textContent = p.xp;

    const dashCoins = document.getElementById('dash-coins');
    if (dashCoins) dashCoins.textContent = p.coins;

    const dashCompleted = document.getElementById('dash-completed');
    if (dashCompleted) dashCompleted.textContent = state.stats.completedQuests;

    const profileCoins = document.getElementById('profile-coins');
    if (profileCoins) profileCoins.textContent = p.coins;

    const profilePending = document.getElementById('profile-pending');
    if (profilePending) profilePending.textContent = state.quests.filter(q => q.status === 'pending').length;

    const actQ = state.quests.find(q => q.status === 'available');
    const briefingTitle = document.getElementById('briefing-title-dynamic');
    if (briefingTitle) briefingTitle.textContent = actQ ? actQ.title : 'لا توجد مهام بانتظار الإنجاز';

    const nextXp = LEVELS[p.level] || (LEVELS[LEVELS.length - 1] + (p.level - 9) * 1000);
    const prevXp = LEVELS[p.level - 1] || 0;

    const nextXpEl = document.getElementById('dash-next-xp');
    if (nextXpEl) nextXpEl.textContent = nextXp;

    let prog = nextXp > prevXp ? ((p.xp - prevXp) / (nextXp - prevXp)) * 100 : 100;
    const xpFill = document.getElementById('dash-xp-fill');
    if (xpFill) xpFill.style.width = `${Math.min(Math.max(prog, 0), 100)}%`;

    const feed = document.getElementById('dash-overview');
    if (feed) {
        const rx = [...state.transactions].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 4);
        if (rx.length === 0) {
            feed.innerHTML = `<li class="text-muted">NO LOGS DETECTED.</li>`;
        } else {
            feed.innerHTML = rx.map(tx => `
                <li>
                    <span>${tx.desc}</span>
                    <span class="eng-text ${tx.amount > 0 ? 'text-green' : 'text-red'}">${tx.amount > 0 ? '+' : ''}${tx.amount} CR</span>
                </li>
            `).join('');
        }
    }
}

// -- QUESTS --
function renderQuests() {
    const container = document.getElementById('quests-container');
    if (!container) return;

    let qList = state.quests.filter(q => q.status === 'available');
    if (currentFilter !== 'all') qList = qList.filter(q => q.category === currentFilter);

    if (qList.length === 0) {
        container.innerHTML = `<div class="empty-state eng-text text-muted">NO ACTIVE DIRECTIVES.</div>`;
        return;
    }

    container.innerHTML = qList.map(q => `
        <div class="data-card">
            <div class="card-media">
                <div class="eng-text text-muted" style="font-size: 2rem;">{ OP }</div>
                <span class="card-tag eng-text" style="color:var(--c-${q.diff === 'Easy' ? 'green' : q.diff === 'Medium' ? 'gold' : q.diff === 'Hard' ? 'accent' : 'danger'}); border-color:currentColor;">THREAT_${q.diff.toUpperCase()}</span>
            </div>
            <div class="card-body">
                <h3 class="card-title">${q.title}</h3>
                <div class="card-bounty eng-text">
                    <span class="bounty-item text-gold">REWARD: ${q.coins} CR</span>
                    <span class="bounty-item text-accent">EXP: ${q.xp}</span>
                </div>
                <div class="action-group">
                    <button class="solid-btn primary-btn w-full" onclick="submitQuest('${q.id}')"><span class="btn-text">إنجاز</span></button>
                    <button class="solid-btn danger-btn" onclick="deleteQuest('${q.id}')" aria-label="Delete">X</button>
                </div>
            </div>
        </div>
    `).join('');
}

window.openQuestModal = function () {
    document.getElementById('q-title').value = '';
    document.getElementById('q-coins').value = '50';
    document.getElementById('q-xp').value = '30';
    showModal('quest-modal');
};

window.saveQuest = async function () {
    const btn = document.querySelector('#quest-modal .primary-btn');
    const originalText = btn ? btn.innerHTML : '<span class="btn-text">تسجيل وتأكيد</span>';

    try {
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<span class="btn-text">جاري المعالجة...</span>';
        }
        await new Promise(resolve => setTimeout(resolve, 150));

        const titleEl = document.getElementById('q-title');
        const catEl = document.getElementById('q-category');
        const diffEl = document.getElementById('q-diff');
        const coinsEl = document.getElementById('q-coins');
        const xpEl = document.getElementById('q-xp');

        const t = titleEl.value.trim();
        if (!t) {
            showToast('DATA ERROR: TITLE REQUIRED', 'danger');
            return;
        }

        const newQuest = {
            id: generateId(),
            title: t,
            category: catEl.value,
            diff: diffEl.value,
            coins: Math.max(0, parseInt(coinsEl.value, 10) || 0),
            xp: Math.max(0, parseInt(xpEl.value, 10) || 0),
            status: 'available',
            date: new Date().toISOString()
        };

        state.quests.unshift(newQuest);
        if (!saveState()) {
            state.quests.shift();
            throw new Error("Storage validation failed");
        }

        playSfx('success');
        hideModal('quest-modal');
        showToast('DIRECTIVE ADDED', 'success');
        updateUI();
    } catch (error) {
        showToast('SYSTEM ERROR: FAILED TO SAVE', 'danger');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalText;
        }
    }
};

window.submitQuest = function (id) {
    const q = state.quests.find(x => x.id === id);
    if (q && q.status === 'available') {
        q.status = 'pending';
        playSfx('click');
        saveState();
        showToast('AWAITING AUTH', 'success');
        updateUI();
    }
};

window.deleteQuest = function (id) {
    if (confirm('تحذير النظام: هل أنت متأكد من مسح هذه العملية نهائياً؟')) {
        state.quests = state.quests.filter(q => q.id !== id);
        saveState();
        playSfx('click');
        showToast('DIRECTIVE DELETED', 'success');
        updateUI();
    }
};

// -- APPROVALS --
function renderApprovals() {
    const container = document.getElementById('approvals-container');
    if (!container) return;

    const p = state.quests.filter(q => q.status === 'pending');
    if (p.length === 0) {
        container.innerHTML = `<div class="empty-state eng-text text-muted">ALL CLEAR. NO PENDING TASKS.</div>`;
        return;
    }

    container.innerHTML = p.map(q => `
        <div class="data-card" style="border-color:var(--c-gold);">
            <div class="card-body">
                <div class="eng-text text-gold" style="font-size:0.75rem; margin-bottom:5px;">PENDING_AUTH // TSK_${q.id}</div>
                <h3 class="card-title">${q.title}</h3>
                <div class="card-bounty eng-text">
                    <span class="bounty-item text-gold">CR: +${q.coins}</span>
                    <span class="bounty-item text-accent">EXP: +${q.xp}</span>
                </div>
                <div style="display:flex; gap:10px;">
                    <button class="solid-btn outline-btn w-full" style="color:var(--c-green); border-color:var(--c-green);" onclick="appQ('${q.id}')">APPROVE</button>
                    <button class="solid-btn danger-btn w-full" onclick="rejQ('${q.id}')">REJECT</button>
                </div>
            </div>
        </div>
    `).join('');
}

window.appQ = function (id) {
    const q = state.quests.find(x => x.id === id);
    if (q && q.status === 'pending') {
        q.status = 'completed';
        state.profile.coins += q.coins;
        state.profile.xp += q.xp;
        state.stats.completedQuests++;
        state.stats.totalEarned += q.coins;
        state.transactions.push({ id: generateId(), desc: `AUTH: ${q.title}`, amount: q.coins, date: new Date().toISOString() });

        playSfx('success');
        checkLvlUp();
        saveState();
        showToast(`FUNDS DEPOSITED: +${q.coins} CR`, 'success');
        updateUI();
    }
};

window.rejQ = function (id) {
    const q = state.quests.find(x => x.id === id);
    if (q && q.status === 'pending') {
        q.status = 'available';
        playSfx('click');
        saveState();
        showToast('AUTH REJECTED', 'danger');
        updateUI();
    }
};

// -- STORE & INV --
function renderStore() {
    const container = document.getElementById('store-container');
    if (!container) return;

    if (state.store.length === 0) {
        container.innerHTML = `<div class="empty-state eng-text text-muted">MARKET OFFLINE. ADD ITEMS.</div>`;
        return;
    }

    container.innerHTML = state.store.map(r => `
        <div class="data-card">
            <div class="card-media">
                 <div class="eng-text text-muted" style="font-size: 2rem;">[+]</div>
                <span class="card-tag eng-text" style="color:var(--c-gold); border-color:var(--c-gold);">${r.price} CR</span>
            </div>
            <div class="card-body">
                <h3 class="card-title">${r.title}</h3>
                <div class="action-group">
                    <button class="solid-btn outline-btn w-full" onclick="buyR('${r.id}')"><span class="btn-text">PURCHASE</span></button>
                    <button class="solid-btn danger-btn" onclick="deleteReward('${r.id}')" aria-label="Delete">X</button>
                </div>
            </div>
        </div>
    `).join('');
}

window.openRewardModal = function () {
    document.getElementById('r-title').value = '';
    document.getElementById('r-price').value = '150';
    showModal('reward-modal');
};

window.saveReward = async function () {
    const btn = document.querySelector('#reward-modal .primary-btn');
    const originalText = btn ? btn.innerHTML : '<span class="btn-text">إدراج بالسوق</span>';

    try {
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<span class="btn-text">جاري المعالجة...</span>';
        }
        await new Promise(resolve => setTimeout(resolve, 150));

        const titleEl = document.getElementById('r-title');
        const priceEl = document.getElementById('r-price');

        const t = titleEl.value.trim();
        const p = parseInt(priceEl.value, 10) || 0;

        if (!t || p <= 0) {
            showToast('INVALID PARAMS', 'danger');
            return;
        }

        const newReward = { id: generateId(), title: t, price: p };
        state.store.push(newReward);

        if (!saveState()) {
            state.store.pop();
            throw new Error("Storage validation failed");
        }

        playSfx('success');
        hideModal('reward-modal');
        showToast('ASSET LISTED', 'success');
        updateUI();
    } catch (error) {
        showToast('SYSTEM ERROR: FAILED TO SAVE', 'danger');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalText;
        }
    }
};

window.buyR = function (id) {
    const r = state.store.find(x => x.id === id);
    if (!r) return;

    if (state.profile.coins >= r.price) {
        state.profile.coins -= r.price;
        state.stats.totalSpent += r.price;
        state.inventory.unshift({ id: generateId(), title: r.title, price: r.price, status: 'unused', date: new Date().toISOString() });
        state.transactions.push({ id: generateId(), desc: `BUY: ${r.title}`, amount: -r.price, date: new Date().toISOString() });

        playSfx('success');
        saveState();
        showToast('ASSET ACQUIRED', 'success');
        updateUI();
    } else {
        showToast('INSUFFICIENT FUNDS', 'danger');
    }
};

window.deleteReward = function (id) {
    if (confirm('تحذير النظام: هل أنت متأكد من مسح هذه المكافأة من السوق؟')) {
        state.store = state.store.filter(r => r.id !== id);
        saveState();
        playSfx('click');
        showToast('ASSET REMOVED', 'success');
        updateUI();
    }
};

function renderInventory() {
    const container = document.getElementById('inventory-container');
    if (!container) return;

    if (state.inventory.length === 0) {
        container.innerHTML = `<div class="empty-state eng-text text-muted">STORAGE EMPTY.</div>`;
        return;
    }

    container.innerHTML = state.inventory.map(i => `
        <div class="data-card" style="${i.status === 'redeemed' ? 'opacity:0.4; filter:grayscale(1);' : ''}">
            <div class="card-body">
                <div class="eng-text text-muted" style="font-size:0.75rem; margin-bottom:10px;">ID: ${i.id} // ${i.status.toUpperCase()}</div>
                <h3 class="card-title">${i.title}</h3>
                ${i.status === 'unused' ? `<button class="solid-btn primary-btn w-full mt-2" onclick="useI('${i.id}')"><span class="btn-text">CONSUME</span></button>` : ''}
            </div>
        </div>
    `).join('');
}

window.useI = function (id) {
    const i = state.inventory.find(x => x.id === id);
    if (i && i.status === 'unused') {
        i.status = 'redeemed';
        playSfx('click');
        saveState();
        showToast('ASSET CONSUMED', 'success');
        updateUI();
    }
};

function renderWallet() {
    const balEl = document.getElementById('wallet-balance');
    if (balEl) balEl.textContent = state.profile.coins;

    const c = document.getElementById('transactions-container');
    if (!c) return;

    const sorted = [...state.transactions].sort((a, b) => new Date(b.date) - new Date(a.date));
    if (sorted.length === 0) {
        c.innerHTML = `<div class="empty-state eng-text text-muted">NO RECORDS.</div>`;
        return;
    }

    c.innerHTML = `<ul class="data-feed">` + sorted.map(tx => `
        <li>
            <div>
                <div style="font-weight:bold;">${tx.desc}</div>
                <div style="font-size:0.7rem; color:var(--c-text-muted);">${new Date(tx.date).toLocaleDateString()}</div>
            </div>
            <span class="eng-text ${tx.amount > 0 ? 'text-green' : 'text-red'}" style="font-weight:bold;">${tx.amount > 0 ? '+' : ''}${tx.amount} CR</span>
        </li>
    `).join('') + `</ul>`;
}

// -- STATS & ACHV --
function renderStats() {
    const taskEl = document.getElementById('stats-tasks');
    const ecoEl = document.getElementById('stats-economy');

    if (taskEl) {
        taskEl.innerHTML = `
            <div class="panel-top-bar eng-text">OP_METRICS</div>
            <div class="eng-text text-accent" style="font-size:2rem; font-weight:900;">${state.stats.completedQuests}</div>
            <p class="text-muted" style="font-size:0.8rem;">CLEARED DIRECTIVES</p>
        `;
    }

    if (ecoEl) {
        ecoEl.innerHTML = `
            <div class="panel-top-bar eng-text">FINANCIAL_FLOW</div>
            <div class="eng-text text-green" style="font-size:1rem; font-weight:bold;">IN: +${state.stats.totalEarned}</div>
            <div class="eng-text text-red mt-1" style="font-size:1rem; font-weight:bold;">OUT: -${state.stats.totalSpent}</div>
        `;
    }
}

function checkLvlUp() {
    const p = state.profile;
    let leveledUp = false;

    // الحلقة التكرارية لضمان رفع المستويات إذا كسب نقاط كافية لعدة مستويات دفعة واحدة
    while (true) {
        const nXp = LEVELS[p.level] || (LEVELS[LEVELS.length - 1] + (p.level - 9) * 1000);
        if (p.xp >= nXp) {
            p.level++;
            leveledUp = true;
        } else {
            break;
        }
    }

    if (leveledUp) {
        playSfx('success');
        saveState();
        showToast(`LEVEL UP: ${p.level}`, 'success');
    }
}

function checkAchieve() {
    sysAchievements.forEach(a => {
        if (!state.achievements.includes(a.id) && a.condition(state)) {
            state.achievements.push(a.id);
            playSfx('success');
            showToast(`NEW BADGE ACQUIRED: ${a.title}`, 'success');
            saveState();
        }
    });
}

function renderAchievements() {
    const c = document.getElementById('achievements-container');
    if (!c) return;

    c.innerHTML = sysAchievements.map(a => {
        const u = state.achievements.includes(a.id);
        return `
            <div class="ach-card ${u ? 'unlocked' : 'locked'}">
                <div class="ach-icon" style="display:flex;align-items:center;justify-content:center;color: ${u ? 'var(--c-gold)' : 'inherit'};">✦</div>
                <div>
                    <h4 style="color:${u ? 'var(--c-gold)' : 'var(--c-text-muted)'}; font-weight:900;">${a.title}</h4>
                    <p class="text-muted" style="font-size:0.85rem;">${a.desc}</p>
                </div>
            </div>
        `;
    }).join('');
}

// -- SETTINGS & DATA MANAGEMENT --
window.updateName = function () {
    const nameEl = document.getElementById('setting-name');
    if (!nameEl) return;

    const n = nameEl.value.trim();
    if (n) {
        if (n === state.profile.name) {
            showToast('NAME IS IDENTICAL', 'primary');
            return;
        }
        state.profile.name = n;
        playSfx('click');
        saveState();
        showToast('ID UPDATED', 'success');
        updateUI();
    }
};

window.resetData = async function () {
    if (confirm('SYSTEM WIPE: ALL DATA WILL BE DELETED. PROCEED?')) {
        storageReady = false; // block any save while wiping
        try { localStorage.removeItem(STORAGE_KEY); localStorage.removeItem(BACKUP_KEY); } catch (e) { }
        await idbClearRecord();
        location.reload();
    }
};

window.exportData = function () {
    const a = document.createElement('a');
    a.href = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(state));
    a.download = `LIFEXP_OS_BACKUP_${new Date().toISOString().split('T')[0]}.json`;
    a.click();
};

window.importData = function (e) {
    const f = e.target.files[0];
    if (!f) return;

    if (!confirm('WARNING: THIS WILL OVERWRITE CURRENT DATA. PROCEED?')) {
        e.target.value = '';
        return;
    }

    const r = new FileReader();
    r.onload = (ev) => {
        try {
            const d = JSON.parse(ev.target.result);
            if (d && d.profile && typeof d.profile.coins === 'number' && Array.isArray(d.quests)) {
                const prevMeta = state._meta || { rev: 0, savedAt: 0 };
                state = normalizeState(d);
                state._meta = { rev: prevMeta.rev, savedAt: prevMeta.savedAt }; // saveState() bumps it above every older copy
                storageReady = true;
                saveState();
                showToast('DATA RESTORED', 'success');
                updateUI();
            } else {
                throw new Error("Invalid format");
            }
        } catch (err) {
            showToast('CORRUPTED FILE REJECTED', 'danger');
        }
        e.target.value = '';
    };
    r.readAsText(f);
};

// -- MODALS & TOAST --
window.showModal = function (id) {
    const m = document.getElementById(id);
    if (m) {
        m.classList.add('active');
        playSfx('click');
    }
};

window.hideModal = function (id) {
    const m = document.getElementById(id);
    if (m) m.classList.remove('active');
};

window.showToast = function (msg, type = 'primary') {
    const r = document.getElementById('toast-rack');
    if (!r) return;

    const t = document.createElement('div');
    t.className = `sys-toast ${type === 'danger' ? 'sys-toast-danger' : type === 'success' ? 'sys-toast-success' : ''}`;
    t.textContent = msg;
    r.appendChild(t);

    setTimeout(() => {
        t.style.opacity = '0';
        setTimeout(() => t.remove(), 200);
    }, 3000);
};

// -- PWA CLIENT HOOKS --
let deferredPrompt = null;
const installBtn = document.getElementById('install-btn');
const iosHint = document.getElementById('ios-install-hint');

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (installBtn) installBtn.classList.remove('hidden');
});

if (installBtn) {
    installBtn.addEventListener('click', async () => {
        if (deferredPrompt) {
            deferredPrompt.prompt();
            const { outcome } = await deferredPrompt.userChoice;
            console.log(`User response to prompt: ${outcome}`);
            deferredPrompt = null;
            installBtn.classList.add('hidden');
        }
    });
}

const isIos = () => /iphone|ipad|ipod/.test(window.navigator.userAgent.toLowerCase());
const isInStandaloneMode = () => ('standalone' in window.navigator) && (window.navigator.standalone);

if (isIos() && !isInStandaloneMode() && iosHint) {
    iosHint.classList.remove('hidden');
}

// -- BOOT SEQUENCE --
function applyUiSettings() {
    if (state.uiSettings && state.uiSettings.sfxOn !== undefined) {
        sfxEnabled = state.uiSettings.sfxOn;
    }
    updateAudioUI();

    if (state.uiSettings && state.uiSettings.questFilter) {
        currentFilter = state.uiSettings.questFilter;
        document.querySelectorAll('.filter-btn').forEach(b => {
            b.classList.remove('active');
            if (b.getAttribute('data-filter') === currentFilter) b.classList.add('active');
        });
    }

    if (state.uiSettings && state.uiSettings.lastView) {
        const viewToLoad = state.uiSettings.lastView;
        const targetElement = document.getElementById(viewToLoad);

        if (targetElement) {
            if (targetElement.classList.contains('sub-view')) {
                navigateSub(viewToLoad, false);
            } else {
                navigateMain(viewToLoad, false);
            }
        } else {
            navigateMain('dashboard', false);
        }
    } else {
        navigateMain('dashboard', false);
    }

    updateUI();
}

async function bootApp() {
    // Render immediately when localStorage already gave us the data; otherwise wait (briefly)
    // for the IndexedDB copy so a wiped localStorage can be recovered before anything is shown or saved.
    if (!storageReady) {
        await Promise.race([storageBootPromise, new Promise(r => setTimeout(r, 2500))]);
        if (!storageReady) storageReady = true; // IndexedDB did not answer in time: treat as first run
    }
    applyUiSettings();

    // If IndexedDB held a newer copy than localStorage, re-render with it.
    storageBootPromise.then((replaced) => {
        if (replaced) applyUiSettings();
        requestPersistentStorage();
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootApp);
} else {
    bootApp();
}

// Service worker registration waits for the full page load so it never competes with first render
window.addEventListener('load', () => {
    // Register Service Worker from sw.js
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js').catch(err => {
            console.warn('Service Worker registration failed:', err);
        });
    }
});