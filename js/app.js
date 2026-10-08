/* ============================================================
   《了凡四训》逐句精读 —— 应用逻辑
   纯静态、无依赖；进度与笔记保存在浏览器 localStorage。
   ============================================================ */
(function () {
  'use strict';

  var BOOK = window.BOOK || null;

  /* ----------------------------- 站点文案 ----------------------------- */
  var SITE = {
    author: '明 · 袁黄（号了凡）',
    tagline: '命由我作，福自己求',
    lead: '《了凡四训》是明代袁了凡写给儿子的四篇家训。它讲一件很实在的事：人一生的祸福，究竟是天定，还是自己挣来的？这本书给出的答案是——命可以改，改法就在自己身上。',
    about: [
      '袁了凡（1533—1606），名黄，字坤仪，号了凡，江苏吴江人。他年轻时遇到一位孔先生，把他一生的功名、寿数、有无子嗣都算得清清楚楚，后来竟一一应验。直到他在栖霞山遇到云谷禅师，才明白「命由我作，福自己求」，从此改号「了凡」，立志行善，最终打破了算命的结果。',
      '全书四篇，原本是写给自己儿子的家训，所以语气恳切、例子具体，讲的都是怎么做，而不是空谈道理。四篇之间是一条完整的路：先信「命可立」，再学「过可改」，然后「善可积」，最后以「谦可保」收束。'
    ],
    howto: [
      { b: '点原文看白话', s: '每一句文言都可以点开，立刻看到现代汉语翻译，不必先啃完全篇。' },
      { b: '点红色词看注释', s: '人名、地名、官职、典故都做了注释，读到不懂的词点一下就有解释。' },
      { b: '两种读法', s: '「逐句精读」一次只面对一句；「通篇对照」则整节铺开，按需展开译文。' },
      { b: '进度自动保存', s: '未登录时存在本机，登录后自动同步到账号，换设备也能接着读。' }
    ]
  };

  /* ----------------------------- 存储 ----------------------------- */
  var LS = {
    settings: 'liaofan.settings.v1',
    progress: 'liaofan.progress.v1',
    notes: 'liaofan.notes.v1',
    last: 'liaofan.last.v1'
  };

  var DEFAULT_SETTINGS = {
    theme: 'paper',
    fontSize: 'm',
    writing: 'horizontal',
    defaultMode: 'focus',
    defaultReveal: 'hidden',
    speechRate: '0.9'
  };

  var FONT_SIZE = { s: '17px', m: '19px', l: '21.5px', xl: '24px' };

  function load(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var v = JSON.parse(raw);
      return v == null ? fallback : v;
    } catch (e) { return fallback; }
  }
  function save(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }

  /* --------- 本地数据规范化 ---------
     进度：{ [id]: { done, pos, revealed:{}, at } }
     笔记：{ [id]: { text, at } }
     旧版本的笔记是纯字符串、也没有 at，这里统一升级。
     at = 0 表示「登录前就存在的旧数据」：同步时只会补上云端还没有的小节，
     不会覆盖云端更新的记录。 */
  function normalizeProgress(raw) {
    var out = {};
    if (!raw || typeof raw !== 'object') return out;
    Object.keys(raw).forEach(function (id) {
      var e = raw[id];
      if (!e || typeof e !== 'object') return;
      out[id] = {
        done: !!e.done,
        pos: Number.isInteger(e.pos) && e.pos >= 0 ? e.pos : 0,
        revealed: e.revealed && typeof e.revealed === 'object' ? e.revealed : {},
        at: Number.isFinite(e.at) ? e.at : 0
      };
    });
    return out;
  }

  function normalizeNotes(raw) {
    var out = {};
    if (!raw || typeof raw !== 'object') return out;
    Object.keys(raw).forEach(function (id) {
      var e = raw[id];
      if (typeof e === 'string') { out[id] = { text: e, at: 0 }; return; }
      if (!e || typeof e !== 'object') return;
      out[id] = { text: typeof e.text === 'string' ? e.text : '', at: Number.isFinite(e.at) ? e.at : 0 };
    });
    return out;
  }

  var settings = Object.assign({}, DEFAULT_SETTINGS, load(LS.settings, {}));
  var progress = normalizeProgress(load(LS.progress, {}));
  var mynotes = normalizeNotes(load(LS.notes, {}));

  var sync = null;          // 由 boot() 创建
  var authUserKey = '';     // 用于判断账号状态是否变化
  var authAvailKey = null;  // 后端可用性是否变化（首页卡片依赖它）

  var state = {
    mode: settings.defaultMode === 'flow' ? 'flow' : 'focus',
    reader: null,      // {ci, si, pos, revealed:{}}
    searchQuery: '',
    glossaryCh: 'all',
    authTab: 'login'
  };

  /* ----------------------------- 工具 ----------------------------- */
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function escapeAttr(s) { return escapeHtml(s).replace(/\n/g, ' '); }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  var FLAT_CACHE = null;
  function flatSections() {
    if (FLAT_CACHE) return FLAT_CACHE;
    if (!BOOK) return [];
    var arr = [];
    BOOK.chapters.forEach(function (ch, ci) {
      ch.sections.forEach(function (sec, si) {
        arr.push({ ci: ci, si: si, ch: ch, sec: sec });
      });
    });
    FLAT_CACHE = arr;
    return arr;
  }

  /** 全书顺序上相邻的一节（delta = -1 上一节，1 下一节） */
  function neighborSection(ci, si, delta) {
    var flat = flatSections();
    for (var i = 0; i < flat.length; i++) {
      if (flat[i].ci === ci && flat[i].si === si) return flat[i + delta] || null;
    }
    return null;
  }

  /** 这一节是否有过实际的阅读动作（只是打开过、什么都没做不算） */
  function hasReadMark(p) {
    if (!p) return false;
    if (p.done) return true;
    if (Number.isFinite(p.pos) && p.pos > 0) return true;
    if (p.revealed && Object.keys(p.revealed).length) return true;
    return Number.isFinite(p.at) && p.at > 0;
  }

  /** 读到过的、全书顺序最靠后的一节 */
  function furthestRead() {
    var flat = flatSections();
    for (var i = flat.length - 1; i >= 0; i--) {
      if (hasReadMark(progress[flat[i].sec.id])) return flat[i];
    }
    return null;
  }

  /** 全书第一处还没标记掌握的小节 */
  function firstUnreadSection() {
    var flat = flatSections();
    for (var i = 0; i < flat.length; i++) {
      if (!(progress[flat[i].sec.id] && progress[flat[i].sec.id].done)) return flat[i];
    }
    return flat[0] || null;
  }

  /** 首页的「继续阅读」按钮：主标题 + 目的地（篇 · 节） */
  function resumeButton(entry, primary, label) {
    var ch = BOOK.chapters[entry.ci];
    var sec = ch.sections[entry.si];
    return '<a class="btn' + (primary ? ' primary' : '') + ' resume" href="#/read/' + entry.ci + '/' + entry.si + '"' +
      ' title="' + escapeAttr(ch.title + ' · ' + sec.title) + '">' +
      '<span class="rb-label">' + escapeHtml(label) + '</span>' +
      '<span class="rb-sub">' + escapeHtml(ch.title) + ' · 第 ' + (entry.si + 1) + ' 节</span></a>';
  }

  function secProgress(id) {
    if (!progress[id]) progress[id] = { done: false, pos: 0, revealed: {}, at: 0 };
    if (!progress[id].revealed || typeof progress[id].revealed !== 'object') progress[id].revealed = {};
    if (!Number.isFinite(progress[id].at)) progress[id].at = 0;
    return progress[id];
  }

  /* --------- 保存并通知云同步 --------- */
  function syncSchedule() { if (sync) sync.schedule(); }
  function persistProgress() { save(LS.progress, progress); syncSchedule(); }
  function persistNotes() { save(LS.notes, mynotes); syncSchedule(); }
  /** 打上修改时间，供多设备之间逐节比较新旧 */
  function touch(entry) { entry.at = Date.now(); return entry; }

  /* --------- 逐句精读的推进逻辑（按钮、键盘、滑动共用） --------- */
  function focusState() {
    if (!state.reader) return null;
    var sec = BOOK.chapters[state.reader.ci] && BOOK.chapters[state.reader.ci].sections[state.reader.si];
    if (!sec) return null;
    var pr = secProgress(sec.id);
    return { sec: sec, pr: pr, pos: pr.pos || 0 };
  }
  function focusReveal() {
    var f = focusState(); if (!f) return;
    f.pr.revealed[f.pos] = true;
    touch(f.pr); persistProgress(); route();
  }
  function focusNext() {
    var f = focusState(); if (!f) return;
    f.pr.pos = Math.min(f.sec.pairs.length, f.pos + 1);
    touch(f.pr); persistProgress(); route();
  }
  /** 跳到另一节；pos 省略时沿用那一节自己保存的位置 */
  function goToSection(entry, pos) {
    var sec = entry && BOOK.chapters[entry.ci] && BOOK.chapters[entry.ci].sections[entry.si];
    if (!sec) return false;
    if (typeof pos === 'number') {
      var pr = secProgress(sec.id);
      pr.pos = Math.max(0, Math.min(pos, sec.pairs.length));
      touch(pr); persistProgress();
    }
    navigate('#/read/' + entry.ci + '/' + entry.si);
    return true;
  }
  /* 第一节按「上一句」＝ 回到上一节的最后一句 */
  function focusPrev() {
    var f = focusState(); if (!f) return;
    if (f.pos <= 0) {
      var prev = neighborSection(state.reader.ci, state.reader.si, -1);
      if (!prev) return;
      goToSection(prev, Math.max(0, prev.sec.pairs.length - 1));
      return;
    }
    f.pr.pos = Math.max(0, f.pos - 1);
    touch(f.pr); persistProgress(); route();
  }
  /* 先展开白话，已展开则进下一句；读完后进入下一节 */
  function focusAdvance() {
    var f = focusState(); if (!f) return;
    if (f.pos >= f.sec.pairs.length) {
      var next = neighborSection(state.reader.ci, state.reader.si, 1);
      if (!next) { toast('这已经是最后一节了'); return; }
      goToSection(next);
      return;
    }
    if (!f.pr.revealed[f.pos] && settings.defaultReveal !== 'shown') focusReveal();
    else focusNext();
  }

  function chapterStats(ch) {
    var done = 0, total = ch.sections.length;
    ch.sections.forEach(function (s) { if (progress[s.id] && progress[s.id].done) done++; });
    return { done: done, total: total, pct: total ? Math.round(done / total * 100) : 0 };
  }

  function overallStats() {
    var done = 0, total = 0;
    if (BOOK) BOOK.chapters.forEach(function (ch) {
      total += ch.sections.length;
      ch.sections.forEach(function (s) { if (progress[s.id] && progress[s.id].done) done++; });
    });
    return { done: done, total: total, pct: total ? Math.round(done / total * 100) : 0 };
  }

  /* --------- 把注释里的词语在原文里标出来，可点击 --------- */
  // 注释词条里可能带拼音（如「夙（sù）心」）或用顿号并列（如「石、斗」），
  // 匹配时先去掉拼音，再逐个尝试候选词。
  function stripPinyin(t) { return String(t).replace(/[（(][^）)]*[）)]/g, ''); }
  function matchKey(text, term) {
    var base = stripPinyin(term).trim();
    var cands = [base];
    if (/[、，,;；/]/.test(base)) cands = cands.concat(base.split(/[、，,;；/]/));
    cands = cands.map(function (x) { return x.trim(); })
      .filter(function (x) { return x.length >= 1; })
      .sort(function (a, b) { return b.length - a.length; });
    for (var i = 0; i < cands.length; i++) {
      if (text.indexOf(cands[i]) !== -1) return cands[i];
    }
    return null;
  }

  function decorate(text, notes) {
    var out = escapeHtml(text);
    if (!notes || !notes.length) return out;
    var items = notes
      .map(function (n) { return { t: n.term, e: n.explain, m: matchKey(out, n.term) }; })
      .filter(function (n) { return n.m; })
      .sort(function (a, b) { return b.m.length - a.m.length; });

    var matches = [];
    items.forEach(function (it) {
      var from = 0, idx;
      while ((idx = out.indexOf(it.m, from)) !== -1) {
        matches.push({ start: idx, end: idx + it.m.length, note: it });
        from = idx + it.m.length;
        if (it.m.length <= 1) break; // 单字词只标第一处，避免满屏标红
      }
    });
    matches.sort(function (a, b) { return a.start - b.start || b.end - a.end; });
    var chosen = [], last = -1;
    matches.forEach(function (m) { if (m.start >= last) { chosen.push(m); last = m.end; } });

    var res = '', pos = 0;
    chosen.forEach(function (m) {
      res += out.slice(pos, m.start);
      res += '<span class="term" data-term="' + escapeAttr(m.note.t) + '" data-explain="' + escapeAttr(m.note.e) + '">' +
        out.slice(m.start, m.end) + '</span>';
      pos = m.end;
    });
    res += out.slice(pos);
    return res;
  }

  /* ----------------------------- 主题 / 设置 ----------------------------- */
  function applySettings() {
    var root = document.documentElement;
    root.dataset.theme = settings.theme || 'paper';
    document.body.style.setProperty('--reading-size', FONT_SIZE[settings.fontSize] || FONT_SIZE.m);
    document.body.classList.toggle('writing-vertical', settings.writing === 'vertical');
    $$('.seg').forEach(function (seg) {
      var key = seg.dataset.setting;
      $$('button', seg).forEach(function (b) {
        b.classList.toggle('on', String(settings[key]) === String(b.dataset.val));
      });
    });
  }
  function setSetting(key, val) {
    settings[key] = val;
    save(LS.settings, settings);
    applySettings();
  }

  /* ----------------------------- 朗读 ----------------------------- */
  var voiceCache = null;
  function pickVoice() {
    if (!('speechSynthesis' in window)) return null;
    if (voiceCache) return voiceCache;
    var vs = window.speechSynthesis.getVoices() || [];
    voiceCache = vs.filter(function (v) { return /zh|Chinese/i.test(v.lang + ' ' + v.name); })[0] || null;
    return voiceCache;
  }
  function speak(text, rate) {
    if (!('speechSynthesis' in window)) { toast('当前浏览器不支持朗读功能'); return; }
    window.speechSynthesis.cancel();
    var u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    u.rate = parseFloat(rate || settings.speechRate) || 0.9;
    var v = pickVoice(); if (v) u.voice = v;
    window.speechSynthesis.speak(u);
  }
  if ('speechSynthesis' in window) {
    window.speechSynthesis.onvoiceschanged = function () { voiceCache = null; pickVoice(); };
  }

  /* ----------------------------- 浮层 / 提示 ----------------------------- */
  function showPopover(el) {
    var pop = $('#popover');
    pop.innerHTML = '<b>' + escapeHtml(el.dataset.term) + '</b>' + escapeHtml(el.dataset.explain);
    pop.hidden = false;
    var r = el.getBoundingClientRect();
    var pw = pop.offsetWidth, ph = pop.offsetHeight;
    var left = Math.min(Math.max(8, r.left + r.width / 2 - pw / 2), window.innerWidth - pw - 8);
    var top = r.top - ph - 10;
    pop.classList.toggle('below', top < 8);
    if (top < 8) top = r.bottom + 10;
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }
  function hidePopover() { $('#popover').hidden = true; }

  var toastTimer = null;
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 1900);
  }

  /* ----------------------------- 路由 ----------------------------- */
  function navigate(hash) { location.hash = hash; }

  function route() {
    hidePopover();
    var h = (location.hash || '#/').replace(/^#/, '');
    var parts = h.split('/').filter(function (x) { return x !== ''; });
    var view = $('#view');
    view.classList.toggle('wide', parts[0] === 'glossary' || parts.length === 0);

    if (!BOOK) {
      view.innerHTML = '<div class="empty"><h2>内容数据还没生成</h2>' +
        '<p>请先在项目目录运行 <code>python3 tools/build.py</code> 生成 <code>data/book.js</code>。</p></div>';
      return;
    }

    if (parts.length === 0) renderHome(view);
    else if (parts[0] === 'ch') renderChapter(view, parseInt(parts[1], 10));
    else if (parts[0] === 'read') renderReader(view, parseInt(parts[1], 10), parseInt(parts[2], 10));
    else if (parts[0] === 'glossary') renderGlossary(view);
    else if (parts[0] === 'mynotes') renderMyNotes(view);
    else renderHome(view);

    // 高亮导航
    var key = parts[0] === 'read' || parts[0] === 'ch' ? 'home' : parts[0];
    $$('[data-nav]').forEach(function (a) {
      a.classList.toggle('active', a.dataset.nav === key);
    });
    // 手机端：阅读时把底部标签栏换成逐句操作条
    document.body.classList.toggle('in-reader', parts[0] === 'read');
    document.body.classList.toggle('focus-mode', parts[0] === 'read' && state.mode === 'focus');

    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  /* ----------------------------- 首页 ----------------------------- */
  function renderHome(view) {
    var ov = overallStats();
    var last = load(LS.last, null);
    var lastEntry = null;
    if (last && typeof last.ci === 'number' && BOOK.chapters[last.ci] && BOOK.chapters[last.ci].sections[last.si]) {
      lastEntry = { ci: last.ci, si: last.si };
    }
    var farEntry = furthestRead();

    // 两个入口：上次读到的地方；读过的、全书顺序最靠后的一节
    var resumeHtml = '';
    if (lastEntry) {
      resumeHtml += resumeButton(lastEntry, true, '继续上次');
      if (farEntry) resumeHtml += resumeButton(farEntry, false, '读得最远');
    } else if (farEntry) {
      resumeHtml += resumeButton(farEntry, true, '继续阅读');
    } else {
      var fu = firstUnreadSection();
      if (fu) resumeHtml += resumeButton(fu, true, '开始阅读');
    }

    var html = '';
    html += '<section class="hero">';
    html += '<h1>' + escapeHtml(BOOK.title || '了凡四训') + '</h1>';
    html += '<div class="byline">' + escapeHtml(SITE.author) + '</div>';
    html += '<div class="tagline">' + escapeHtml(SITE.tagline) + '</div>';
    html += '<p class="lead">' + escapeHtml(SITE.lead) + '</p>';
    html += '</section>';

    html += '<div class="overall">';
    html += '<div class="ring" style="--p:' + ov.pct + '"><b>' + ov.pct + '%</b></div>';
    html += '<div class="overall-text"><strong>总进度 ' + ov.done + ' / ' + ov.total + ' 节</strong>' +
            '<span>每读完一节，可点「标记已掌握」，进度就记在这里。</span></div>';
    html += '<div class="overall-actions">' + resumeHtml + '</div>';
    html += '</div>';

    if (sync && sync.status.available) {
      var su = sync.status.user;
      html += '<div class="overall account-card">' +
        '<div class="ac-text"><strong>' +
          (su ? '已登录：' + escapeHtml(su.email) : '登录后可在多设备同步') + '</strong>' +
        '<span>' +
          (su ? escapeHtml(syncStatusText()) : '未登录时进度与笔记只存在本机，登录后自动合并上传。') +
        '</span></div>' +
        '<button class="btn" id="homeAccountBtn">' + (su ? '账号与同步' : '登录 / 注册') + '</button>' +
        '</div>';
    }

    html += '<div class="chapter-grid">';
    BOOK.chapters.forEach(function (ch, ci) {
      var st = chapterStats(ch);
      html += '<a class="chapter-card" data-ch="' + (ci + 1) + '" href="#/ch/' + ci + '">';
      html += '<div class="cc-index">第 ' + toChineseNum(ci + 1) + ' 篇</div>';
      html += '<h2>' + escapeHtml(ch.title) + '</h2>';
      html += ch.subtitle ? '<div class="cc-sub">' + escapeHtml(ch.subtitle) + '</div>' : '';
      html += '<p class="cc-intro">' + escapeHtml(ch.intro || '') + '</p>';
      html += '<div class="cc-foot"><div class="bar"><i style="width:' + st.pct + '%"></i></div>' +
              '<span>' + st.done + '/' + st.total + ' 节</span></div>';
      html += '</a>';
    });
    html += '</div>';

    html += '<div class="section-block"><h3>关于本书</h3><div class="prose">';
    SITE.about.forEach(function (p) { html += '<p>' + escapeHtml(p) + '</p>'; });
    html += '</div></div>';

    html += '<div class="section-block"><h3>怎么用这个网站</h3><div class="howto">';
    SITE.howto.forEach(function (it) {
      html += '<div class="hitem"><b>' + escapeHtml(it.b) + '</b><span>' + escapeHtml(it.s) + '</span></div>';
    });
    html += '</div></div>';

    view.innerHTML = html;
  }

  function toChineseNum(n) {
    return ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'][n] || String(n);
  }

  /* ----------------------------- 章节页 ----------------------------- */
  function renderChapter(view, ci) {
    var ch = BOOK.chapters[ci];
    if (!ch) { view.innerHTML = '<div class="empty"><h2>没有这一篇</h2></div>'; return; }
    var st = chapterStats(ch);
    var prev = BOOK.chapters[ci - 1], next = BOOK.chapters[ci + 1];

    var html = '';
    html += '<div class="crumb"><a href="#/">目录</a> / 第' + toChineseNum(ci + 1) + '篇</div>';
    html += '<header class="chapter-head">';
    html += '<div class="ch-no">第 ' + toChineseNum(ci + 1) + ' 篇 · 共 ' + ch.sections.length + ' 节</div>';
    html += '<h1>' + escapeHtml(ch.title) + '</h1>';
    if (ch.subtitle) html += '<div class="ch-sub">' + escapeHtml(ch.subtitle) + '</div>';
    html += '</header>';

    html += '<div class="overall"><div class="ring" style="--p:' + st.pct + '"><b>' + st.pct + '%</b></div>' +
            '<div class="overall-text"><strong>已掌握 ' + st.done + ' / ' + st.total + ' 节</strong>' +
            '<span>' + (st.pct === 100 ? '这一篇已经读完了。' : '一节一节来，不必急。') + '</span></div>' +
            '<a class="btn primary" href="#/read/' + ci + '/' + firstUnreadIndex(ch) + '">' +
            (st.done ? '从头重读' : '从第一节开始') + '</a></div>';

    if (ch.intro) html += '<div class="chapter-intro">' + paragraphs(ch.intro) + '</div>';

    html += '<div class="sec-list">';
    ch.sections.forEach(function (sec, si) {
      var p = progress[sec.id] || {};
      html += '<a class="sec-item' + (p.done ? ' done' : '') + '" href="#/read/' + ci + '/' + si + '">';
      html += '<span class="sec-no">' + (si + 1) + '</span>';
      html += '<span class="sec-title">' + escapeHtml(sec.title) + '</span>';
      if (mynotes[sec.id] && mynotes[sec.id].text) html += '<span class="sec-meta">有笔记</span>';
      html += '<span class="sec-meta">' + sec.pairs.length + ' 句</span>';
      if (p.done) html += '<span class="sec-check">✓</span>';
      html += '</a>';
    });
    html += '</div>';

    html += '<div class="reader-foot">';
    if (prev) html += '<a class="btn ghost small" href="#/ch/' + (ci - 1) + '">← ' + escapeHtml(prev.title) + '</a>';
    html += '<span class="spacer"></span>';
    if (next) html += '<a class="btn ghost small" href="#/ch/' + (ci + 1) + '">' + escapeHtml(next.title) + ' →</a>';
    html += '</div>';

    view.innerHTML = html;
  }

  function paragraphs(text) {
    return String(text).split(/\n+/).filter(Boolean).map(function (p) {
      return '<p>' + escapeHtml(p) + '</p>';
    }).join('');
  }

  function firstUnreadIndex(ch) {
    for (var i = 0; i < ch.sections.length; i++) {
      if (!(progress[ch.sections[i].id] && progress[ch.sections[i].id].done)) return i;
    }
    return 0;
  }

  /* ----------------------------- 阅读页 ----------------------------- */
  function renderReader(view, ci, si) {
    var ch = BOOK.chapters[ci];
    if (!ch || !ch.sections[si]) { view.innerHTML = '<div class="empty"><h2>没有这一节</h2><p><a href="#/">回到目录</a></p></div>'; return; }
    var sec = ch.sections[si];
    var pr = secProgress(sec.id);
    save(LS.last, { ci: ci, si: si });

    state.reader = { ci: ci, si: si, id: sec.id };

    var html = '';
    html += '<div class="reader">';

    // 顶部
    html += '<div class="reader-top">';
    html += '<a href="#/ch/' + ci + '">' + escapeHtml(ch.title) + '</a><span>/</span>';
    html += '<span class="rt-title">第 ' + (si + 1) + ' 节</span>';
    html += '<span class="spacer"></span>';
    html += '<div class="seg-control">' +
            '<button data-mode="focus" class="' + (state.mode === 'focus' ? 'on' : '') + '">逐句精读</button>' +
            '<button data-mode="flow" class="' + (state.mode === 'flow' ? 'on' : '') + '">通篇对照</button></div>';
    html += '<button class="btn small ghost" id="speakSection">朗读</button>';
    if (state.mode === 'flow') html += '<button class="btn small ghost" id="toggleAll">全部展开</button>';
    html += '</div>';

    html += '<header class="sec-heading">';
    html += '<div class="sec-pos">' + escapeHtml(ch.title) + ' · ' + (si + 1) + ' / ' + ch.sections.length + '</div>';
    html += '<h1>' + escapeHtml(sec.title) + '</h1>';
    html += '</header>';

    var allRevealed = sec.pairs.every(function (_, i) { return pr.revealed[i]; });
    var defaultShown = settings.defaultReveal === 'shown';

    if (state.mode === 'focus') {
      html += renderFocus(sec, pr, allRevealed, defaultShown);
    } else {
      html += renderFlow(sec, pr, defaultShown);
    }

    // 注释
    if (sec.notes && sec.notes.length) {
      html += '<section class="panel"><div class="panel-head"><h3>字词注释</h3>' +
              '<span class="count">' + sec.notes.length + ' 条</span></div>' +
              '<div class="note-cards">';
      sec.notes.forEach(function (n) {
        html += '<div class="note-card"><b>' + escapeHtml(n.term) + '</b>' + escapeHtml(n.explain) + '</div>';
      });
      html += '</div></section>';
    }

    // 心得
    if (sec.insight) {
      html += '<section class="panel"><div class="panel-head"><h3>这一节在说什么</h3></div>' +
              '<div class="insight-card"><span class="ilabel">心得</span>' + escapeHtml(sec.insight) + '</div></section>';
    }

    // 我的笔记
    html += '<section class="panel mynote-box"><div class="panel-head"><h3>我的笔记</h3>' +
            '<span class="spacer"></span><span class="count" id="noteState"></span></div>' +
            '<textarea id="myNote" placeholder="写点自己的想法、疑问或要记住的话…（自动保存在本机）"></textarea>' +
            '</section>';

    html += '</div>';
    view.innerHTML = html;

    // 恢复笔记
    var ta = $('#myNote');
    if (ta) {
      ta.value = (mynotes[sec.id] && mynotes[sec.id].text) || '';
      var stateEl = $('#noteState');
      if (ta.value) stateEl.textContent = '已保存';
      var timer = null;
      ta.addEventListener('input', function () {
        clearTimeout(timer);
        timer = setTimeout(function () {
          // 清空也要记录（空文本 = 已删除的墓碑），否则其它设备会把旧笔记传回来
          mynotes[sec.id] = { text: ta.value, at: Date.now() };
          persistNotes();
          stateEl.textContent = ta.value
            ? '已保存 ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
            : '已清空';
        }, 500);
      });
    }
  }

  function renderFocus(sec, pr, allRevealed, defaultShown) {
    var pos = Math.min(pr.pos || 0, sec.pairs.length);
    var html = '<div class="focus-stage">';

    // 进度点
    html += '<div class="dots">';
    sec.pairs.forEach(function (_, i) {
      var cls = i === pos ? 'now' : (pr.revealed[i] || defaultShown || i < pos ? 'seen' : '');
      html += '<i class="' + cls + '" data-dot="' + i + '"></i>';
    });
    html += '</div>';

    if (pos >= sec.pairs.length) {
      html += '<div class="finish-box" style="margin:auto">' +
              '<p>这一节的 ' + sec.pairs.length + ' 句都读完了。</p>' +
              '<button class="btn primary" id="markDone2">' + (pr.done ? '已掌握' : '标记本节已掌握') + '</button>' +
              '</div>';
      html += '</div>';
      html += renderFocusBar(sec, pr, pos, false, true);
      return html;
    }

    var pair = sec.pairs[pos];
    var shown = pr.revealed[pos] || defaultShown;
    html += '<div class="focus-body">';
    html += '<p class="orig-line" id="focusOrig">' + decorate(pair.orig, sec.notes) + '</p>';
    html += '<div class="trans-box' + (shown ? ' reveal' : '') + '" id="focusTrans"' + (shown ? '' : ' hidden') + '>' +
            '<span class="tlabel">白话</span>' + escapeHtml(pair.trans) + '</div>';
    html += '</div>';

    html += '</div>';
    html += renderFocusBar(sec, pr, pos, shown, false);
    return html;
  }

  /* 逐句精读的操作条：渲染在白色卡片之外，靠 CSS 固定在视口底部，始终可见 */
  function renderFocusBar(sec, pr, pos, shown, finished) {
    var prevS = neighborSection(state.reader.ci, state.reader.si, -1);
    var nextS = neighborSection(state.reader.ci, state.reader.si, 1);
    var canPrev = pos > 0 || !!prevS;

    var html = '<div class="focus-actions"><div class="fa-inner">';
    html += '<button class="btn small" id="prevPair"' + (canPrev ? '' : ' disabled') + '>上一句</button>';
    if (!finished) {
      if (!shown) {
        html += '<button class="btn small primary" id="revealBtn">看白话</button>';
      } else if (pos < sec.pairs.length - 1) {
        html += '<button class="btn small primary" id="nextPair">下一句 →</button>';
      } else {
        html += '<button class="btn small primary" id="nextPair">读完了</button>';
      }
    }
    var tip = finished
      ? (nextS ? '空格 → 下一节' : '这已经是最后一节')
      : '点原文也能显示白话 · 空格 → 下一句';
    html += '<span class="tip">' + tip + '</span>';
    html += '</div></div>';
    return html;
  }

  function renderFlow(sec, pr, defaultShown) {
    var html = '<div class="flow-list">';
    sec.pairs.forEach(function (pair, i) {
      var shown = pr.revealed[i] || defaultShown;
      html += '<div class="pair' + (shown ? ' opened' : '') + '" data-pair="' + i + '">';
      html += '<p class="orig-line">' + decorate(pair.orig, sec.notes) + '</p>';
      html += '<div class="pair-click-hint">点击这一句，看白话翻译</div>';
      html += '<div class="trans-box reveal"><span class="tlabel">白话</span>' + escapeHtml(pair.trans) + '</div>';
      html += '</div>';
    });
    html += '</div>';

    // 通篇模式没有逐句操作条，标记入口放在整节末尾
    html += '<div class="flow-foot"><button class="btn' + (pr.done ? '' : ' primary') + '" id="markDone">' +
            (pr.done ? '✓ 已掌握（点击取消）' : '标记本节已掌握') + '</button></div>';
    return html;
  }

  /* ----------------------------- 字词表 ----------------------------- */
  function renderGlossary(view) {
    var all = [];
    BOOK.chapters.forEach(function (ch, ci) {
      ch.sections.forEach(function (sec) {
        (sec.notes || []).forEach(function (n) {
          all.push({ term: n.term, explain: n.explain, ch: ci, chTitle: ch.title, sec: sec });
        });
      });
    });
    // 去重（同一词条、同一解释）
    var seen = {}, uniq = [];
    all.forEach(function (n) {
      var k = n.term + '|' + n.explain;
      if (!seen[k]) { seen[k] = 1; uniq.push(n); }
    });
    uniq.sort(function (a, b) { return a.term.localeCompare(b.term, 'zh'); });

    var filtered = state.glossaryCh === 'all' ? uniq : uniq.filter(function (n) { return n.ch === state.glossaryCh; });

    var html = '';
    html += '<div class="crumb"><a href="#/">目录</a> / 字词注释</div>';
    html += '<header class="chapter-head"><h1>字词注释</h1>' +
            '<div class="ch-sub">全书 ' + uniq.length + ' 条，按词语排序</div></header>';
    html += '<div class="glossary-filter">';
    html += '<button class="chip' + (state.glossaryCh === 'all' ? ' on' : '') + '" data-gch="all">全部</button>';
    BOOK.chapters.forEach(function (ch, ci) {
      html += '<button class="chip' + (state.glossaryCh === ci ? ' on' : '') + '" data-gch="' + ci + '">' + escapeHtml(ch.title) + '</button>';
    });
    html += '</div>';

    html += '<div class="glossary-grid">';
    filtered.forEach(function (n) {
      html += '<div class="gloss-item" data-goto="' + n.ch + '/' + BOOK.chapters[n.ch].sections.indexOf(n.sec) + '">';
      html += '<span class="g-ch">' + escapeHtml(n.chTitle) + '</span>';
      html += '<b>' + escapeHtml(n.term) + '</b>';
      html += '<p>' + escapeHtml(n.explain) + '</p>';
      html += '<div class="g-src">出自：' + escapeHtml(n.sec.title) + '</div>';
      html += '</div>';
    });
    html += '</div>';
    if (!filtered.length) html += '<div class="empty">这一类还没有词条。</div>';

    view.innerHTML = html;
  }

  /* ----------------------------- 我的笔记 ----------------------------- */
  function renderMyNotes(view) {
    var entries = [];
    BOOK.chapters.forEach(function (ch, ci) {
      ch.sections.forEach(function (sec, si) {
        if (mynotes[sec.id] && mynotes[sec.id].text) {
          entries.push({ ci: ci, si: si, ch: ch, sec: sec, text: mynotes[sec.id].text });
        }
      });
    });
    var html = '';
    html += '<div class="crumb"><a href="#/">目录</a> / 我的笔记</div>';
    html += '<header class="chapter-head"><h1>我的笔记</h1>' +
            '<div class="ch-sub">共 ' + entries.length + ' 条 · 只保存在本机浏览器</div></header>';
    if (!entries.length) {
      html += '<div class="empty"><h2>还没有笔记</h2><p>读到有想法的地方，在页面底部写几句，就会出现在这里。</p>' +
              '<p style="margin-top:16px"><a class="btn primary" href="#/">去阅读</a></p></div>';
    } else {
      html += '<div class="mynote-list">';
      entries.forEach(function (e) {
        html += '<div class="mynote-entry">';
        html += '<div class="me-head"><b>' + escapeHtml(e.sec.title) + '</b>' +
                '<span>' + escapeHtml(e.ch.title) + ' · 第 ' + (e.si + 1) + ' 节</span></div>';
        html += '<div class="me-body">' + escapeHtml(e.text) + '</div>';
        html += '<div class="me-actions"><a class="btn ghost small" href="#/read/' + e.ci + '/' + e.si + '">回到这一节</a></div>';
        html += '</div>';
      });
      html += '</div>';
    }
    view.innerHTML = html;
  }

  /* ----------------------------- 搜索 ----------------------------- */
  function buildIndex() {
    var idx = [];
    BOOK.chapters.forEach(function (ch, ci) {
      ch.sections.forEach(function (sec, si) {
        idx.push({
          ci: ci, si: si,
          chTitle: ch.title,
          title: sec.title,
          orig: sec.pairs.map(function (p) { return p.orig; }).join(''),
          trans: sec.pairs.map(function (p) { return p.trans; }).join(' '),
          notes: (sec.notes || []).map(function (n) { return n.term + '：' + n.explain; }).join(' ')
        });
      });
    });
    return idx;
  }
  var SEARCH_INDEX = null;

  function doSearch(q) {
    if (!SEARCH_INDEX) SEARCH_INDEX = buildIndex();
    q = q.trim();
    if (!q) return [];
    var lq = q.toLowerCase();
    var res = [];
    SEARCH_INDEX.forEach(function (it) {
      var fields = [
        { name: 'title', text: it.title },
        { name: 'orig', text: it.orig },
        { name: 'trans', text: it.trans },
        { name: 'notes', text: it.notes }
      ];
      var best = null;
      fields.forEach(function (f) {
        var t = f.text, lt = t.toLowerCase(), i = lt.indexOf(lq);
        if (i === -1) return;
        var snippet = t.slice(Math.max(0, i - 24), i + q.length + 40);
        if (!best || f.name === 'title') best = { field: f.name, snippet: snippet, at: i };
      });
      if (best) {
        var score = (best.field === 'title' ? 100 : 0) + (best.field === 'orig' ? 10 : 0);
        res.push({ it: it, best: best, score: score, count: (it.orig.split(q).length - 1) + (it.trans.split(q).length - 1) });
      }
    });
    res.sort(function (a, b) { return (b.score + b.count * 3) - (a.score + a.count * 3); });
    return res;
  }

  function renderSearchResults(q) {
    var box = $('#searchResults');
    if (!q.trim()) {
      box.innerHTML = '<p class="search-hint">输入关键词，例如「立命」「云谷」「谦虚」「杀生」。</p>';
      return;
    }
    var res = doSearch(q);
    if (!res.length) {
      box.innerHTML = '<p class="search-hint">没有找到「' + escapeHtml(q) + '」。换个词试试？</p>';
      return;
    }
    var html = '<div class="sr-group">找到 ' + res.length + ' 节</div>';
    res.slice(0, 40).forEach(function (r) {
      html += '<a class="sr-item" href="#/read/' + r.it.ci + '/' + r.it.si + '">';
      html += '<div class="sr-ch">' + escapeHtml(r.it.chTitle) + '</div>';
      html += '<div class="sr-title">' + hl(r.it.title, q) + '</div>';
      html += '<div class="sr-text">' + hl(r.best.snippet, q) + '…</div>';
      html += '</a>';
    });
    box.innerHTML = html;
  }
  function hl(text, q) {
    var e = escapeHtml(text);
    var eq = escapeHtml(q);
    if (!eq) return e;
    try {
      return e.replace(new RegExp(eq.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), function (m) {
        return '<mark>' + m + '</mark>';
      });
    } catch (err) { return e; }
  }

  /* ----------------------------- 账号与同步 ----------------------------- */
  function timeAgo(ts) {
    var d = Date.now() - ts;
    if (d < 60000) return '刚刚';
    if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
    if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
    return Math.floor(d / 86400000) + ' 天前';
  }

  function syncStatusText() {
    if (!sync) return '';
    var st = sync.status;
    if (st.phase === 'checking') return '正在检查登录状态…';
    if (st.phase === 'syncing') return '正在同步…';
    if (st.phase === 'error') return '同步失败：' + (st.error || '未知错误');
    if (st.pending) return '有改动待同步…';
    if (st.lastSyncAt) return '已同步 · ' + timeAgo(st.lastSyncAt);
    return '已登录';
  }

  /** 刷新顶栏圆点与页脚说明（不会动到正在输入的界面） */
  function updateAccountChrome() {
    var dot = $('#accountDot');
    var btn = $('#accountBtn');
    var footer = $('#footerSyncNote');
    if (!dot || !btn) return;

    var available = !!(sync && sync.status.available !== false);
    btn.hidden = !available;
    if (!available) {
      if (footer) footer.textContent = '进度与笔记保存在这台设备的浏览器里';
      return;
    }

    var st = sync.status;
    var cls = '';
    if (st.phase === 'error') cls = 'bad';
    else if (st.phase === 'syncing' || st.phase === 'checking' || st.pending) cls = 'busy';
    dot.className = 'account-dot' + (cls ? ' ' + cls : '');
    dot.hidden = !st.user && st.phase !== 'error';
    btn.title = st.user ? ('已登录：' + st.user.email) : '账号与同步';

    if (footer) {
      footer.textContent = st.user
        ? '进度与笔记已与账号同步，换设备登录同一账号即可接着读'
        : '未登录时进度与笔记只存在本机，登录后自动同步';
    }
  }

  function renderAuthBody() {
    var body = $('#authBody');
    var heading = $('#authHeading');
    var sub = $('#authSub');
    if (!body) return;

    if (!sync) return;

    if (sync.status.available === false) {
      heading.textContent = '账号';
      sub.textContent = '当前是纯静态版本，没有后端，所以无法登录。';
      body.innerHTML = '<p class="auth-hint">账号与云同步需要在 Cloudflare 部署的版本上使用。' +
        '本机版本的全部阅读功能都正常，进度与笔记保存在这台设备的浏览器里。</p>';
      return;
    }

    var st = sync.status;

    if (st.user) {
      heading.textContent = '账号与同步';
      sub.textContent = '已登录。阅读进度与笔记会在这台设备和云端之间自动合并。';
      var initial = (st.user.email || '?').charAt(0).toUpperCase();
      body.innerHTML =
        '<div class="auth-user">' +
          '<div class="auth-avatar">' + escapeHtml(initial) + '</div>' +
          '<div><div class="au-mail">' + escapeHtml(st.user.email) + '</div>' +
          '<div class="au-state" id="authState">' + escapeHtml(syncStatusText()) + '</div></div>' +
        '</div>' +
        '<div class="auth-actions">' +
          '<button class="btn" id="authSyncNow">立即同步</button>' +
          '<button class="btn ghost" id="authLogout">退出登录</button>' +
        '</div>' +
        '<p class="auth-hint">退出登录不会删除本机数据，只是停止同步。' +
        '这个账号与 esatmock.redwallen.cn 通用，在那里登录过的账号可直接使用。</p>';

      $('#authSyncNow').addEventListener('click', function () { sync.syncNow(); });
      $('#authLogout').addEventListener('click', function () {
        sync.logout().then(function () { toast('已退出登录，本机数据保留'); });
      });
      return;
    }

    var isSignup = state.authTab === 'signup';
    heading.textContent = '账号与同步';
    sub.textContent = '登录后，阅读进度和笔记会自动同步到云端，换设备也能接着读。';
    body.innerHTML =
      '<div class="auth-tabs">' +
        '<button type="button" data-tab="login" class="' + (isSignup ? '' : 'on') + '">登录</button>' +
        '<button type="button" data-tab="signup" class="' + (isSignup ? 'on' : '') + '">注册</button>' +
      '</div>' +
      '<form id="authForm" novalidate>' +
        '<div class="auth-field"><label for="authEmail">邮箱</label>' +
          '<input id="authEmail" type="email" autocomplete="email" placeholder="you@example.com"></div>' +
        '<div class="auth-field"><label for="authPassword">密码</label>' +
          '<input id="authPassword" type="password" placeholder="至少 8 位" autocomplete="' +
            (isSignup ? 'new-password' : 'current-password') + '"></div>' +
        '<div class="auth-error" id="authError"></div>' +
        '<div class="auth-actions"><button class="btn primary" type="submit" id="authSubmit">' +
          (isSignup ? '注册并登录' : '登录') + '</button></div>' +
      '</form>' +
      '<p class="auth-hint">这个账号与 esatmock.redwallen.cn 共用一套，注册一次两边都能登录。' +
      '未登录时进度只存在本机，登录后会自动合并上传。</p>';

    $$('.auth-tabs button', body).forEach(function (b) {
      b.addEventListener('click', function () {
        state.authTab = b.dataset.tab;
        renderAuthBody();
      });
    });

    $('#authForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var email = $('#authEmail').value.trim();
      var password = $('#authPassword').value;
      var errEl = $('#authError');
      var submit = $('#authSubmit');
      errEl.textContent = '';
      if (!email) { errEl.textContent = '请填写邮箱。'; return; }
      if (password.length < 8) { errEl.textContent = '密码至少 8 位。'; return; }
      submit.disabled = true;
      submit.textContent = '处理中…';
      var action = state.authTab === 'signup' ? sync.signup : sync.login;
      action(email, password).then(function () {
        toast(state.authTab === 'signup' ? '注册成功，已开始同步' : '登录成功，已开始同步');
      }).catch(function (err) {
        errEl.textContent = (err && err.message) || '操作失败，请稍后重试。';
        submit.disabled = false;
        submit.textContent = state.authTab === 'signup' ? '注册并登录' : '登录';
      });
    });
  }

  function onSyncStatus() {
    updateAccountChrome();
    var userKey = sync && sync.status.user ? sync.status.user.id : '';
    var availKey = sync ? String(sync.status.available) : 'null';

    if (userKey === authUserKey && availKey === authAvailKey) {
      var el = $('#authState');
      if (el) el.textContent = syncStatusText();
      return;
    }

    authUserKey = userKey;
    authAvailKey = availKey;
    // 退出登录后回到「登录」标签，否则再填一次会变成重复注册
    if (!userKey) state.authTab = 'login';
    if (!$('#authModal').hidden) renderAuthBody();

    // 首页与章节页的账号信息依赖登录态，状态明确后重绘一次
    var path = (location.hash || '#/').replace(/^#/, '');
    if ((path === '' || path === '/' || /^\/ch\//.test(path)) && sync.status.available !== null) {
      route();
    }
  }

  function createSync() {
    if (typeof window.createLiaofanSync !== 'function') return;
    sync = window.createLiaofanSync({
      getLocal: function () { return { progress: progress, notes: mynotes }; },
      onRemote: function () {
        save(LS.progress, progress);
        save(LS.notes, mynotes);
        route();
      },
      onStatus: onSyncStatus
    });
    sync.start();
  }

  function openAuth() {
    $('#authMask').hidden = false;
    $('#authModal').hidden = false;
    renderAuthBody();
  }
  function closeAuth() {
    $('#authMask').hidden = true;
    $('#authModal').hidden = true;
  }

  /* ----------------------------- 抽屉 / 弹层开关 ----------------------------- */
  function openSettings() {
    $('#settingsDrawer').hidden = false;
    $('#drawerMask').hidden = false;
  }
  function closeSettings() {
    $('#settingsDrawer').hidden = true;
    $('#drawerMask').hidden = true;
  }
  function openSearch() {
    $('#searchModal').hidden = false;
    $('#searchMask').hidden = false;
    var inp = $('#searchInput');
    inp.value = state.searchQuery || '';
    renderSearchResults(inp.value);
    setTimeout(function () { inp.focus(); }, 30);
  }
  function closeSearch() {
    $('#searchModal').hidden = true;
    $('#searchMask').hidden = true;
  }

  /* ----------------------------- 事件绑定 ----------------------------- */
  function bindOnce() {
    window.addEventListener('hashchange', route);

    $('#settingsBtn').addEventListener('click', openSettings);
    $('#tabSettings').addEventListener('click', openSettings);
    $('#closeSettings').addEventListener('click', closeSettings);
    $('#drawerMask').addEventListener('click', closeSettings);

    $('#searchBtn').addEventListener('click', openSearch);
    $('#accountBtn').addEventListener('click', openAuth);
    $('#closeAuth').addEventListener('click', closeAuth);
    $('#authMask').addEventListener('click', closeAuth);
    $('#closeSearch').addEventListener('click', closeSearch);
    $('#searchMask').addEventListener('click', closeSearch);
    $('#searchInput').addEventListener('input', function (e) {
      state.searchQuery = e.target.value;
      renderSearchResults(e.target.value);
    });

    // 设置项
    $$('.seg').forEach(function (seg) {
      seg.addEventListener('click', function (e) {
        var b = e.target.closest('button[data-val]');
        if (!b) return;
        setSetting(seg.dataset.setting, b.dataset.val);
        if (seg.dataset.setting === 'defaultMode') {
          // 立即切换当前阅读视图
          if (/^#\/read\//.test(location.hash)) {
            state.mode = b.dataset.val === 'flow' ? 'flow' : 'focus';
            route();
          } else {
            state.mode = b.dataset.val === 'flow' ? 'flow' : 'focus';
          }
        }
      });
    });

    $('#resetProgress').addEventListener('click', function () {
      var loggedIn = !!(sync && sync.isLoggedIn());
      var msg = loggedIn
        ? '确定清除全部阅读进度、已掌握标记和笔记吗？\n\n你已经登录，云端记录也会一并清除，且无法撤销。'
        : '确定清除全部阅读进度、已掌握标记和笔记吗？此操作不可撤销。';
      if (!confirm(msg)) return;
      progress = {};
      mynotes = {};
      save(LS.progress, progress);
      save(LS.notes, mynotes);
      save(LS.last, null);
      if (loggedIn) sync.clearRemote();
      toast(loggedIn ? '已清除本机与云端记录' : '已清除');
      route();
    });

    // 主视图事件委托
    var view = $('#view');
    view.addEventListener('click', function (e) {
      var t = e.target;

      // 词条
      var term = t.closest('.term');
      if (term) { e.stopPropagation(); showPopover(term); return; }

      // 账号
      if (t.closest('#homeAccountBtn')) { openAuth(); return; }

      // 模式切换
      var modeBtn = t.closest('[data-mode]');
      if (modeBtn) { state.mode = modeBtn.dataset.mode; route(); return; }

      // 进度点
      var dot = t.closest('[data-dot]');
      if (dot && state.reader) {
        var pr = secProgress(state.reader.id);
        pr.pos = parseInt(dot.dataset.dot, 10);
        touch(pr); persistProgress();
        route();
        return;
      }

      // 逐句：看白话 / 上下句
      if ((t.closest('#revealBtn') || t.closest('#focusOrig')) && state.reader) {
        focusReveal();
        return;
      }
      if (t.closest('#nextPair') && state.reader) {
        focusNext();
        return;
      }
      if (t.closest('#prevPair') && state.reader) {
        focusPrev();
        return;
      }

      // 通篇：展开某句
      var pair = t.closest('.pair');
      if (pair && !t.closest('.term') && !t.closest('.trans-box')) {
        var i = parseInt(pair.dataset.pair, 10);
        pair.classList.toggle('opened');
        if (state.reader) {
          var pr5 = secProgress(state.reader.id);
          if (pair.classList.contains('opened')) pr5.revealed[i] = true;
          else delete pr5.revealed[i];
          touch(pr5); persistProgress();
        }
        return;
      }

      // 标记已掌握
      if ((t.closest('#markDone') || t.closest('#markDone2')) && state.reader) {
        var pr6 = secProgress(state.reader.id);
        pr6.done = !pr6.done;
        touch(pr6); persistProgress();
        toast(pr6.done ? '已标记为掌握' : '已取消标记');
        route();
        return;
      }

      // 朗读（整节）
      if (t.closest('#speakSection') && state.reader) {
        var sec2 = BOOK.chapters[state.reader.ci].sections[state.reader.si];
        speak(sec2.pairs.map(function (x) { return x.orig; }).join(''));
        return;
      }

      // 通篇模式：全部展开 / 收起
      if (t.closest('#toggleAll') && state.reader) {
        var pairs = $$('.pair', view);
        var allOpen = pairs.length > 0 && pairs.every(function (p) { return p.classList.contains('opened'); });
        var prT = secProgress(state.reader.id);
        pairs.forEach(function (p) {
          var i = parseInt(p.dataset.pair, 10);
          p.classList.toggle('opened', !allOpen);
          if (allOpen) delete prT.revealed[i]; else prT.revealed[i] = true;
        });
        touch(prT); persistProgress();
        t.closest('#toggleAll').textContent = allOpen ? '全部展开' : '全部收起';
        return;
      }

      // 字词表筛选
      var chip = t.closest('[data-gch]');
      if (chip) {
        state.glossaryCh = chip.dataset.gch === 'all' ? 'all' : parseInt(chip.dataset.gch, 10);
        route();
        return;
      }
      var gi = t.closest('[data-goto]');
      if (gi) {
        var parts = gi.dataset.goto.split('/');
        navigate('#/read/' + parts[0] + '/' + parts[1]);
        return;
      }
    });

    // 点击空白关闭浮层
    document.addEventListener('click', function (e) {
      if (!e.target.closest('.term') && !e.target.closest('#popover')) hidePopover();
    });
    // 点击搜索结果后关闭搜索面板
    $('#searchResults').addEventListener('click', function (e) {
      if (e.target.closest('.sr-item')) closeSearch();
    });

    // 键盘
    document.addEventListener('keydown', function (e) {
      var typing = /INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || '');
      if (e.key === 'Escape') { closeSearch(); closeSettings(); closeAuth(); hidePopover(); return; }
      if (typing) return;
      if (e.key === '/' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault(); openSearch(); return;
      }
      if (!state.reader || state.mode !== 'focus' || /^#\/read\//.test(location.hash) === false) return;
      if (e.key === ' ' || e.key === 'ArrowRight' || e.key === 'j') {
        e.preventDefault();
        focusAdvance();
      } else if (e.key === 'ArrowLeft' || e.key === 'k') {
        e.preventDefault();
        focusPrev();
      } else if (e.key === 'r') {
        e.preventDefault();
        focusReveal();
      }
    });

    // 手机滑动：左滑下一句（先展开白话），右滑上一句
    var touchStart = null;
    view.addEventListener('touchstart', function (e) {
      if (!state.reader || state.mode !== 'focus') { touchStart = null; return; }
      var t = e.changedTouches[0];
      touchStart = { x: t.clientX, y: t.clientY, target: e.target };
    }, { passive: true });
    view.addEventListener('touchend', function (e) {
      var s = touchStart; touchStart = null;
      if (!s) return;
      var t = e.changedTouches[0];
      var dx = t.clientX - s.x, dy = t.clientY - s.y;
      // 水平位移要够大、且明显大于垂直位移，避免和滚动、点击冲突
      if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      var el = s.target;
      if (el && el.closest && (el.closest('.btn') || el.closest('.term') || el.closest('a') || el.closest('textarea') || el.closest('.dots'))) return;
      if (dx < 0) focusAdvance(); else focusPrev();
    }, { passive: true });

    window.addEventListener('resize', hidePopover);
    window.addEventListener('scroll', hidePopover, { passive: true });
  }

  /* ----------------------------- 启动 ----------------------------- */
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    var local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (location.protocol !== 'https:' && !local) return; // file:// 下不注册
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }

  function boot() {
    applySettings();
    createSync();
    bindOnce();
    route();
    registerSW();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
