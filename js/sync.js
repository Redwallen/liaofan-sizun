/* ============================================================
   《了凡四训》逐句精读 —— 账号与云同步（纯前端，无依赖）

   设计要点：
   - 本地优先：未登录、离线、或部署在没有后端的静态托管（GitHub Pages / file://）时，
     一切照常工作，只是不联网。
   - 首次登录会做一次双向合并：按「每一节各自较新者胜」合并本机与云端，
     然后把合并结果写回云端，因此本机已有的进度不会丢。
   - 未登录前产生的旧数据视为「较旧」（updatedAt = 0），
     所以它只会补上云端还没有的小节，不会覆盖云端更新的记录。
   ============================================================ */
(function () {
  'use strict';

  var ENDPOINTS = {
    session: 'api/auth/session',
    login: 'api/auth/login',
    signup: 'api/auth/signup',
    logout: 'api/auth/logout',
    reading: 'api/reading'
  };

  var PROBE_TIMEOUT_MS = 6000;
  var PUSH_DEBOUNCE_MS = 1200;

  /* ---------- 数据形状转换 ---------- */

  // 前端用 { 0: true, 3: true }，服务端用 [0, 3]
  function revealedToArray(obj) {
    var out = [];
    if (!obj) return out;
    Object.keys(obj).forEach(function (key) {
      var n = Number(key);
      if (obj[key] && Number.isInteger(n) && n >= 0 && n < 1000) out.push(n);
    });
    return out.sort(function (a, b) { return a - b; });
  }

  function revealedToObject(arr) {
    var out = {};
    if (!Array.isArray(arr)) return out;
    arr.forEach(function (n) {
      if (Number.isInteger(n) && n >= 0 && n < 1000) out[n] = true;
    });
    return out;
  }

  /* ---------- 请求封装 ---------- */

  function request(path, options) {
    var opts = options || {};
    var headers = new Headers(opts.headers || {});
    if (opts.body !== undefined) headers.set('Content-Type', 'application/json');

    return fetch(path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
      cache: 'no-store'
    }).then(function (response) {
      var type = response.headers.get('content-type') || '';
      if (type.indexOf('application/json') === -1) {
        // 静态托管没有 API，返回的是 HTML
        var err = new Error('NO_BACKEND');
        err.code = 'NO_BACKEND';
        throw err;
      }
      return response.json().then(function (data) {
        if (!response.ok) {
          var e = new Error((data && data.error) || '请求失败，请稍后再试。');
          e.status = response.status;
          throw e;
        }
        return data;
      });
    });
  }

  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (!done) { done = true; reject(new Error('TIMEOUT')); }
      }, ms);
      promise.then(function (v) { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
                   function (e) { if (!done) { done = true; clearTimeout(timer); reject(e); } });
    });
  }

  /* ---------- 主体 ---------- */

  /**
   * @param {object} options
   *   getLocal()  -> { progress, notes }  应用当前的内存数据（直接引用即可）
   *   onRemote()  -> void                 合并完云端数据后调用，用于重绘界面
   *   onStatus()  -> void                 状态变化时调用，用于刷新账号 UI
   */
  window.createLiaofanSync = function (options) {
    var status = {
      available: null,      // null = 还没探测，false = 没有后端
      user: null,
      phase: 'idle',        // idle | checking | syncing | synced | error
      error: '',
      lastSyncAt: 0,
      pending: false
    };

    var pushTimer = null;
    var inFlight = false;
    var queuedAgain = false;

    function emit() {
      if (options.onStatus) options.onStatus(status);
    }

    function setPhase(phase, error) {
      status.phase = phase;
      status.error = error || '';
      if (phase === 'synced') status.lastSyncAt = Date.now();
      emit();
    }

    /* ---------- 合并 ---------- */

    function buildPayload() {
      var local = options.getLocal();
      var payload = { progress: {}, notes: {} };

      Object.keys(local.progress).forEach(function (id) {
        var e = local.progress[id];
        if (!e) return;
        payload.progress[id] = {
          done: !!e.done,
          pos: Number.isInteger(e.pos) && e.pos >= 0 ? e.pos : 0,
          revealed: revealedToArray(e.revealed),
          updatedAt: e.at || 0
        };
      });

      Object.keys(local.notes).forEach(function (id) {
        var e = local.notes[id];
        if (!e) return;
        var text = typeof e.text === 'string' ? e.text : '';
        payload.notes[id] = { text: text, updatedAt: e.at || 0 };
      });

      return payload;
    }

    /** 把云端数据并入本机，返回是否有改动 */
    function mergeRemote(remote) {
      var local = options.getLocal();
      var changed = false;

      Object.keys(remote.progress || {}).forEach(function (id) {
        var r = remote.progress[id];
        var l = local.progress[id];
        if (!l || (r.updatedAt || 0) > (l.at || 0)) {
          local.progress[id] = {
            done: !!r.done,
            pos: r.pos || 0,
            revealed: revealedToObject(r.revealed),
            at: r.updatedAt || 0
          };
          changed = true;
        }
      });

      Object.keys(remote.notes || {}).forEach(function (id) {
        var r = remote.notes[id];
        var l = local.notes[id];
        if (!l || (r.updatedAt || 0) > (l.at || 0)) {
          local.notes[id] = { text: typeof r.text === 'string' ? r.text : '', at: r.updatedAt || 0 };
          changed = true;
        }
      });

      return changed;
    }

    /* ---------- 推送 ---------- */

    function doPush() {
      if (!status.user) return Promise.resolve();
      if (inFlight) { queuedAgain = true; return Promise.resolve(); }
      inFlight = true;
      status.pending = true;
      emit();

      return request(ENDPOINTS.reading, { method: 'POST', body: buildPayload() })
        .then(function (merged) {
          // 服务端回传合并后的权威状态，直接采用
          if (mergeRemote(merged) && options.onRemote) options.onRemote();
          status.pending = false;
          setPhase('synced');
        })
        .catch(function (error) {
          status.pending = false;
          if (error && error.code === 'NO_BACKEND') {
            status.available = false;
            setPhase('idle');
            return;
          }
          setPhase('error', (error && error.message) || '同步失败');
        })
        .then(function () {
          inFlight = false;
          if (queuedAgain) {
            queuedAgain = false;
            return doPush();
          }
        });
    }

    function doPull() {
      return request(ENDPOINTS.reading).then(function (remote) {
        var changed = mergeRemote(remote);
        if (changed && options.onRemote) options.onRemote();
        return changed;
      });
    }

    /** 本地有改动时调用：合并推送，带防抖 */
    function schedule() {
      if (!status.user) return;
      status.pending = true;
      emit();
      clearTimeout(pushTimer);
      pushTimer = setTimeout(function () { doPush(); }, PUSH_DEBOUNCE_MS);
    }

    /** 立即把待推送内容送上去 */
    function flush() {
      clearTimeout(pushTimer);
      if (status.user) return doPush();
      return Promise.resolve();
    }

    /** 手动「立即同步」：先拉后推 */
    function syncNow() {
      if (!status.user) return Promise.resolve();
      setPhase('syncing');
      return doPull()
        .then(function () { return doPush(); })
        .catch(function (error) {
          setPhase('error', (error && error.message) || '同步失败');
        });
    }

    /** 清除云端全部数据（本机数据由调用方负责清） */
    function clearRemote() {
      if (!status.user) return Promise.resolve();
      return request(ENDPOINTS.reading, { method: 'DELETE' })
        .then(function () { setPhase('synced'); if (options.onRemote) options.onRemote(); })
        .catch(function (error) {
          setPhase('error', (error && error.message) || '清除云端数据失败');
        });
    }

    /* ---------- 会话 ---------- */

    function applySession(user) {
      status.user = user;
      status.available = true;
      emit();
    }

    function afterAuth() {
      // 登录成功后：先拉云端，再合并本机已有的数据推上去
      setPhase('syncing');
      return doPull()
        .then(function () { return doPush(); })
        .then(function () { if (options.onRemote) options.onRemote(); })
        .catch(function (error) {
          setPhase('error', (error && error.message) || '同步失败');
        });
    }

    function login(email, password) {
      return request(ENDPOINTS.login, { method: 'POST', body: { email: email, password: password } })
        .then(function (data) {
          applySession(data.user);
          return afterAuth();
        });
    }

    function signup(email, password) {
      return request(ENDPOINTS.signup, { method: 'POST', body: { email: email, password: password } })
        .then(function (data) {
          applySession(data.user);
          return afterAuth();
        });
    }

    function logout() {
      return request(ENDPOINTS.logout, { method: 'POST', body: {} })
        .catch(function () { /* 即使请求失败也让本地登出 */ })
        .then(function () {
          status.user = null;
          status.pending = false;
          setPhase('idle');
          emit();
        });
    }

    /* ---------- 探测后端 ---------- */

    function start() {
      setPhase('checking');
      return withTimeout(request(ENDPOINTS.session), PROBE_TIMEOUT_MS)
        .then(function (data) {
          applySession(data.user || null);
          setPhase('idle');
          if (data.user) return afterAuth();
        })
        .catch(function (error) {
          if (error && (error.code === 'NO_BACKEND' || error.message === 'TIMEOUT' || error.name === 'TypeError')) {
            status.available = false;
          } else {
            status.available = false;
            status.error = (error && error.message) || '';
          }
          setPhase('idle');
        });
    }

    // 回到前台 / 网络恢复时补一次同步
    window.addEventListener('online', function () { if (status.user) syncNow(); });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flush();
      else if (status.user) syncNow();
    });
    window.addEventListener('pagehide', function () { flush(); });

    return {
      start: start,
      login: login,
      signup: signup,
      logout: logout,
      schedule: schedule,
      flush: flush,
      syncNow: syncNow,
      clearRemote: clearRemote,
      status: status,
      isLoggedIn: function () { return !!status.user; }
    };
  };
})();
