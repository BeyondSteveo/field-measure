/* Field Measure — storage layer.
 *
 * This is the ONLY file that knows where measurements are kept. The app talks to
 * window.FMStore and nothing else, so swapping Supabase for something else later
 * means rewriting this file and leaving the app alone.
 *
 * It is written to never block the app. If the network is down, the library fails
 * to load, or nobody is signed in, the app keeps working off its local copy and
 * the header just says so.
 */
(function () {
  'use strict';

  var CFG = window.FM_CONFIG || {};
  var client = null;          // supabase client, once the library is up
  var session = null;         // current auth session, or null
  var onStatus = function () {};
  var onRemote = function () {};
  var pushTimer = null;
  var pushing = false;
  var lastPushed = '';
  var pending = null;         // newest payload waiting to go out
  var ready = false;

  function status(mode) { try { onStatus(mode); } catch (e) {} }

  /* ---------- sign-in sheet ---------------------------------------------- */
  /* Kept in here rather than index.html so the whole auth story lives in one
     file. Styled off the app's existing CSS variables so it matches. */
  function sheet(html) {
    var w = document.createElement('div');
    w.style.cssText = 'position:fixed;inset:0;z-index:90;background:rgba(0,0,0,.5);' +
      'display:flex;align-items:flex-end';
    w.innerHTML = '<div style="width:100%;background:var(--surface,#fff);color:var(--ink,#111);' +
      'border-radius:14px 14px 0 0;padding:16px 16px calc(16px + env(safe-area-inset-bottom,0px));' +
      'display:flex;flex-direction:column;gap:11px;font-family:var(--body,system-ui)">' + html + '</div>';
    document.body.appendChild(w);
    return w;
  }

  function askToSignIn() {
    if (!client) {
      var n = sheet('<div style="font-size:15px;line-height:1.5">No connection right now, so ' +
        'signing in will have to wait. Your measurements are saving to this phone and will ' +
        'sync once you are back online.</div>' +
        '<button id="fmok" style="border:none;border-radius:9px;padding:13px;background:var(--surface-2,#eee);' +
        'color:var(--ink,#111);font-family:var(--display,system-ui);font-size:16px;letter-spacing:.06em;' +
        'text-transform:uppercase;font-weight:700">Close</button>');
      n.querySelector('#fmok').onclick = function () { n.remove(); };
      return;
    }
    if (session) {
      var s = sheet('<div style="font-family:var(--display,system-ui);font-size:19px;letter-spacing:.06em;' +
        'text-transform:uppercase;font-weight:700">Signed in</div>' +
        '<div style="font-size:14px;color:var(--ink-2,#666)">' + esc(session.user.email) + '</div>' +
        '<button id="fmout" style="border:none;border-radius:9px;padding:13px;background:var(--surface-2,#eee);' +
        'color:var(--ink,#111);font-family:var(--display,system-ui);font-size:16px;letter-spacing:.06em;' +
        'text-transform:uppercase;font-weight:700">Sign out</button>' +
        '<button id="fmcx" style="border:none;border-radius:9px;padding:11px;background:none;' +
        'color:var(--ink-2,#666);font-size:14px">Cancel</button>');
      s.querySelector('#fmcx').onclick = function () { s.remove(); };
      s.querySelector('#fmout').onclick = function () {
        s.remove();
        client.auth.signOut().then(function () { session = null; status('local'); });
      };
      return;
    }

    /* Email and password, typed straight into the app. No email is sent, so
       nothing here can be rate limited, and nothing has to redirect back from
       Safari into the home-screen app. */
    var btn = 'border:none;border-radius:9px;padding:13px;font-family:var(--display,system-ui);' +
      'font-size:16px;letter-spacing:.06em;text-transform:uppercase;font-weight:700';
    var fld = 'font-size:16px;padding:12px;border:2px solid var(--line,#ccc);border-radius:9px;' +
      'background:var(--surface-2,#f4f4f4);color:var(--ink,#111);width:100%';

    var box = sheet('<div id="fmtitle" style="font-family:var(--display,system-ui);font-size:19px;' +
      'letter-spacing:.06em;text-transform:uppercase;font-weight:700">Sign in to sync</div>' +
      '<div style="font-size:13.5px;line-height:1.5;color:var(--ink-2,#666)">Measurements save to this ' +
      'phone either way. Signing in is what gets them off it.</div>' +
      '<input id="fmem" type="email" inputmode="email" autocomplete="username" ' +
      'autocapitalize="none" autocorrect="off" placeholder="you@example.com" style="' + fld + '">' +
      '<input id="fmpw" type="password" autocomplete="current-password" ' +
      'placeholder="password" style="' + fld + '">' +
      '<div id="fmmsg" style="font-size:13px;line-height:1.45;min-height:18px;color:var(--ink-2,#666)"></div>' +
      '<button id="fmgo" style="' + btn + ';background:var(--accent,#ff5a1f);' +
      'color:var(--accent-ink,#fff)">Sign in</button>' +
      '<button id="fmswap" style="border:none;border-radius:9px;padding:11px;background:none;' +
      'color:var(--ink-2,#666);font-size:14px;text-decoration:underline">Create an account instead</button>' +
      '<button id="fmcx" style="border:none;border-radius:9px;padding:11px;background:none;' +
      'color:var(--ink-2,#666);font-size:14px">Not now</button>');

    var msg = box.querySelector('#fmmsg');
    var go = box.querySelector('#fmgo');
    var title = box.querySelector('#fmtitle');
    var swap = box.querySelector('#fmswap');
    var pw = box.querySelector('#fmpw');
    var creating = false;

    swap.onclick = function () {
      creating = !creating;
      title.textContent = creating ? 'Create an account' : 'Sign in to sync';
      go.textContent = creating ? 'Create account' : 'Sign in';
      swap.textContent = creating ? 'I already have an account' : 'Create an account instead';
      pw.setAttribute('autocomplete', creating ? 'new-password' : 'current-password');
      msg.textContent = creating ? 'Pick something at least 8 characters.' : '';
    };

    box.querySelector('#fmcx').onclick = function () { box.remove(); };

    function submit() {
      var email = (box.querySelector('#fmem').value || '').trim();
      var pass = pw.value || '';
      if (!email || !pass) { msg.textContent = 'Fill in both boxes.'; return; }
      if (creating && pass.length < 8) { msg.textContent = 'Use at least 8 characters.'; return; }
      go.disabled = true;
      msg.textContent = creating ? 'Creating...' : 'Signing in...';

      var call = creating
        ? client.auth.signUp({ email: email, password: pass })
        : client.auth.signInWithPassword({ email: email, password: pass });

      call.then(function (r) {
        go.disabled = false;
        if (r.error) {
          var m = (r.error.message || '').toLowerCase();
          if (m.indexOf('already registered') !== -1) {
            msg.textContent = 'That email already has an account. Sign in instead.';
          } else if (m.indexOf('invalid login') !== -1) {
            msg.textContent = 'Email or password not right.';
          } else {
            msg.textContent = r.error.message || 'That did not go through.';
          }
          return;
        }
        if (!r.data || !r.data.session) {
          /* Only happens if the project still requires email confirmation. */
          msg.textContent = 'Account made, but it needs confirming by email first.';
          return;
        }
        box.remove();
      }, function () {
        go.disabled = false;
        msg.textContent = 'Could not reach the server.';
      });
    }

    go.onclick = submit;
    pw.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------- pulling and pushing ---------------------------------------- */
  function pull() {
    if (!client || !session) return Promise.resolve(null);
    return client.from(CFG.table)
      .select('payload,updated')
      .eq('user_id', session.user.id)
      .maybeSingle()
      .then(function (r) {
        if (r.error) return null;
        if (!r.data || !r.data.payload) return null;
        var p = r.data.payload;
        return (typeof p === 'string') ? JSON.parse(p) : p;
      }, function () { return null; });
  }

  function pushNow() {
    if (!client || !session || pushing) return Promise.resolve(false);
    var db = pending;
    if (!db) return Promise.resolve(false);
    var body = JSON.stringify(db);
    if (body === lastPushed) { status('ok'); return Promise.resolve(true); }
    pushing = true;
    status('saving');
    return client.from(CFG.table).upsert({
      user_id: session.user.id,
      payload: db,
      updated: db.updated || Date.now()
    }, { onConflict: 'user_id' }).then(function (r) {
      pushing = false;
      if (r.error) { status('err'); return false; }
      lastPushed = body;
      status('ok');
      return true;
    }, function () { pushing = false; status('err'); return false; });
  }

  /* ---------- public interface ------------------------------------------- */
  window.FMStore = {

    /* Called once at startup. opts.onStatus(mode) drives the header text;
       opts.onRemote(db) is handed a newer copy from the server, if there is one. */
    init: function (opts) {
      opts = opts || {};
      onStatus = opts.onStatus || onStatus;
      onRemote = opts.onRemote || onRemote;
      status('connecting');

      if (!window.supabase || !CFG.supabaseUrl || !CFG.supabaseKey) {
        ready = true; status('local'); return Promise.resolve();
      }
      try {
        client = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
        });
      } catch (e) { ready = true; status('local'); return Promise.resolve(); }

      client.auth.onAuthStateChange(function (_e, s) {
        var was = !!session;
        session = s || null;
        if (session && !was) { pull().then(handlePulled); }
        if (!session) status('local');
      });

      return client.auth.getSession().then(function (r) {
        session = (r && r.data && r.data.session) || null;
        ready = true;
        if (!session) { status('local'); return; }
        return pull().then(handlePulled);
      }, function () { ready = true; status('local'); });

      function handlePulled(remote) {
        if (remote && remote.jobs && remote.jobs.length) {
          try { onRemote(remote); } catch (e) {}
        }
        if (pending) return pushNow();
        status('ok');
      }
    },

    /* Called by the app's save(). Debounced — rapid taps make one write. */
    push: function (db) {
      pending = db;
      if (!client || !session) { status(ready ? 'local' : 'connecting'); return; }
      if (pushTimer) clearTimeout(pushTimer);
      pushTimer = setTimeout(function () { pushTimer = null; pushNow(); }, 1200);
    },

    /* Force an immediate write — used when the app is being backgrounded. */
    flush: function () { if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; } return pushNow(); },

    signedIn: function () { return !!session; },
    email: function () { return session ? session.user.email : null; },
    prompt: askToSignIn
  };

  /* Retry a failed write when the connection comes back, and save on the way out. */
  addEventListener('online', function () { if (session && pending) pushNow(); });
  addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden' && session && pending) pushNow();
  });
})();
