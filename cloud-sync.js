(function () {
  'use strict';

  var STORAGE_KEY = 'tlg_v1';
  var META_KEY = 'tlg_sync_meta_v1';
  var DEVICE_KEY = 'tlg_device_id_v1';
  var SAVE_DELAY = 1200;
  var client = null;
  var user = null;
  var cloudRow = null;
  var saveTimer = null;
  var bridgeTimer = null;
  var originalSave = window.save;
  var stateLabel = 'Local only';

  function cfg() { return window.TLG_CONFIG || {}; }
  function configured() {
    return Boolean(cfg().SUPABASE_URL && cfg().SUPABASE_PUBLISHABLE_KEY &&
      !/YOUR_|example/i.test(cfg().SUPABASE_URL + cfg().SUPABASE_PUBLISHABLE_KEY));
  }
  function onLocalhost() { return location.hostname === 'localhost' || location.hostname === '127.0.0.1'; }
  function readMeta() {
    try { return JSON.parse(localStorage.getItem(META_KEY)) || {}; } catch (_) { return {}; }
  }
  function writeMeta(patch) {
    var next = Object.assign(readMeta(), patch || {});
    localStorage.setItem(META_KEY, JSON.stringify(next));
    return next;
  }
  function deviceId() {
    var id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : 'device-' + Date.now() + '-' + Math.random().toString(16).slice(2));
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  }
  function snapshot() {
    try { return JSON.parse(JSON.stringify(window.D || {})); } catch (_) { return {}; }
  }
  function meaningful(data) {
    if (!data || typeof data !== 'object') return false;
    return ['tasks','focusSessions','dueDates','projects'].some(function (k) { return Array.isArray(data[k]) && data[k].length; }) ||
      ['clockRecords','moodHistory','mindRecords','weeklyPlans','subprojects'].some(function (k) { return data[k] && Object.keys(data[k]).length; });
  }
  function summary(data) {
    data = data || {};
    return [
      (data.tasks || []).length + ' tasks',
      (data.focusSessions || []).length + ' focus sessions',
      Object.keys(data.clockRecords || {}).length + ' office-day records',
      (data.projects || []).length + ' projects'
    ].join(', ');
  }
  function linkedKey() { return user ? 'tlg_cloud_linked_' + user.id : ''; }
  function isLinked() { return Boolean(user && localStorage.getItem(linkedKey()) === 'yes'); }
  function setLinked(value) { if (user) localStorage.setItem(linkedKey(), value ? 'yes' : 'no'); }

  function setStatus(label, kind) {
    stateLabel = label;
    var button = document.getElementById('tlgSyncButton');
    if (!button) return;
    button.dataset.state = kind || 'local';
    var text = button.querySelector('.tlg-sync-text');
    if (text) text.textContent = label;
    button.title = 'Cloud sync: ' + label;
    var modalStatus = document.getElementById('tlgCloudStatus');
    if (modalStatus) modalStatus.textContent = label;
  }
  function message(text, error) {
    var el = document.getElementById('tlgCloudMessage');
    if (el) { el.textContent = text || ''; el.style.color = error ? '#e11d48' : '#374151'; }
  }

  function installUi() {
    var header = document.querySelector('body .max-w-7xl > .flex.flex-wrap.justify-between');
    var controls = header && header.lastElementChild;
    if (controls && !document.getElementById('tlgSyncButton')) {
      var button = document.createElement('button');
      button.id = 'tlgSyncButton';
      button.className = 'tlg-sync-button';
      button.type = 'button';
      button.dataset.state = 'local';
      button.innerHTML = '<span class="tlg-sync-dot" aria-hidden="true"></span><span class="tlg-sync-text">Local only</span>';
      button.addEventListener('click', openModal);
      controls.insertBefore(button, controls.firstChild);
    }
    if (!document.getElementById('tlgCloudModal')) {
      var overlay = document.createElement('div');
      overlay.id = 'tlgCloudModal';
      overlay.className = 'tlg-cloud-overlay';
      overlay.innerHTML = '<section class="tlg-cloud-card" role="dialog" aria-modal="true" aria-labelledby="tlgCloudTitle">' +
        '<div class="tlg-cloud-row" style="justify-content:space-between"><div><h2 id="tlgCloudTitle" style="font-size:1.15rem;font-weight:900;color:#374151">Secure cloud sync</h2><div id="tlgCloudStatus" class="tlg-cloud-note">' + stateLabel + '</div></div><button id="tlgCloudClose" class="tlg-cloud-btn tlg-cloud-muted" aria-label="Close">Close</button></div>' +
        '<p class="tlg-cloud-note" style="margin-top:.8rem">Local storage and the Mac <code>data.json</code> bridge remain active. Cloud sync uses your Supabase account and never uploads existing Mac data until you explicitly choose “Upload this device”.</p>' +
        '<div id="tlgAuthPane" style="margin-top:1rem"><input id="tlgEmail" class="tlg-cloud-input" type="email" autocomplete="email" placeholder="Email"><input id="tlgPassword" class="tlg-cloud-input" style="margin-top:.55rem" type="password" autocomplete="current-password" placeholder="Password (8+ characters)"><div class="tlg-cloud-row" style="margin-top:.65rem"><button id="tlgSignIn" class="tlg-cloud-btn tlg-cloud-primary">Sign in</button><button id="tlgSignUp" class="tlg-cloud-btn tlg-cloud-muted">Create account</button></div></div>' +
        '<div id="tlgSyncPane" style="display:none;margin-top:1rem"><div id="tlgUserLine" class="tlg-cloud-note"></div><div class="tlg-cloud-row" style="margin-top:.7rem"><button id="tlgUpload" class="tlg-cloud-btn tlg-cloud-warn">Upload this device</button><button id="tlgDownload" class="tlg-cloud-btn tlg-cloud-safe">Use cloud copy</button><button id="tlgSyncNow" class="tlg-cloud-btn tlg-cloud-primary">Sync now</button><button id="tlgSignOut" class="tlg-cloud-btn tlg-cloud-muted">Sign out</button></div><p class="tlg-cloud-note" style="margin-top:.7rem">Upload changes the cloud record. “Use cloud copy” replaces this browser’s local dashboard only after confirmation and first saves a downloadable backup.</p></div>' +
        '<div id="tlgCloudMessage" class="tlg-cloud-message" style="margin-top:.8rem"></div></section>';
      document.body.appendChild(overlay);
      overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal(); });
      document.getElementById('tlgCloudClose').onclick = closeModal;
      document.getElementById('tlgSignIn').onclick = signIn;
      document.getElementById('tlgSignUp').onclick = signUp;
      document.getElementById('tlgSignOut').onclick = signOut;
      document.getElementById('tlgUpload').onclick = explicitUpload;
      document.getElementById('tlgDownload').onclick = explicitDownload;
      document.getElementById('tlgSyncNow').onclick = syncNow;
    }
    updateAuthUi();
  }
  function openModal() {
    document.getElementById('tlgCloudModal').classList.add('on');
    if (!configured()) message('Cloud sync is not configured yet. Add the Supabase Project URL and publishable key to config.js (localhost) or GitHub repository variables (Pages).', true);
    else refreshCloudState();
  }
  function closeModal() { document.getElementById('tlgCloudModal').classList.remove('on'); }
  function updateAuthUi() {
    var auth = document.getElementById('tlgAuthPane');
    var sync = document.getElementById('tlgSyncPane');
    if (!auth || !sync) return;
    auth.style.display = user ? 'none' : 'block';
    sync.style.display = user ? 'block' : 'none';
    var line = document.getElementById('tlgUserLine');
    if (line) line.textContent = user ? 'Signed in as ' + user.email + '. This device: ' + summary(snapshot()) + '.' : '';
  }

  async function signIn() {
    if (!client) return message('Supabase is not configured.', true);
    message('Signing in…');
    var result = await client.auth.signInWithPassword({ email: document.getElementById('tlgEmail').value.trim(), password: document.getElementById('tlgPassword').value });
    if (result.error) return message(result.error.message, true);
    message('Signed in. Checking cloud data…');
  }
  async function signUp() {
    if (!client) return message('Supabase is not configured.', true);
    message('Creating account…');
    var result = await client.auth.signUp({ email: document.getElementById('tlgEmail').value.trim(), password: document.getElementById('tlgPassword').value });
    if (result.error) return message(result.error.message, true);
    message(result.data.session ? 'Account created and signed in.' : 'Check your email to confirm the account, then sign in.');
  }
  async function signOut() {
    if (client) await client.auth.signOut();
    user = null; cloudRow = null; updateAuthUi(); setStatus(navigator.onLine ? 'Local only' : 'Offline', navigator.onLine ? 'local' : 'offline');
    message('Signed out. Local data is unchanged.');
  }

  async function fetchCloud() {
    if (!client || !user) return null;
    var result = await client.from('tlg_state').select('state,version,updated_at').eq('user_id', user.id).maybeSingle();
    if (result.error) throw result.error;
    cloudRow = result.data;
    return cloudRow;
  }
  async function refreshCloudState() {
    if (!configured() || !user) return;
    if (!navigator.onLine) return setStatus('Offline', 'offline');
    try {
      setStatus('Syncing', 'syncing');
      var row = await fetchCloud();
      var local = snapshot();
      var meta = readMeta();
      if (!row) {
        setStatus('Local only', 'local');
        message(meaningful(local) ? 'No cloud copy exists. Upload is intentionally waiting for your confirmation.' : 'No local or cloud data yet.');
        return;
      }
      if (!meaningful(local) && meaningful(row.state)) {
        await applyCloud(row, false);
        return;
      }
      if (!isLinked()) {
        setStatus('Conflict / newer cloud version', 'conflict');
        message('Both this device and the cloud contain data. Review the choices before replacing either copy.', true);
        return;
      }
      if ((row.version || 0) > (meta.lastSyncedVersion || 0)) {
        if (meta.dirty) {
          setStatus('Conflict / newer cloud version', 'conflict');
          message('The cloud changed after this device last synced. Choose which copy to keep.', true);
        } else await applyCloud(row, false);
      } else {
        setStatus(meta.dirty ? 'Local changes' : 'Synced', meta.dirty ? 'local' : 'synced');
        message(meta.dirty ? 'Local changes are ready to sync.' : 'This device matches cloud version ' + (row.version || 0) + '.');
      }
    } catch (err) {
      setStatus(navigator.onLine ? 'Local only' : 'Offline', navigator.onLine ? 'local' : 'offline');
      message('Cloud check failed: ' + err.message, true);
    }
  }

  function downloadBackup(data, suffix) {
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'thelonggame-before-' + suffix + '-' + new Date().toISOString().slice(0,10).replace(/-/g,'') + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 500);
  }
  async function applyCloud(row, ask) {
    if (!row || !row.state) return;
    if (ask && !confirm('Replace this device\'s local dashboard with cloud version ' + (row.version || 0) + '?\n\nA local JSON backup will download first. The cloud will not be changed.')) return;
    if (meaningful(snapshot())) downloadBackup(snapshot(), 'cloud-download');
    localStorage.setItem(STORAGE_KEY, JSON.stringify(row.state));
    writeMeta({ dirty: false, lastSyncedVersion: row.version || 0, lastSyncedAt: row.updated_at || new Date().toISOString() });
    setLinked(true);
    if (onLocalhost()) await postBridge(row.state);
    location.reload();
  }
  async function explicitDownload() {
    try { var row = await fetchCloud(); if (!row) return message('There is no cloud copy to download.', true); await applyCloud(row, true); }
    catch (err) { message(err.message, true); }
  }
  async function explicitUpload() {
    var local = snapshot();
    if (!meaningful(local)) return message('This device is empty, so upload is blocked to protect populated cloud data.', true);
    var current;
    try { current = await fetchCloud(); } catch (err) { return message(err.message, true); }
    var cloudText = current ? ('Cloud version ' + (current.version || 0) + ' (' + summary(current.state) + ') will be replaced.') : 'A new cloud record will be created.';
    if (!confirm('Upload this device to the cloud?\n\nThis device: ' + summary(local) + '.\n' + cloudText + '\n\nLocal data.json and localStorage will remain unchanged.')) return;
    setLinked(true);
    writeMeta({ dirty: true, lastSyncedVersion: current ? (current.version || 0) : 0 });
    await pushCloud(true);
  }
  async function pushCloud(force) {
    if (!client || !user || !isLinked() || !navigator.onLine) return;
    var local = snapshot();
    if (!meaningful(local)) { setStatus('Local only', 'local'); return message('Empty-device upload was blocked.', true); }
    try {
      setStatus('Syncing', 'syncing');
      var latest = await fetchCloud();
      var meta = readMeta();
      if (!force && latest && (latest.version || 0) > (meta.lastSyncedVersion || 0)) {
        setStatus('Conflict / newer cloud version', 'conflict');
        return message('Cloud is newer. Automatic upload stopped.', true);
      }
      var nextVersion = (latest ? latest.version : 0) + 1;
      var payload = { user_id: user.id, state: local, version: nextVersion, updated_at: new Date().toISOString() };
      var result;
      if (!latest) {
        result = await client.from('tlg_state').insert(payload).select('version,updated_at').single();
      } else if (force) {
        result = await client.from('tlg_state').update(payload).eq('user_id', user.id).select('version,updated_at').single();
      } else {
        result = await client.from('tlg_state').update(payload).eq('user_id', user.id).eq('version', latest.version).select('version,updated_at').maybeSingle();
        if (!result.error && !result.data) throw new Error('Cloud changed during sync. Automatic upload stopped.');
      }
      if (result.error) throw result.error;
      writeMeta({ dirty: false, lastSyncedVersion: result.data.version, lastSyncedAt: result.data.updated_at });
      cloudRow = Object.assign({}, payload, result.data);
      setStatus('Synced', 'synced');
      message('Synced cloud version ' + result.data.version + '.');
    } catch (err) {
      setStatus(navigator.onLine ? 'Local changes' : 'Offline', navigator.onLine ? 'local' : 'offline');
      message('Sync failed: ' + err.message, true);
    }
  }
  async function syncNow() {
    if (!user) return;
    var meta = readMeta();
    if (meta.dirty && isLinked()) await pushCloud(false); else await refreshCloudState();
  }
  function scheduleCloudSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { if (user && isLinked()) pushCloud(false); }, SAVE_DELAY);
  }
  function scheduleBridgeSave() {}
  function postBridge(data) {
    return fetch('/api/data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).catch(function () {});
  }
  function waitForLocalInit() {
    return new Promise(function (resolve) {
      var attempts = 0;
      (function check() {
        if (window.TLG_LOCAL_READY || attempts++ > 100) return resolve();
        setTimeout(check, 50);
      })();
    });
  }

  function wrapLocalSave() {
    if (typeof originalSave !== 'function') return;
    window.save = function () {
      originalSave();
      writeMeta({ dirty: true, localUpdatedAt: new Date().toISOString(), deviceId: deviceId() });
      scheduleBridgeSave();
      scheduleCloudSave();
      if (!navigator.onLine) setStatus('Offline', 'offline');
      else if (!user || !isLinked()) setStatus('Local only', 'local');
      else setStatus('Syncing', 'syncing');
    };
  }
  async function initSupabase() {
    if (!configured() || !window.supabase) return;
    client = window.supabase.createClient(cfg().SUPABASE_URL, cfg().SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    var sessionResult = await client.auth.getSession();
    user = sessionResult.data.session && sessionResult.data.session.user;
    updateAuthUi();
    client.auth.onAuthStateChange(function (_event, session) {
      user = session && session.user;
      updateAuthUi();
      if (user) setTimeout(refreshCloudState, 0);
      else setStatus(navigator.onLine ? 'Local only' : 'Offline', navigator.onLine ? 'local' : 'offline');
    });
    if (user) refreshCloudState();
  }
  function registerPwa() {
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || onLocalhost())) navigator.serviceWorker.register('./service-worker.js').catch(function () {});
  }
  async function init() {
    await waitForLocalInit();
    installUi();
    deviceId();
    wrapLocalSave();
    window.addEventListener('offline', function () { setStatus('Offline', 'offline'); });
    window.addEventListener('online', function () { user ? refreshCloudState() : setStatus('Local only', 'local'); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden && user) refreshCloudState(); });
    registerPwa();
    await initSupabase();
  }

  window.TLGSync = { init: init, syncNow: syncNow, status: function () { return stateLabel; } };
  init();
})();

