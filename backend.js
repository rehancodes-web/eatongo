/* eatongo backend layer (orders + realtime + Google login + roles)
   Add <script src="backend.js"></script> just before </body>
   Roles:  customer = anonymous Firebase user (no login)
           vendor   = verified email listed in  staff/<email> = {role:'vendor', outlet:'HARI-001'}
                      (orders only: no revenue, no menu editing, no staff management)
           admin    = Firebase user whose UID is listed in  admins/<uid> = true
                      (everything: revenue/profit, menu builder, restaurant info, staff)
   Security is enforced by database.rules.json - hiding things in the page is only cosmetic. */
(() => {
  'use strict';
  console.log('eatongo backend build 11');

  /* ====== FIREBASE CONFIG (leave databaseURL empty = local test mode, no login) ====== */
  const FIREBASE_CONFIG = {
    apiKey: "AIzaSyDQy3PGM914RE8A8Y50dHxjsVpeBDsJLZw",
    authDomain: "eatongohh.firebaseapp.com",
    databaseURL: "https://eatongohh-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "eatongohh",
    storageBucket: "eatongohh.firebasestorage.app",
    messagingSenderId: "768793879173",
    appId: "1:768793879173:web:d83a699ba459400d7a3fec",
    measurementId: "G-PL8P8QBSYG"
  };
  /* ================================================================================== */

  const USE_FIREBASE = !!FIREBASE_CONFIG.databaseURL;
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const today = () => new Date().toLocaleDateString('en-CA');
  const timeStr = ts => new Date(ts).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  const emailKey = e => String(e).trim().toLowerCase().replace(/\./g, ',');   // firebase keys can't contain "."
  const keyEmail = k => String(k).replace(/,/g, '.');
  const normStaff = v => v === 'vendor' ? { role: 'vendor', outlet: null } : (v && v.role === 'vendor') ? { role: 'vendor', outlet: v.outlet || null } : null;

  /* auth code: 2 letters + 2 digits (no look-alike chars), e.g. KT47 */
  const LET = 'ABCDEFGHJKLMNPQRSTUVWXYZ', DIG = '23456789';
  const pick = s => s[crypto.getRandomValues(new Uint32Array(1))[0] % s.length];
  const genAuth = () => pick(LET) + pick(LET) + pick(DIG) + pick(DIG);

  /* ---------- storage adapters ---------- */
  function localStore() {
    const K = 'eatongo_db', subs = [];
    const read = () => { try { return JSON.parse(localStorage.getItem(K)) || {}; } catch (e) { return {}; } };
    const list = () => Object.values(read().orders || {});
    const emit = () => subs.forEach(f => f(list()));
    let menuCb = null, menuCode = null, moneyCb = null;
    const menuOf = code => Object.entries((read().menus || {})[code] || {}).map(([id, v]) => ({ id, ...v }));
    const write = d => { localStorage.setItem(K, JSON.stringify(d)); emit(); };
    addEventListener('storage', e => { if (e.key === K) emit(); });
    return {
      mode: 'local',
      async saveProfile() {}, async getProfile() { return null; }, async setLastOrder() {},
      uid: () => 'local',
      async counters(day) {
        const d = read(), m = d.meta || {};
        m.orderSeq = (m.orderSeq || 1042) + 1;
        if (m.tokenDay !== day) { m.tokenDay = day; m.tokenSeq = 100; }
        m.tokenSeq++; d.meta = m; write(d);
        return { no: m.orderSeq, token: m.tokenSeq };
      },
      async claimAuth(day) {
        const d = read(); d.auth = d.auth || {}; d.auth[day] = d.auth[day] || {};
        for (let i = 0; i < 50; i++) { const c = genAuth(); if (!d.auth[day][c]) { d.auth[day][c] = 1; write(d); return c; } }
        throw new Error('Could not generate auth code');
      },
      async save(o) { const d = read(); d.orders = d.orders || {}; d.orders[o.id] = o; write(d); },
      async update(id, p) { const d = read(); if (d.orders && d.orders[id]) { Object.assign(d.orders[id], p); write(d); } },
      async roleOf(u) { return normStaff((read().staff || {})[emailKey((u && u.email) || '')]); },
      async getRestaurant(code) { return (read().restaurants || {})[code] || null; },
      async saveRestaurant(code, info) { const d = read(); d.restaurants = d.restaurants || {}; d.restaurants[code] = { ...(d.restaurants[code] || {}), ...info }; write(d); },
      menuListen(code, f) { menuCode = code; menuCb = f; f(menuOf(code)); },
      menuStop() { menuCb = null; },
      async menuSet(code, id, item) { const d = read(); d.menus = d.menus || {}; d.menus[code] = d.menus[code] || {}; d.menus[code][id] = item; write(d); if (menuCb && menuCode === code) menuCb(menuOf(code)); },
      async menuRemove(code, id) { const d = read(); if (d.menus && d.menus[code]) delete d.menus[code][id]; write(d); if (menuCb && menuCode === code) menuCb(menuOf(code)); },
      async saveMoney(id, m) { const d = read(); d.money = d.money || {}; d.money[id] = m; write(d); if (moneyCb) moneyCb(d.money); },
      listenMoney(f) { moneyCb = f; f(read().money || {}); },
      stopMoney() { moneyCb = null; },
      async migrateMoney() { return 0; },
      listStaff(f) { f(read().staff || {}); },
      async setStaff(email, role) { const d = read(); d.staff = d.staff || {}; d.staff[emailKey(email)] = role; write(d); },
      async removeStaff(email) { const d = read(); if (d.staff) delete d.staff[emailKey(email)]; write(d); },
      listenAll(f) { subs.length = 0; subs.push(f); f(list()); },
      listenOne(id, f) { subs.length = 0; subs.push(l => f(l.filter(o => o.id === id))); f(list().filter(o => o.id === id)); },
      stop() { subs.length = 0; },
      async exportAll() { return read(); }
    };
  }

  const loadScript = src => new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = src; s.onload = res;
    s.onerror = () => rej(new Error('Failed to load ' + src)); document.head.appendChild(s);
  });

  async function firebaseStore() {
    const v = '10.12.2';
    await loadScript(`https://www.gstatic.com/firebasejs/${v}/firebase-app-compat.js`);
    await loadScript(`https://www.gstatic.com/firebasejs/${v}/firebase-auth-compat.js`);
    await loadScript(`https://www.gstatic.com/firebasejs/${v}/firebase-database-compat.js`);
    firebase.initializeApp(FIREBASE_CONFIG);
    const db = firebase.database(), auth = firebase.auth();
    let off = null, offMenu = null, offMoney = null;
    const stop = () => { if (off) { off(); off = null; } };
    return {
      mode: 'firebase', auth,
      uid: () => auth.currentUser && auth.currentUser.uid,
      async counters(day) {
        const r = await db.ref('meta').transaction(m => {
          m = m || {};
          m.orderSeq = (m.orderSeq || 1042) + 1;
          if (m.tokenDay !== day) { m.tokenDay = day; m.tokenSeq = 100; }
          m.tokenSeq = (m.tokenSeq || 100) + 1;
          return m;
        });
        const m = r.snapshot.val();
        return { no: m.orderSeq, token: m.tokenSeq };
      },
      async claimAuth(day) {          // rules only allow writing a code that doesn't exist yet
        for (let i = 0; i < 50; i++) {
          const c = genAuth();
          try { await db.ref(`authCodes/${day}/${c}`).set(true); return c; } catch (e) { /* taken, retry */ }
        }
        throw new Error('Could not generate auth code');
      },
      save: o => db.ref('orders/' + o.id).set(o),
      update: (id, p) => db.ref('orders/' + id).update(p),
      listenAll(f) { stop(); const r = db.ref('orders'); const h = r.on('value', s => f(Object.values(s.val() || {})), e => console.error(e)); off = () => r.off('value', h); },
      listenOne(id, f) { stop(); const r = db.ref('orders/' + id); const h = r.on('value', s => f(s.val() ? [s.val()] : []), e => console.error(e)); off = () => r.off('value', h); },
      stop,
      async roleOf(user) {            // admin = UID in admins/ ; vendor = verified email in staff/
        try { if ((await db.ref('admins/' + user.uid).once('value')).val() === true) return { role: 'admin', outlet: null }; } catch (e) { /* not admin */ }
        try {
          if (!user.email) return null;
          return normStaff((await db.ref('staff/' + emailKey(user.email)).once('value')).val());
        } catch (e) { return null; }   // rules deny unverified / unlisted emails
      },
      getRestaurant: async code => (await db.ref('restaurants/' + code).once('value')).val(),
      saveRestaurant: (code, info) => db.ref('restaurants/' + code).update(info),
      menuListen(code, f) {
        this.menuStop(); const r = db.ref('menus/' + code);
        const h = r.on('value', sn => f(Object.entries(sn.val() || {}).map(([id, v]) => ({ id, ...v }))), e => console.error(e));
        offMenu = () => r.off('value', h);
      },
      menuStop() { if (offMenu) { offMenu(); offMenu = null; } },
      menuSet: (code, id, item) => db.ref(`menus/${code}/${id}`).set(item),
      menuRemove: (code, id) => db.ref(`menus/${code}/${id}`).remove(),
      saveMoney: (id, m) => db.ref('orderMoney/' + id).set(m),
      listenMoney(f) { this.stopMoney(); const r = db.ref('orderMoney'); const h = r.on('value', sn => f(sn.val() || {}), e => console.error(e)); offMoney = () => r.off('value', h); },
      stopMoney() { if (offMoney) { offMoney(); offMoney = null; } },
      async migrateMoney() {          // one-time (admin): move old totals/prices out of orders/ into orderMoney/
        const all = (await db.ref('orders').once('value')).val() || {}, up = {}; let n = 0;
        Object.entries(all).forEach(([id, o]) => {
          if (o.total == null && !(o.items || []).some(i => i.price != null)) return;
          up['orderMoney/' + id] = { owner: o.owner || null, subtotal: o.subtotal ?? null, total: o.total ?? null, prices: (o.items || []).map(i => i.price ?? 0), day: o.day || null, createdAt: o.createdAt || null };
          up['orders/' + id + '/total'] = null; up['orders/' + id + '/subtotal'] = null;
          (o.items || []).forEach((_, k) => { up['orders/' + id + '/items/' + k + '/price'] = null; });
          n++;
        });
        if (n) await db.ref().update(up);
        return n;
      },
      listStaff(f) { db.ref('staff').on('value', s => f(s.val() || {}), e => console.error(e)); },
      setStaff: (email, role) => db.ref('staff/' + emailKey(email)).set(role),
      removeStaff: email => db.ref('staff/' + emailKey(email)).remove(),
      signInEmail: (email, pass) => auth.signInWithEmailAndPassword(email, pass),
      createUserEmail: (email, pass) => auth.createUserWithEmailAndPassword(email, pass),
      saveProfile: (uid, p) => db.ref('customers/' + uid).update(p),
      getProfile: async uid => (await db.ref('customers/' + uid).once('value')).val(),
      setLastOrder: (uid, id) => db.ref('customers/' + uid + '/lastOrder').set(id),
      async exportAll() { return { orders: (await db.ref('orders').once('value')).val() }; }
    };
  }

  const ready = (async () => {
    try { return USE_FIREBASE ? await firebaseStore() : localStore(); }
    catch (e) {
      console.error(e);
      const bar = document.createElement('div');
      bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#e44d4d;color:#fff;font:700 13px system-ui;padding:8px 12px;text-align:center';
      bar.textContent = 'OFFLINE TEST MODE: Firebase failed to load. Orders on this device will NOT reach the vendor.';
      document.body.appendChild(bar);
      return localStore();
    }
  })();

  /* ---------- state ---------- */
  let store = null, orders = [], known = null, role = 'customer', staffEmail = '';
  let rawOrders = [], moneyMap = {}, restaurant = null, menuItems = [], creating = false;
  let mineId = sessionStorage.getItem('eatongo_order') || null, lastMineStatus = null;
  let opsTab = 'live', queueTab = 'live';
  let settleAuth; const authSettled = new Promise(r => { settleAuth = r; });
  const NEXT = { new: 'preparing', preparing: 'ready', ready: 'collected' };
  const FLOW_INDEX = { new: 0, preparing: 2, ready: 3, collected: 4 };
  const isStaffRole = () => role === 'vendor' || role === 'admin';
  const outletCode = () => (typeof currentOutlet !== 'undefined' && currentOutlet === 'mingos') ? 'MING-001' : 'HARI-001';
  const outletKind = c => c === 'MING-001' ? 'mingos' : 'hari';

  const isLive = o => !['collected','declined'].includes(o.status) && o.pickup !== 'pre';
  const isPre = o => !['collected','declined'].includes(o.status) && o.pickup === 'pre';
  const isDone = o => ['collected','declined'].includes(o.status);
  const itemsText = o => (o.items || []).map(i => `${esc(i.name)} × ${i.qty}`).join(', ');
  const metaText = o => `${esc(o.id)} · ${esc(o.customer)}${o.total != null ? ' · ₹' + o.total : ''} · Paid · ${timeStr(o.createdAt)}${o.pickup === 'pre' ? ' · Pre-order ' + esc(o.pickupTime) : ''}`;

  /* ---------- roles / login ---------- */
  function inVendorView() { return document.body.classList.contains('vendor-mode') || document.body.classList.contains('ops-mode'); }
  function kickToLogin() {
    sessionStorage.removeItem('eatongo_vendor');
    location.replace(location.pathname + '?login');
  }

  function setRole(r) {
    role = r; store.stop(); store.stopMoney(); known = null; orders = []; rawOrders = []; moneyMap = {}; lastMineStatus = null;
    document.body.classList.toggle('restricted-vendor', r === 'vendor');
    if (r === 'customer') {
      mountAdminPanel(false);
      if (inVendorView()) { kickToLogin(); return; }
      if (mineId) store.listenOne(mineId, onOrders);
      renderVendor();
    } else {
      sessionStorage.setItem('eatongo_vendor', '1');
      store.listenAll(onOrders);
      if (r === 'admin') store.listenMoney(m => { moneyMap = m; applyOrders(); });
      mountAdminPanel(r === 'admin');
    }
  }

  /* ---------- registered customers ---------- */
  let lastCustomerUid = null;
  async function enterCustomer(user) {
    lastCustomerUid = user.uid;
    setRole('customer');
    try {
      const p = await store.getProfile(user.uid);
      if (p) {
        if (p.name) sessionStorage.setItem('eatongoCustomerName', p.name);
        if (p.lastOrder && !mineId) { mineId = p.lastOrder; sessionStorage.setItem('eatongo_order', mineId); store.listenOne(mineId, onOrders); }
      }
    } catch (e) { console.error(e); }
    refreshCustomerBadge();
    if (sessionStorage.getItem('eatongo_customer_intent')) {
      sessionStorage.removeItem('eatongo_customer_intent');
      if (typeof startScanner === 'function') startScanner();
    }
  }

  function refreshCustomerBadge() {
    const u = store && store.auth && store.auth.currentUser;
    let btn = $('#custLogout');
    if (!(u && !u.isAnonymous && role === 'customer')) { if (btn) btn.remove(); return; }
    if (!btn) {
      btn = document.createElement('button'); btn.id = 'custLogout';
      btn.style.cssText = 'margin-left:auto;background:#d8ff3e;color:#171717;border:0;border-radius:99px;padding:8px 12px;font-weight:850;font-size:.78rem';
      btn.onclick = async () => {
        sessionStorage.removeItem('eatongo_order'); sessionStorage.removeItem('eatongoCustomerName');
        await store.auth.signOut(); location.href = location.pathname;
      };
      $('.topbar').appendChild(btn);
    }
    const n = sessionStorage.getItem('eatongoCustomerName') || '';
    btn.textContent = 'Log out' + (n ? ' · ' + n.slice(0, 12) : '');
  }

  function brandName(code) { return (restaurant && restaurant.name) || (code === 'MING-001' ? 'Mingos' : 'Hari Super Sandwich'); }

  function applyVendorOutlet(code) {
    const name = brandName(code);
    document.querySelectorAll('#vendorApp .side .brand .navlabel, #vendorOps .ops-hero .eyebrow, .outlet-name, .cart-sub').forEach(x => x.textContent = name);
    const qr = $('#shopQrCard'); if (qr) { const p = qr.querySelector('p'); if (p) p.innerHTML = `Place this at the counter. Customers scan it to open the current menu. Outlet code: <b>${esc(code)}</b>`; }
    const h = $('#vpage-overview h1'); if (h) h.textContent = 'Good afternoon, ' + name.split(' ')[0] + '.';
    if (typeof renderOutletQr === 'function') renderOutletQr();
  }

  /* after a staff login: registered restaurant -> dashboard; admin on a new restaurant -> registration form */
  async function afterStaffLogin() {
    const msg = $('#vendorAuthMsg');
    if (restaurant) { openVendorOps(); return; }
    if (role === 'admin') {
      const pn = $('#placeName'); if (pn) pn.value = brandName(outletCode());
      screen('vendorPlace'); return;
    }
    if (msg) { msg.style.color = '#a43d32'; msg.textContent = 'This restaurant has not been registered yet. Ask your admin to sign in once and set it up.'; }
    sessionStorage.removeItem('eatongo_vendor');
    await store.auth.signOut();
  }

  async function onUser(user) {
    if (creating && user) return;                  // account-creation flow handles its own sign-out
    if (!user) {                                   // nobody signed in -> silent anonymous (customer)
      try { await store.auth.signInAnonymously(); }
      catch (e) { console.error(e); toast('<b>Setup needed.</b> Enable Anonymous sign-in in Firebase.'); settleAuth(); }
      return;
    }
    if (user.isAnonymous) { setRole('customer'); refreshCustomerBadge(); settleAuth(); return; }

    const intent = sessionStorage.getItem('eatongo_intent');
    let rec = null;
    try { rec = await store.roleOf(user); } catch (e) { console.error(e); }
    if (rec && !sessionStorage.getItem('eatongo_customer_intent')) {   // staff (unless they used the customer sign-in)
      setRole(rec.role);
      staffEmail = (user.email || '').toLowerCase();
      const outlet = (rec.role === 'vendor' && rec.outlet) ? rec.outlet : (sessionStorage.getItem('eatongo_vendor_outlet') || 'HARI-001');
      sessionStorage.setItem('eatongo_vendor_outlet', outlet);
      setOutlet(outletKind(outlet));
      restaurant = null;
      try { restaurant = await store.getRestaurant(outlet); } catch (e) { console.error(e); }
      applyVendorOutlet(outlet);
      history.replaceState(null, '', location.pathname + '?vendor=overview');
      const card = $('#vendorAuth');
      if (card && !card.classList.contains('hidden')) { sessionStorage.removeItem('eatongo_intent'); await afterStaffLogin(); }
    } else if (!rec && intent) {                   // tried the vendor sign-in but is not staff
      sessionStorage.removeItem('eatongo_intent');
      const m = $('#vendorAuthMsg');
      if (!user.emailVerified) {
        user.sendEmailVerification().catch(() => {});
        if (m) m.textContent = `Please verify your email first. We sent a link to ${user.email}. Open it, then sign in again.`;
      } else if (m) {
        m.textContent = `${user.email} is not an approved vendor. Ask your admin to add this email. (Restaurant owner? Add this ID under "admins" in Firebase: ${user.uid})`;
      }
      toast('<b>Not authorised.</b> This account is not a vendor.');
      await store.auth.signOut();                  // -> anonymous again
    } else {
      await enterCustomer(user);                   // registered customer
    }
    settleAuth();
  }

  const authForm = $('#vendorAuthForm');
  const outletSelect = $('#vendorOutlet');
  if (outletSelect) outletSelect.onchange = () => sessionStorage.setItem('eatongo_vendor_outlet', outletSelect.value);
  if (authForm) authForm.onsubmit = async e => {
    e.preventDefault();
    const msg = $('#vendorAuthMsg'); if (msg) { msg.style.color = '#5d625b'; msg.textContent = 'Signing in…'; }
    const s = store || await ready;
    const email = $('#vendorEmail').value.trim(), pass = $('#vendorPass').value;
    sessionStorage.setItem('eatongo_vendor_outlet', $('#vendorOutlet')?.value || 'HARI-001');
    if (s.mode === 'local') {
      const selected = $('#vendorOutlet')?.value || 'HARI-001';
      if (selected === 'MING-001' && email.toLowerCase() !== 'rehanzn2007@gmail.com') { if (msg) msg.textContent = 'Dummy Mingos admin login is rehanzn2007@gmail.com.'; return; }
      history.replaceState(null, '', location.pathname + '?vendor=overview');
      setRole('admin'); setOutlet(selected === 'MING-001' ? 'mingos' : 'hari'); applyVendorOutlet(selected); unlock(true); return;
    }
    sessionStorage.setItem('eatongo_intent', '1');
    const btn = authForm.querySelector('button[type=submit]'); if (btn) btn.disabled = true;
    // wait for the silent anonymous sign-in to finish first, so it can't overwrite this login
    await Promise.race([authSettled, new Promise(r => setTimeout(r, 4000))]);
    try {
      try { await s.signInEmail(email, pass); }
      catch (e1) {                                   // one automatic retry on flaky network
        if (e1.code === 'auth/network-request-failed' || e1.code === 'auth/internal-error') { await new Promise(r => setTimeout(r, 800)); await s.signInEmail(email, pass); }
        else throw e1;
      }
    }
    catch (err) {
      console.error(err);
      if (msg) msg.style.color = '#a43d32';
      const m = {
        'auth/invalid-credential': 'Wrong email or password.',
        'auth/wrong-password': 'Wrong email or password.',
        'auth/user-not-found': 'No account with this email. Ask your admin to create it.',
        'auth/invalid-email': 'That email address looks invalid.',
        'auth/too-many-requests': 'Too many attempts. Wait a few minutes and retry.',
        'auth/network-request-failed': 'Network problem reaching Firebase. Check your connection and retry.',
        'auth/operation-not-allowed': 'Email/Password sign-in is not enabled in Firebase yet.'
      }[err.code] || `Sign-in failed (${err.code || err.message}). Please try again.`;
      if (msg) msg.textContent = m;
      if (btn) btn.disabled = false;
      return;
    }
    if (btn) btn.disabled = false;
    // same user was already signed in -> Firebase fires no auth event, so continue here
    const u = s.auth.currentUser;
    if (u && !u.isAnonymous && isStaffRole() && (u.email || '').toLowerCase() === staffEmail) {
      sessionStorage.removeItem('eatongo_intent'); await afterStaffLogin();
    } else {
      setTimeout(() => { const c = $('#vendorAuth'); if (c && !c.classList.contains('hidden') && msg && msg.textContent === 'Signing in…') msg.textContent = 'Signed in, but could not load your vendor access. Press F12 → Console and send me the red error.'; }, 6000);
    }
  };

  /* first-time vendor: create account -> verify email -> sign in. Only emails the admin added get access. */
  const vendorCreate = $('#vendorCreateAccount');
  if (vendorCreate) vendorCreate.onclick = async () => {
    const email = $('#vendorEmail').value.trim().toLowerCase(), pass = $('#vendorPass').value, msg = $('#vendorAuthMsg');
    const say = (t, bad) => { if (msg) { msg.style.color = bad ? '#a43d32' : '#5d625b'; msg.textContent = t; } };
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { say('Enter the email your admin added.', true); return; }
    if (pass.length < 6) { say('Choose a password of at least 6 characters.', true); return; }
    const s = store || await ready;
    if (s.mode === 'local') { say('Local mode does not require account setup.'); return; }
    await Promise.race([authSettled, new Promise(r => setTimeout(r, 4000))]);
    creating = true; say('Creating your account…');
    try {
      const cred = await s.createUserEmail(email, pass);
      await cred.user.sendEmailVerification();
      await s.auth.signOut();
      say(`Account created. We sent a verification link to ${email}. Open it, then come back and press Sign in.`);
    } catch (err) {
      console.error(err);
      say(err.code === 'auth/email-already-in-use' ? 'Account already exists. Use Sign in.'
        : err.code === 'auth/weak-password' ? 'Password is too weak. Use at least 6 characters.'
        : 'Could not create the account. Check the email and try again.', true);
    } finally { creating = false; }
  };

  /* customer register / log in */
  let custMode = 'register';
  const custMsg = (t, bad) => { const m = $('#customerAuthMsg'); if (m) { m.style.color = bad ? '#a43d32' : '#5d625b'; m.textContent = t; } };
  function setCustMode(m) {
    custMode = m;
    const reg = m === 'register';
    $('#custTitle').textContent = reg ? 'Create your account' : 'Welcome back';
    $('#custSub').textContent = reg ? 'Pick a username, email and password. Next time, just log in with your email and password.' : 'Log in with the email and password you registered with.';
    $('#custNameField').classList.toggle('hidden', !reg);
    $('#customerName').required = reg;
    $('#customerPass').autocomplete = reg ? 'new-password' : 'current-password';
    $('#custSubmit').textContent = reg ? 'Register' : 'Log in';
    $('#custToggle').textContent = reg ? 'Already registered? Log in' : 'New here? Register';
    custMsg('');
  }
  if ($('#custToggle')) { $('#custToggle').onclick = () => setCustMode(custMode === 'register' ? 'login' : 'register'); setCustMode('register'); }

  const customerForm = $('#customerNameForm');
  if (customerForm) customerForm.onsubmit = async e => {
    e.preventDefault();
    const name = $('#customerName').value.trim(), email = $('#customerEmail').value.trim().toLowerCase(), pass = $('#customerPass').value;
    const reg = custMode === 'register';
    if (reg && (name.length < 2 || name.length > 30)) { custMsg('Username must be 2 to 30 characters.', true); return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { custMsg('Enter a valid email.', true); return; }
    if (pass.length < 6) { custMsg('Password must be at least 6 characters.', true); return; }

    const s = store || await ready;
    if (s.mode === 'local') { sessionStorage.setItem('eatongoCustomerName', name || email); startScanner(); return; }

    const btn = $('#custSubmit'); btn.disabled = true; custMsg(reg ? 'Creating your account…' : 'Logging in…');
    await Promise.race([authSettled, new Promise(r => setTimeout(r, 4000))]);   // let the silent guest sign-in finish first
    sessionStorage.removeItem('eatongo_intent');
    sessionStorage.setItem('eatongo_customer_intent', '1');
    if (reg) sessionStorage.setItem('eatongoCustomerName', name);
    try {
      let user;
      if (reg) {
        user = (await s.createUserEmail(email, pass)).user;
        await s.saveProfile(user.uid, { name, email, createdAt: Date.now() }).catch(err => console.error(err));
      } else {
        user = (await s.signInEmail(email, pass)).user;
        if (user.uid === lastCustomerUid) await enterCustomer(user);   // already signed in: no auth event will fire
      }
    } catch (err) {
      console.error(err);
      sessionStorage.removeItem('eatongo_customer_intent');
      custMsg({
        'auth/email-already-in-use': 'This email is already registered. Tap "Already registered? Log in".',
        'auth/invalid-credential': 'Wrong email or password.',
        'auth/wrong-password': 'Wrong email or password.',
        'auth/user-not-found': 'No account with this email. Tap "New here? Register".',
        'auth/weak-password': 'Password is too weak. Use at least 6 characters.',
        'auth/invalid-email': 'That email address looks invalid.',
        'auth/too-many-requests': 'Too many attempts. Wait a few minutes and retry.',
        'auth/network-request-failed': 'Network problem reaching Firebase. Retry.',
        'auth/operation-not-allowed': 'Email/Password sign-in is not enabled in Firebase.',
        'auth/admin-restricted-operation': 'Sign-ups are switched off in Firebase (Authentication → Settings → User actions).'
      }[err.code] || `Something went wrong (${err.code || err.message}).`, true);
    } finally { btn.disabled = false; }
  };

  function injectSignOut() {
    const go = async () => { sessionStorage.removeItem('eatongo_vendor'); if (store.auth) await store.auth.signOut(); location.href = location.pathname + '?login'; };
    const top = $('.ops-top');
    if (top && !$('#signOutOps')) { const b = document.createElement('button'); b.id = 'signOutOps'; b.className = 'dashboard-launch'; b.style.marginLeft = '8px'; b.textContent = 'Sign out'; b.onclick = go; top.appendChild(b); }
    const side = $('#vendorApp .side');
    if (side && !$('#signOutSide')) { const b = document.createElement('button'); b.id = 'signOutSide'; b.className = 'navbtn'; b.innerHTML = '<span>⎋</span><span class="navlabel">Sign out</span>'; b.onclick = go; side.appendChild(b); }
  }

  /* ---------- restaurant registration (admin, first time) ---------- */
  const placeForm = $('#vendorPlaceForm');
  if (placeForm) placeForm.onsubmit = async e => {
    e.preventDefault();
    const name = $('#placeName').value.trim();
    if (name.length < 2 || name.length > 60) { toast('<b>Enter a restaurant name</b> (2 to 60 characters).'); return; }
    const info = { name, type: ($('#placeType') || {}).value || '', location: (($('#placeLoc') || {}).value || '').trim().slice(0, 80), code: outletCode(), ownerEmail: staffEmail || null, registeredAt: Date.now() };
    const btn = placeForm.querySelector('button[type=submit]'); if (btn) btn.disabled = true;
    try {
      const s = store || await ready;
      if (s.mode !== 'local' && role !== 'admin') throw new Error('Only the admin can register the restaurant');
      await s.saveRestaurant(outletCode(), info);
      restaurant = { ...(restaurant || {}), ...info };
      applyVendorOutlet(outletCode());
      toast('<b>Restaurant registered.</b> ' + esc(name));
      screen('vendorMenuSetup');
    } catch (err) { console.error(err); toast('<b>Could not save.</b> Only the admin account can register the restaurant.'); }
    finally { if (btn) btn.disabled = false; }
  };

  /* menu-setup step: sample rows become the first real menu (only if the menu is still empty) */
  document.addEventListener('click', e => {
    const x = e.target.closest('#vendorMenuSetup .mini-item button'); if (x) x.closest('.mini-item').remove();
  });
  const finishBtn = $('#finishVendor');
  if (finishBtn) finishBtn.onclick = async () => {
    try {
      if (isStaffRole() && role === 'admin' && !menuItems.length) {
        const rows = $$('#vendorMenuSetup .mini-item').map(r => { const [n, p] = r.querySelectorAll('input'); return { name: n.value.trim(), price: parseInt(String(p.value).replace(/[^\d]/g, ''), 10) }; }).filter(x => x.name && x.price > 0);
        let k = 0;
        for (const r of rows) await store.menuSet(outletCode(), newId(), { name: r.name, desc: '', price: r.price, cat: 'Menu', veg: true, popular: true, available: true, order: Date.now() + (k++) });
      }
    } catch (err) { console.error(err); toast('<b>Menu not saved.</b> You can add items later under Menu.'); }
    openVendorOps();
    toast('<b>Restaurant ready.</b> Orders are live.');
  };

  /* ---------- live menu: customers read it, only the admin edits it ---------- */
  let editingId = null;
  const newId = () => 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

  async function watchMenu(code) {
    store = store || await ready; await authSettled;
    try { const r = await store.getRestaurant(code); if (code === outletCode()) { restaurant = r || null; applyVendorOutlet(code); } } catch (e) { /* offline */ }
    try { store.menuListen(code, onMenu); } catch (e) { console.error(e); }
  }

  function onMenu(items) {
    menuItems = items;
    if (items.length) {
      const sorted = items.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
      const inCart = {}; Object.entries(cart).forEach(([i, q]) => { if (q > 0 && foods[i]) inCart[foods[i].raw || foods[i].name] = q; });
      foods = sorted.filter(m => m.available !== false).map(m => ({
        id: m.id, raw: m.name, name: esc(m.name), desc: esc(m.desc || ''), price: Math.max(0, Math.round(+m.price || 0)),
        cat: String(m.cat || 'Menu'), popular: !!m.popular, veg: m.veg !== false
      }));
      const nc = {}; foods.forEach((f, i) => { if (inCart[f.raw]) nc[i] = inCart[f.raw]; }); cart = nc;
      if (typeof renderMenu === 'function') renderMenu();
      if (typeof renderCart === 'function') renderCart();
    }
    renderMenuTable();
  }

  function renderMenuTable() {
    const tb = $('#menuTable'); if (!tb || role !== 'admin') return;
    const note = $('#menuNote');
    if (note) note.innerHTML = menuItems.length ? '' : '<div class="panel" style="margin-bottom:14px"><b>Customers currently see the built-in demo menu.</b><p class="sub">Add your first item, or load the demo items here so you can edit them.</p><button class="status preparing" data-m-seed type="button">Load demo items</button></div>';
    const sorted = menuItems.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    tb.innerHTML = sorted.map(m => `<tr><td><b>${esc(m.name)}</b>${m.veg === false ? ' <small>(non-veg)</small>' : ''}<br><small>${esc(m.desc || '')}</small></td><td>${esc(m.cat)}</td><td>₹${esc(m.price)}</td><td><button class="toggle ${m.popular ? 'on' : ''}" data-m-pop="${esc(m.id)}" aria-label="Popular"></button></td><td><button class="toggle ${m.available !== false ? 'on' : ''}" data-m-avail="${esc(m.id)}" aria-label="Available"></button></td><td style="white-space:nowrap"><button class="status ready" data-m-edit="${esc(m.id)}" type="button">Edit</button> <button class="status preparing" data-m-del="${esc(m.id)}" type="button">Delete</button></td></tr>`).join('')
      || '<tr><td colspan="6" class="sub">No items yet. Press “+ Add item”.</td></tr>';
    const dl = $('#menuCats'); if (dl) dl.innerHTML = [...new Set(menuItems.map(m => m.cat))].map(c => `<option value="${esc(c)}">`).join('');
  }

  function openMenuForm(m) {
    editingId = m ? m.id : null;
    $('#menuFormTitle').textContent = m ? 'Edit item' : 'Add item';
    $('#mName').value = m ? m.name : ''; $('#mCat').value = m ? m.cat : ''; $('#mPrice').value = m ? m.price : '';
    $('#mDesc').value = m ? (m.desc || '') : ''; $('#mVeg').value = m && m.veg === false ? '0' : '1';
    $('#mPop').checked = m ? !!m.popular : false; $('#mAvail').checked = m ? m.available !== false : true;
    $('#menuForm').classList.remove('hidden'); $('#mName').focus();
  }

  function mountMenuManager() {
    const page = $('#vpage-menu'); if (!page || $('#menuForm')) return;
    const inp = 'width:100%;padding:11px;border-radius:10px;border:1px solid #30372f;background:#11150f;color:#f3f6f1;font:inherit;margin-top:4px';
    const f = document.createElement('form'); f.id = 'menuForm'; f.className = 'panel hidden'; f.style.marginBottom = '14px';
    f.innerHTML = `<h2 id="menuFormTitle">Add item</h2>
      <div style="display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">
        <label>Name<input id="mName" required maxlength="60" style="${inp}"></label>
        <label>Category<input id="mCat" required maxlength="30" list="menuCats" placeholder="e.g. Biryani, Combos, Desserts" style="${inp}"></label>
        <label>Price (₹)<input id="mPrice" type="number" min="1" max="100000" required style="${inp}"></label>
        <label>Type<select id="mVeg" style="${inp}"><option value="1">Veg</option><option value="0">Non-veg</option></select></label>
      </div>
      <label style="display:block;margin-top:10px">Description<input id="mDesc" maxlength="140" style="${inp}"></label>
      <datalist id="menuCats"></datalist>
      <div style="display:flex;gap:18px;margin:12px 0;flex-wrap:wrap"><label><input id="mPop" type="checkbox"> Show under Popular</label><label><input id="mAvail" type="checkbox" checked> Available to customers</label></div>
      <button class="primary dark" type="submit" style="width:auto;margin:0 8px 0 0">Save item</button><button class="back" id="mCancel" type="button">Cancel</button>`;
    page.insertBefore(f, $('#menuNote'));
    $('#menuAddBtn').onclick = () => openMenuForm(null);
    $('#mCancel').onclick = () => f.classList.add('hidden');
    f.onsubmit = async e => {
      e.preventDefault(); if (role !== 'admin') return;
      const old = menuItems.find(x => x.id === editingId);
      const item = { name: $('#mName').value.trim(), cat: $('#mCat').value.trim(), price: Math.round(Number($('#mPrice').value)), desc: $('#mDesc').value.trim(),
        veg: $('#mVeg').value === '1', popular: $('#mPop').checked, available: $('#mAvail').checked, order: old ? (old.order || Date.now()) : Date.now() };
      if (!item.name || !item.cat || !(item.price > 0)) { toast('<b>Name, category and a price are required.</b>'); return; }
      try { await store.menuSet(outletCode(), editingId || newId(), item); f.classList.add('hidden'); toast('<b>Saved.</b> Customers see this instantly.'); }
      catch (err) { console.error(err); toast('<b>Could not save.</b> Only the admin can edit the menu.'); }
    };
    page.addEventListener('click', async e => {
      if (role !== 'admin') return;
      const g = a => e.target.closest(a), code = outletCode();
      const find = id => menuItems.find(x => x.id === id), strip = ({ id, ...rest }) => rest;
      try {
        let b;
        if ((b = g('[data-m-edit]'))) { const m = find(b.dataset.mEdit); if (m) openMenuForm(m); }
        else if ((b = g('[data-m-del]'))) { const m = find(b.dataset.mDel); if (m && confirm(`Delete “${m.name}”?`)) { await store.menuRemove(code, m.id); toast('<b>Deleted.</b>'); } }
        else if ((b = g('[data-m-pop]'))) { const m = find(b.dataset.mPop); if (m) await store.menuSet(code, m.id, { ...strip(m), popular: !m.popular }); }
        else if ((b = g('[data-m-avail]'))) { const m = find(b.dataset.mAvail); if (m) await store.menuSet(code, m.id, { ...strip(m), available: m.available === false }); }
        else if (g('[data-m-seed]')) {
          const base = (typeof outletMenus !== 'undefined' && outletMenus[currentOutlet]) || [];
          let k = 0; for (const it of base) await store.menuSet(code, newId(), { name: it.name, desc: it.desc || '', price: it.price, cat: it.cat, veg: true, popular: !!it.popular, available: true, order: Date.now() + (k++) });
          toast('<b>Demo items loaded.</b> Edit them as you like.');
        }
      } catch (err) { console.error(err); toast('<b>Not allowed.</b> Only the admin can edit the menu.'); }
    });
    renderMenuTable();
  }

  /* ---------- admin: business summary (revenue + estimated profit) ---------- */
  function renderInsights() {
    const body = $('#insightBody'); if (!body || role !== 'admin') return;
    const live = orders.filter(o => o.status !== 'declined'), now = Date.now();
    const cp = restaurant && restaurant.costPct != null && restaurant.costPct !== '' ? Number(restaurant.costPct) : null;
    const ranges = [['Today', o => o.day === today()], ['Last 7 days', o => o.createdAt >= now - 7 * 864e5], ['Last 30 days', o => o.createdAt >= now - 30 * 864e5]];
    const cards = ranges.map(([label, fn]) => {
      const l = live.filter(fn), rev = l.reduce((a, o) => a + (o.total || 0), 0), prof = cp == null ? null : Math.round(rev * (1 - cp / 100));
      return `<div class="stat"><small>${label}</small><strong>₹${rev.toLocaleString('en-IN')}</strong><small>${l.length} orders${prof != null ? ' · est. profit ₹' + prof.toLocaleString('en-IN') : ''}</small></div>`;
    }).join('');
    const qty = {}; live.filter(o => o.createdAt >= now - 30 * 864e5).forEach(o => (o.items || []).forEach(i => { qty[i.name] = (qty[i.name] || 0) + (i.qty || 0); }));
    const top = Object.entries(qty).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, q]) => `<div class="history-row"><span>${esc(n)}</span><b>${q}</b></div>`).join('');
    body.innerHTML = `<div class="stats" style="grid-template-columns:repeat(3,1fr)">${cards}</div><h3 style="margin:16px 0 6px">Top items (30 days)</h3>${top || '<p class="sub">No orders yet.</p>'}`;
    const ci = $('#costPct'); if (ci && document.activeElement !== ci) ci.value = cp == null ? '' : cp;
  }

  /* ---------- admin panel: business summary + manage vendor emails ---------- */
  function mountAdminPanel(on) {
    let p = $('#adminPanel'), q = $('#adminInsights');
    if (!on) { if (p) p.remove(); if (q) q.remove(); return; }
    if (p) return;
    mountMenuManager();
    q = document.createElement('div'); q.id = 'adminInsights'; q.className = 'panel'; q.style.marginTop = '16px';
    q.innerHTML = '<div class="eyebrow">Admin only</div><h2>Business summary</h2><p class="sub">Revenue is read from private order-money records that vendors cannot access.</p><label class="sub" style="display:block;margin:10px 0">Food cost % (to estimate profit) <input id="costPct" type="number" min="0" max="100" placeholder="e.g. 35" style="width:90px;margin-left:8px;padding:8px;border-radius:8px;border:1px solid #30372f;background:#11150f;color:#f3f6f1"></label><div id="insightBody"></div>';
    $('#vpage-overview').appendChild(q);
    $('#costPct').onchange = async e => {
      const v = Math.max(0, Math.min(100, Number(e.target.value)));
      if (e.target.value === '' || isNaN(v)) return;
      try { await store.saveRestaurant(outletCode(), { costPct: v }); restaurant = { ...(restaurant || {}), costPct: v }; renderInsights(); toast('<b>Saved.</b> Profit estimate updated.'); }
      catch (err) { console.error(err); toast('<b>Could not save.</b>'); }
    };
    p = document.createElement('div'); p.id = 'adminPanel'; p.className = 'panel'; p.style.marginTop = '16px';
    p.innerHTML = '<div class="eyebrow">Admin only</div><h2>Vendor accounts</h2><p class="sub">Vendors can take and complete orders. They cannot see revenue or profit, edit the menu, or manage accounts. After you add an email, the vendor opens the sign-in page, presses “First time? Create your account”, verifies their email, and signs in.</p><div class="scan-input" style="margin:12px 0"><input id="staffEmail" type="email" placeholder="vendor@gmail.com" style="text-transform:none"/><select id="staffOutlet"><option value="HARI-001">Hari Super Sandwich</option><option value="MING-001">Mingos</option></select><button id="staffAdd" type="button">Add vendor</button></div><div id="staffList"></div>';
    $('#vpage-overview').appendChild(p);
    $('#staffAdd').onclick = async () => {
      const email = $('#staffEmail').value.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast('<b>Enter a valid email.</b>'); return; }
      try { await store.setStaff(email, { role: 'vendor', outlet: $('#staffOutlet').value }); $('#staffEmail').value = ''; toast('<b>Vendor added.</b> ' + esc(email)); }
      catch (e) { console.error(e); toast('<b>Could not add.</b> Check database rules.'); }
    };
    p.addEventListener('click', async e => {
      const b = e.target.closest('[data-staff-rm]'); if (!b) return;
      try { await store.removeStaff(b.dataset.staffRm); toast('<b>Removed.</b>'); } catch (err) { toast('<b>Could not remove.</b>'); }
    });
    store.listStaff(map => {
      $('#staffList').innerHTML = Object.entries(map).map(([k, v]) => {
        const em = keyEmail(k), role_ = typeof v === 'string' ? v : (v && v.role) || '?', out = v && v.outlet ? ' · ' + v.outlet : '';
        return `<div class="history-row"><span><b>${esc(em)}</b><br><small>${esc(role_)}${esc(out)}</small></span><button class="status preparing" data-staff-rm="${esc(em)}">Remove</button></div>`;
      }).join('') || '<p class="sub">No vendors yet.</p>';
    });
    renderInsights();
  }

  /* ---------- customer: place order ---------- */
  document.addEventListener('click', e => {
    if (e.target.id !== 'checkoutBtn') return;
    if ($('#cartPanel').classList.contains('open')) return;   // existing handler closes cart only if valid
    placeOrder();
  });

  async function placeOrder() {
    const snapshot = { ...cart };
    const items = Object.entries(snapshot).filter(([, q]) => q > 0)
      .map(([i, q]) => ({ name: foods[i].raw || foods[i].name, qty: q, price: foods[i].price }));
    if (!items.length) return;

    let name = (sessionStorage.getItem('eatongoCustomerName') || '').trim();
    if (!name) {
      name = (prompt('Your name for this order?', '') || '').trim() || 'Guest';
      sessionStorage.setItem('eatongoCustomerName', name);
    }
    const pre = selectedPickup === 'pre';
    const subtotal = items.reduce((a, i) => a + i.price * i.qty, 0);

    cart = {}; renderCart();
    $('.pass-token').textContent = '…'; $('.pass-auth').textContent = '…';

    try {
      store = store || await ready;
      await authSettled;
      const owner = store.uid();
      if (!owner) throw new Error('Not signed in (enable Anonymous auth in Firebase)');
      const day = today();
      const [c, auth] = await Promise.all([store.counters(day), store.claimAuth(day)]);
      const createdAt = Date.now(), id = 'HS-' + c.no;
      // prices/totals go to orderMoney/ (admin + the customer only); orders/ is what vendors can read
      const money = { owner, subtotal, total: Math.round(subtotal * 1.05), prices: items.map(i => i.price), outlet: outletCode(), day, createdAt };
      const order = {
        id, no: c.no, token: String(c.token), auth, owner, outlet: outletCode(),
        customer: name, items: items.map(i => ({ name: i.name, qty: i.qty })),
        pickup: pre ? 'pre' : 'now',
        pickupTime: pre ? `${+preorderHour}:${preorderMinute} ${preorderPeriod}` : null,
        status: 'new', paid: true, createdAt, day
      };
      await store.saveMoney(id, money);
      await store.save(order);
      const cu = store.auth && store.auth.currentUser; if (cu && !cu.isAnonymous) store.setLastOrder(cu.uid, order.id).catch(() => {});
      mineId = order.id; lastMineStatus = 'new';
      sessionStorage.setItem('eatongo_order', mineId);
      if (!isStaffRole()) { known = null; store.listenOne(mineId, onOrders); }
      paintMine(order);
      toast(`<b>Payment verified.</b> Token ${order.token} · Code #${order.auth}`);
    } catch (err) {
      console.error(err);
      cart = snapshot; renderCart();
      toast('<b>Could not place order.</b> Please try again.');
    }
  }

  function paintMine(o) {
    $('.pass-token').textContent = o.token;
    $('.pass-auth').textContent = '#' + o.auth;
    let tag = $('#passOrderNo');
    if (!tag) { tag = document.createElement('div'); tag.id = 'passOrderNo'; tag.className = 'pass-daily'; tag.style.marginTop = '10px'; $('.pass-identity').appendChild(tag); }
    tag.textContent = `Order ${o.id} · ${o.customer}` + (o.status === 'collected' ? ' · Collected' : '');
    $('#trackingSummary').textContent = `Order ${o.id} · ` +
      (o.pickup === 'pre' ? `Pre-order pickup today at ${o.pickupTime}` : 'Estimated pickup in ~8 minutes');
    statusIndex = FLOW_INDEX[o.status] ?? 0; renderFlow();
  }

  /* ---------- vendor: render ---------- */
  const LABEL = { new: 'Accept', preparing: 'Mark ready', ready: 'Complete' };
  const LABEL_OPS = { new: 'Accept order', preparing: 'Mark ready', ready: 'Complete pickup' };
  const row = o => `<div class="order-row"><div class="order-no"><small style="display:block;font-size:.6rem;opacity:.7;letter-spacing:.08em">TOKEN</small>${esc(o.token)}</div><div><h3>${itemsText(o)}</h3><p>${metaText(o)}<span class="order-auth" aria-label="Authentication code">#${esc(o.auth)}</span></p></div>${LABEL[o.status] ? `<button class="status ${o.status}" data-oid="${esc(o.id)}">${LABEL[o.status]}</button>` : `<button class="status ready" disabled>${o.status === 'declined' ? 'Declined' : 'Collected ✓'}</button>`}</div>`;
  const card = o => `<article class="ops-card"><div class="ops-card-top"><div class="ops-number">Token ${esc(o.token)}</div><div class="ops-auth">#${esc(o.auth)}</div></div><h3>${itemsText(o)}</h3><p>${metaText(o)}</p>${o.status === 'collected' ? '<button class="status ready" disabled>Collected ✓</button>' : o.status === 'declined' ? '<button class="status" disabled style="background:#ffe5e2;color:#a43d32">Declined</button>' : `<button class="status ${o.status}" data-oid="${esc(o.id)}">${LABEL_OPS[o.status]}</button><button class="status" style="margin-left:8px;background:#ffe5e2;color:#a43d32" data-decline="${esc(o.id)}">Decline order</button>`}</article>`;
  const EMPTY_ROW = '<p class="sub" style="padding:14px">No orders here yet. New orders appear instantly.</p>';
  const EMPTY_CARD = '<div class="ops-empty"><b>No orders here</b>The next order will appear automatically.</div>';

  const byTab = t => t === 'live' ? orders.filter(isLive) : t === 'pre' ? orders.filter(isPre) : orders.filter(isDone).slice().reverse();

  window.renderOps = (t = 'live') => { opsTab = t; renderVendor(); };

  function renderVendor() {
    const live = byTab('live'), pre = byTab('pre'), done = byTab('completed');
    const active = orders.filter(o => o.status !== 'collected');
    renderInsights();

    $$('[data-ops-tab]').forEach(b => {
      const t = b.dataset.opsTab;
      b.classList.toggle('active', t === opsTab);
      b.textContent = { live: `Live · ${live.length}`, pre: `Pre-orders · ${pre.length}`, completed: `Completed · ${done.length}` }[t];
    });
    const opsList = byTab(opsTab);
    $('#opsOrderList').innerHTML = opsList.length ? opsList.map(card).join('') : EMPTY_CARD;

    $('#dashboardOrders').innerHTML = active.length ? active.slice(0, 3).map(row).join('') : EMPTY_ROW;
    const q = byTab(queueTab);
    $('#fullQueue').innerHTML = q.length ? q.map(row).join('') : EMPTY_ROW;
    $$('#vpage-queue .tabs .tab').forEach((b, i) => {
      const t = ['live', 'pre', 'completed'][i];
      b.classList.toggle('active', t === queueTab);
      b.textContent = { live: `Order now · ${live.length}`, pre: `Pre-orders · ${pre.length}`, completed: `Completed · ${done.length}` }[t];
      b.onclick = () => { queueTab = t; renderVendor(); };
    });
    const liveBadge = $('#vpage-queue .live'); if (liveBadge) liveBadge.textContent = `${active.length} active`;

    const td = orders.filter(o => o.day === today() && o.status !== 'declined');
    const sales = td.reduce((a, o) => a + (o.total || 0), 0);
    const recent = orders.filter(o => Date.now() - o.createdAt < 15 * 60000).length;
    const st = $$('#vpage-overview .stat');
    if (st.length >= 4) {
      const set = (i, v, sub) => { st[i].querySelector('strong').textContent = v; st[i].lastElementChild.textContent = sub; };
      set(0, '₹' + sales.toLocaleString('en-IN'), 'Updated live');
      set(1, String(td.length), 'today');
      set(2, '₹' + (td.length ? Math.round(sales / td.length) : 0), 'per order');
      set(3, recent >= 8 ? 'High' : recent >= 4 ? 'Medium' : 'Low', `${recent} orders / 15 min`);
    }
  }

  /* ---------- vendor: update order status ---------- */
  document.addEventListener('click', async e => {
    const decline = e.target.closest('[data-decline]');
    if (decline && isStaffRole()) {
      const o = orders.find(x => x.id === decline.dataset.decline);
      if (o) { decline.disabled = true; try { await store.update(o.id, { status: 'declined', updatedAt: Date.now(), declineReason: 'Declined by vendor' }); toast('<b>Order declined.</b>'); } catch (err) { decline.disabled = false; toast('<b>Could not decline order.</b>'); } }
      return;
    }
    const b = e.target.closest('[data-oid]');
    if (!b || b.disabled || !isStaffRole()) return;
    const o = orders.find(x => x.id === b.dataset.oid);
    if (!o || !NEXT[o.status]) return;
    b.disabled = true;
    try { await store.update(o.id, { status: NEXT[o.status], updatedAt: Date.now() }); }
    catch (err) { console.error(err); toast('<b>Update failed.</b> Try again.'); b.disabled = false; }
  });

  /* ---------- vendor: verify pickup ---------- */
  function verify() {
    const q = $('#tokenInput').value.trim().toUpperCase().replace(/^#/, '');
    const r = $('#verifyResult'), d = today();
    const o = [...orders].reverse().find(x => x.id.toUpperCase() === q || String(x.no) === q ||
      (x.day === d && (x.auth === q || String(x.token) === q)));
    const bad = m => `<div class="success" style="background:#ffe5e2;color:#a43d32">${m}</div>`;
    if (!q) { r.innerHTML = ''; return; }
    if (!o) { r.innerHTML = bad('Order not found. Check the token or auth code.'); return; }
    if (o.status === 'collected') { r.innerHTML = bad(`${esc(o.id)} was already collected.`); return; }
    const ok = o.status === 'ready';
    r.innerHTML = `<div class="success" ${ok ? '' : 'style="background:#fff1d9;color:#9b5b0a"'}>${ok ? '✓ Verified' : '⏳ Not ready yet'} · Paid · ${esc(o.customer)} · ${itemsText(o)} · Token ${esc(o.token)} · Code #${esc(o.auth)}</div>` +
      (ok ? `<button class="primary dark" data-oid="${esc(o.id)}" style="max-width:520px">Complete pickup</button>` : '');
  }
  $('#verifyToken').onclick = verify;
  $('#tokenInput').placeholder = 'Order no., token or auth code';
  $('#tokenInput').addEventListener('keydown', e => { if (e.key === 'Enter') verify(); });

  /* ---------- realtime listener ---------- */
  function beep() {
    try {
      const a = new (window.AudioContext || window.webkitAudioContext)(), o = a.createOscillator(), g = a.createGain();
      o.connect(g); g.connect(a.destination); o.frequency.value = 880; g.gain.value = .08; o.start();
      setTimeout(() => { o.stop(); a.close(); }, 180);
    } catch (e) { }
  }

  function onOrders(list) {
    const fresh = known === null ? [] : list.filter(o => !known.has(o.id));
    known = new Set(list.map(o => o.id));
    rawOrders = list;
    applyOrders(fresh);
  }

  function applyOrders(fresh = []) {
    let list = rawOrders.slice();
    if (isStaffRole()) list = list.filter(o => !o.outlet || o.outlet === outletCode());   // each outlet sees its own orders
    orders = list.map(o => {
      const m = moneyMap[o.id];
      if (role === 'admin') return m ? { ...o, subtotal: m.subtotal, total: m.total, items: (o.items || []).map((i, k) => ({ ...i, price: (m.prices || [])[k] ?? i.price })) } : o;
      if (role === 'vendor') { const { total, subtotal, ...rest } = o; return { ...rest, items: (o.items || []).map(({ price, ...i }) => i) }; }   // never show money to vendors
      return o;
    }).sort((a, b) => a.createdAt - b.createdAt);
    renderVendor();

    if (isStaffRole() && inVendorView()) fresh.filter(o => !o.outlet || o.outlet === outletCode()).forEach(o => { toast(`<b>New order ${esc(o.id)}</b> · ${esc(o.customer)} · #${esc(o.auth)}`); beep(); });

    const mine = orders.find(o => o.id === mineId);
    if (mine) {
      paintMine(mine);
      if (lastMineStatus && lastMineStatus !== mine.status && !isStaffRole()) {
        if (mine.status === 'preparing') toast('<b>Order accepted.</b> The kitchen is preparing it.');
        if (mine.status === 'ready') toast(`<b>Order ready!</b> Show code #${esc(mine.auth)} at the counter.`);
        if (mine.status === 'collected') toast('<b>Collected.</b> Enjoy your meal!');
      }
      lastMineStatus = mine.status;
    }
  }

  $('.pass-token').textContent = '…'; $('.pass-auth').textContent = '…';   // no stale demo values until a real order loads
  const adv = $('#advanceCustomer'); if (adv) adv.style.display = 'none';   // status now comes from the vendor

  /* ---------- start ---------- */
  ready.then(s => {
    store = s; injectSignOut();
    if (s.mode === 'local') { role = 'admin'; s.listenAll(onOrders); s.listenMoney(m => { moneyMap = m; applyOrders(); }); mountAdminPanel(true); settleAuth(); return; }   // local test: no login
    s.auth.onAuthStateChanged(onUser);
  });

  /* menu follows the outlet: wrap the page's setOutlet(), and start once for the outlet already open */
  if (typeof setOutlet === 'function') { const _setOutlet = window.setOutlet; window.setOutlet = function (kind) { _setOutlet.apply(this, arguments); watchMenu(outletCode()); }; }
  authSettled.then(() => watchMenu(outletCode()));

  /* vendors can never open the money / menu pages, even by URL */
  if (typeof showVPage === 'function') { const _sv = window.showVPage; window.showVPage = n => _sv(role === 'vendor' && ['analytics', 'loyalty', 'menu'].includes(n) ? 'overview' : n); }

  /* run once in the browser console while signed in as admin: moves old totals out of vendor-readable orders */
  window.eatongoMigrateMoney = async () => {
    if (role !== 'admin') { console.warn('Admin only.'); return 0; }
    const n = await store.migrateMoney(); console.log(n + ' old orders moved to private storage.'); return n;
  };

  /* optional: eatongoExport() in console downloads orders.json (staff only) */
  window.eatongoExport = async () => {
    const data = await (store || await ready).exportAll();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = 'orders.json'; a.click();
  };
})();


