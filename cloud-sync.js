(function () {
  'use strict';

  var STORAGE_KEY = 'tlg_v1';
  var META_KEY = 'tlg_sync_meta_v1';
  var DEVICE_KEY = 'tlg_device_id_v1';
  var SAVE_DELAY = 1200;
  var MAX_SAVE_DELAY = 5000;
  var client = null;
  var user = null;
  var cloudRow = null;
  var saveTimer = null;
  var saveStartedAt = 0;
  var bridgeTimer = null;
  var originalSave = window.save;
  var stateLabel = 'Local only';
  var conflictLocked = false;

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
    if (['tasks','focusSessions','dueDates','projects'].some(function (k) { return Array.isArray(data[k]) && data[k].length; })) return true;
    var clock = data.clockRecords || {};
    if (Object.keys(clock).some(function (day) {
      return Object.keys(clock[day] || {}).some(function (key) {
        var rec = clock[day][key] || {};
        return Boolean(rec.inTs || rec.outTs || rec.inTime || rec.outTime || rec.totalMins ||
          (Array.isArray(rec.segments) && rec.segments.some(function (seg) { return seg && (seg.inTs || seg.outTs || seg.inTime || seg.outTime); })));
      });
    })) return true;
    if (Object.keys(data.weeklyPlans || {}).some(function (key) {
      var plan = data.weeklyPlans[key] || {};
      return (Array.isArray(plan.items) && plan.items.length) || String(plan.priorities || '').trim() || String(plan.actions || '').trim();
    })) return true;
    if (Object.keys(data.moodHistory || {}).some(function (key) { return Array.isArray(data.moodHistory[key]) && data.moodHistory[key].length; })) return true;
    if (Object.keys(data.mindRecords || {}).some(function (key) {
      var rec = data.mindRecords[key] || {};
      return ['morning','best','improve'].some(function (field) { return String(rec[field] || '').trim(); });
    })) return true;
    return Object.keys(data.subprojects || {}).some(function (key) { return Array.isArray(data.subprojects[key]) && data.subprojects[key].length; });
  }
  function comparable(data) {
    function clean(value, path) {
      if (Array.isArray(value)) {
        var arr = value.map(function (item, i) { return clean(item, path.concat(String(i))); }).filter(function (item) { return item !== undefined; });
        return arr.length ? arr : undefined;
      }
      if (value && typeof value === 'object') {
        var out = {};
        Object.keys(value).sort().forEach(function (key) {
          if (key === 'savedAt' && path[path.length - 1] === 'activeFocus') return;
          var next = clean(value[key], path.concat(key));
          if (next !== undefined) out[key] = next;
        });
        return Object.keys(out).length ? out : undefined;
      }
      if (value === '' || value === null || value === undefined) return undefined;
      return value;
    }
    return clean(data || {}, []) || {};
  }
  function equivalent(a, b) { return JSON.stringify(comparable(a)) === JSON.stringify(comparable(b)); }
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
    var backups = document.getElementById('tlgConflictBackups');
    if (backups) backups.style.display = kind === 'conflict' ? 'flex' : 'none';
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
      button.addEventListener('click', function () { openModal(false); });
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
        '<div id="tlgSyncPane" style="display:none;margin-top:1rem"><div id="tlgUserLine" class="tlg-cloud-note"></div><div class="tlg-cloud-row" style="margin-top:.7rem"><button id="tlgUpload" class="tlg-cloud-btn tlg-cloud-warn">Upload this device</button><button id="tlgDownload" class="tlg-cloud-btn tlg-cloud-safe">Use cloud copy</button><button id="tlgSyncNow" class="tlg-cloud-btn tlg-cloud-primary">Sync now</button><button id="tlgSignOut" class="tlg-cloud-btn tlg-cloud-muted">Sign out</button></div><div id="tlgConflictBackups" class="tlg-cloud-row" style="display:none;margin-top:.65rem"><button id="tlgBackupLocal" class="tlg-cloud-btn tlg-cloud-muted">Download local backup</button><button id="tlgBackupCloud" class="tlg-cloud-btn tlg-cloud-muted">Download cloud backup</button></div><p class="tlg-cloud-note" style="margin-top:.7rem">Upload changes the cloud record. “Use cloud copy” replaces this browser’s local dashboard only after confirmation and first saves a downloadable backup.</p></div>' +
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
      document.getElementById('tlgBackupLocal').onclick = function () { downloadBackup(snapshot(), 'local-copy'); };
      document.getElementById('tlgBackupCloud').onclick = downloadCloudBackup;
    }
    if (!document.getElementById('tlgSyncGate')) {
      var gate = document.createElement('div');
      gate.id = 'tlgSyncGate';
      gate.className = 'tlg-sync-gate';
      gate.innerHTML = '<section class="tlg-sync-gate-card" role="alertdialog" aria-modal="true"><div class="tlg-sync-gate-spinner" aria-hidden="true"></div><h2 id="tlgSyncGateTitle">Checking cloud…</h2><p id="tlgSyncGateText">Please wait before editing this device.</p><button id="tlgSyncGateReview" class="tlg-cloud-btn tlg-cloud-primary" style="display:none">Review conflict</button></section>';
      document.body.appendChild(gate);
      document.getElementById('tlgSyncGateReview').onclick = function () { openModal(true); };
    }
    updateAuthUi();
  }
  function showGate(title, text, review) {
    var gate = document.getElementById('tlgSyncGate');
    if (!gate) return;
    document.getElementById('tlgSyncGateTitle').textContent = title || 'Checking cloud…';
    document.getElementById('tlgSyncGateText').textContent = text || 'Please wait before editing this device.';
    document.getElementById('tlgSyncGateReview').style.display = review ? 'inline-flex' : 'none';
    gate.classList.add('on');
  }
  function hideGate() { var gate = document.getElementById('tlgSyncGate'); if (gate) gate.classList.remove('on'); }
  function releaseGate() { conflictLocked = false; hideGate(); }
  function enterConflict(text) {
    conflictLocked = true;
    setStatus('Conflict / newer cloud version', 'conflict');
    message(text, true);
    showGate('Sync conflict', 'Editing is paused so this device cannot overwrite newer cloud data. Download backups and review both copies before continuing.', true);
    openModal(true);
  }
  function openModal(skipRefresh) {
    document.getElementById('tlgCloudModal').classList.add('on');
    if (!configured()) message('Cloud sync is not configured yet. Add the Supabase Project URL and publishable key to config.js (localhost) or GitHub repository variables (Pages).', true);
    else if (!skipRefresh) refreshCloudState(false);
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
    releaseGate();
    message('Signed out. Local data is unchanged.');
  }

  async function fetchCloud() {
    if (!client || !user) return null;
    var result = await client.from('tlg_state').select('state,version,updated_at').eq('user_id', user.id).maybeSingle();
    if (result.error) throw result.error;
    cloudRow = result.data;
    return cloudRow;
  }
  async function refreshCloudState(lockEditing) {
    if (!configured() || !user) { releaseGate(); return; }
    if (lockEditing) showGate('Checking cloud…', 'Please wait while this device checks for newer data.', false);
    if (!navigator.onLine) { setStatus('Offline', 'offline'); releaseGate(); return; }
    try {
      setStatus('Syncing', 'syncing');
      var row = await fetchCloud();
      var local = snapshot();
      var meta = readMeta();
      if (!row) {
        setStatus('Local only', 'local');
        message(meaningful(local) ? 'No cloud copy exists. Upload is intentionally waiting for your confirmation.' : 'No local or cloud data yet.');
        releaseGate();
        return;
      }
      if (!meaningful(local) && meaningful(row.state)) {
        await applyCloud(row, false);
        return;
      }
      if (!isLinked()) {
        if ((!meta.dirty && meta.lastSyncedVersion && meta.lastSyncedVersion === (row.version || 0)) || equivalent(local, row.state)) {
          setLinked(true);
          writeMeta({ dirty: false, lastSyncedVersion: row.version || 0, lastSyncedAt: row.updated_at || new Date().toISOString() });
          setStatus('Synced', 'synced');
          message('This device matches cloud version ' + (row.version || 0) + '.');
          releaseGate();
          return;
        }
        enterConflict('Both this device and the cloud contain different data. Review the choices before replacing either copy.');
        return;
      }
      if ((row.version || 0) > (meta.lastSyncedVersion || 0)) {
        if (meta.dirty) {
          if (equivalent(local, row.state)) {
            writeMeta({ dirty: false, lastSyncedVersion: row.version || 0, lastSyncedAt: row.updated_at || new Date().toISOString() });
            setStatus('Synced', 'synced');
            message('This device matches cloud version ' + (row.version || 0) + '.');
            releaseGate();
          } else enterConflict('The cloud changed after this device last synced. Editing is paused until you choose which copy to keep.');
        } else await applyCloud(row, false);
      } else if (meta.dirty) {
        var pushed = await pushCloud(false);
        if (pushed) releaseGate();
      } else {
        setStatus('Synced', 'synced');
        message('This device matches cloud version ' + (row.version || 0) + '.');
        releaseGate();
      }
    } catch (err) {
      setStatus(navigator.onLine ? 'Local only' : 'Offline', navigator.onLine ? 'local' : 'offline');
      message('Cloud check failed: ' + err.message, true);
      releaseGate();
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
  async function downloadCloudBackup() {
    try {
      var row = await fetchCloud();
      if (!row || !row.state) return message('There is no cloud copy to back up.', true);
      downloadBackup(row.state, 'cloud-copy-v' + (row.version || 0));
      message('Cloud backup downloaded.');
    } catch (err) { message(err.message, true); }
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
    if (current && current.state) downloadBackup(current.state, 'cloud-before-upload-v' + (current.version || 0));
    setLinked(true);
    writeMeta({ dirty: true, lastSyncedVersion: current ? (current.version || 0) : 0 });
    await pushCloud(true);
  }
  async function pushCloud(force) {
    if (!client || !user || !isLinked() || !navigator.onLine) return false;
    var local = snapshot();
    if (!meaningful(local)) { setStatus('Local only', 'local'); message('Empty-device upload was blocked.', true); return false; }
    try {
      setStatus('Syncing', 'syncing');
      var latest = await fetchCloud();
      var meta = readMeta();
      if (!force && latest && (latest.version || 0) > (meta.lastSyncedVersion || 0)) {
        enterConflict('Cloud is newer. Automatic upload stopped and editing is paused.');
        return false;
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
        if (!result.error && !result.data) {
          enterConflict('Cloud changed during sync. Automatic upload stopped and editing is paused.');
          return false;
        }
      }
      if (result.error) throw result.error;
      writeMeta({ dirty: false, lastSyncedVersion: result.data.version, lastSyncedAt: result.data.updated_at });
      cloudRow = Object.assign({}, payload, result.data);
      setStatus('Synced', 'synced');
      message('Synced cloud version ' + result.data.version + '.');
      releaseGate();
      return true;
    } catch (err) {
      setStatus(navigator.onLine ? 'Local changes' : 'Offline', navigator.onLine ? 'local' : 'offline');
      message('Sync failed: ' + err.message, true);
      releaseGate();
      return false;
    }
  }
  async function syncNow() {
    if (!user) return;
    var meta = readMeta();
    if (meta.dirty && isLinked()) await pushCloud(false); else await refreshCloudState();
  }
  function scheduleCloudSave() {
    if (conflictLocked) return;
    if (!saveStartedAt) saveStartedAt = Date.now();
    clearTimeout(saveTimer);
    var remaining = Math.max(0, MAX_SAVE_DELAY - (Date.now() - saveStartedAt));
    saveTimer = setTimeout(function () {
      saveStartedAt = 0;
      if (user && isLinked()) pushCloud(false);
    }, Math.min(SAVE_DELAY, remaining));
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
      if (conflictLocked) {
        setStatus('Conflict / newer cloud version', 'conflict');
        return;
      }
      scheduleCloudSave();
      if (!navigator.onLine) setStatus('Offline', 'offline');
      else if (!user || !isLinked()) setStatus('Local only', 'local');
      else setStatus('Syncing', 'syncing');
    };
  }
  async function initSupabase() {
    if (!configured() || !window.supabase) { releaseGate(); return; }
    client = window.supabase.createClient(cfg().SUPABASE_URL, cfg().SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    var sessionResult = await client.auth.getSession();
    user = sessionResult.data.session && sessionResult.data.session.user;
    updateAuthUi();
    client.auth.onAuthStateChange(function (event, session) {
      user = session && session.user;
      updateAuthUi();
      if (event === 'INITIAL_SESSION') return;
      if (user) setTimeout(function () { refreshCloudState(true); }, 0);
      else { setStatus(navigator.onLine ? 'Local only' : 'Offline', navigator.onLine ? 'local' : 'offline'); releaseGate(); }
    });
    if (user) await refreshCloudState(true); else releaseGate();
  }
  function registerPwa() {
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || onLocalhost())) navigator.serviceWorker.register('./service-worker.js').catch(function () {});
  }
  async function init() {
    await waitForLocalInit();
    installUi();
    deviceId();
    wrapLocalSave();
    if (configured()) showGate('Checking cloud…', 'Please wait while this device checks for newer data.', false);
    window.addEventListener('offline', function () { setStatus('Offline', 'offline'); releaseGate(); });
    window.addEventListener('online', function () { if (user) refreshCloudState(true); else setStatus('Local only', 'local'); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden && user) refreshCloudState(true); });
    registerPwa();
    await initSupabase();
  }

  window.TLGSync = { init: init, syncNow: syncNow, status: function () { return stateLabel; } };
  init();
})();

