/* eatongo backend layer (orders + realtime + Google login + roles)
   Add <script src="backend.js"></script> just before </body>
   Roles:  customer = anonymous Firebase user (no login)
           vendor   = email/password account listed in  staff/<email> = "vendor"
           admin    = email/password account listed in  staff/<email> = "admin"  (can add/remove vendors)  */
(() => {
  'use strict';

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
    const write = d => { localStorage.setItem(K, JSON.stringify(d)); emit(); };
    addEventListener('storage', e => { if (e.key === K) emit(); });
    return {
      mode: 'local',
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
    let off = null;
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
      async roleOf(email) {
        const s = await db.ref('staff/' + emailKey(email)).once('value'), v = s.val();
        return v === 'admin' ? 'admin' : v ? 'vendor' : null;
      },
      listStaff(f) { db.ref('staff').on('value', s => f(s.val() || {}), e => console.error(e)); },
      setStaff: (email, role) => db.ref('staff/' + emailKey(email)).set(role),
      removeStaff: email => db.ref('staff/' + emailKey(email)).remove(),
      signInEmail: (email, pass) => auth.signInWithEmailAndPassword(email, pass),
      async exportAll() { return { orders: (await db.ref('orders').once('value')).val() }; }
    };
  }

  const ready = (async () => {
    try { return USE_FIREBASE ? await firebaseStore() : localStore(); }
    catch (e) {
      console.error(e);
      setTimeout(() => toast('<b>Backend error.</b> Check Firebase config. Using local test mode.'), 500);
      return localStore();
    }
  })();

  /* ---------- state ---------- */
  let store = null, orders = [], known = null, role = 'customer', staffEmail = '';
  let mineId = sessionStorage.getItem('eatongo_order') || null, lastMineStatus = null;
  let opsTab = 'live', queueTab = 'live';
  let settleAuth; const authSettled = new Promise(r => { settleAuth = r; });
  const NEXT = { new: 'preparing', preparing: 'ready', ready: 'collected' };
  const FLOW_INDEX = { new: 0, preparing: 2, ready: 3, collected: 4 };
  const isStaffRole = () => role === 'vendor' || role === 'admin';

  const isLive = o => o.status !== 'collected' && o.pickup !== 'pre';
  const isPre = o => o.status !== 'collected' && o.pickup === 'pre';
  const isDone = o => o.status === 'collected';
  const itemsText = o => (o.items || []).map(i => `${esc(i.name)} × ${i.qty}`).join(', ');
  const metaText = o => `${esc(o.customer)} · ₹${o.total} · Paid · ${timeStr(o.createdAt)}${o.pickup === 'pre' ? ' · Pre-order ' + esc(o.pickupTime) : ''}`;

  /* ---------- roles / login ---------- */
  function inVendorView() { return document.body.classList.contains('vendor-mode') || document.body.classList.contains('ops-mode'); }
  function kickToLogin() {
    sessionStorage.removeItem('eatongo_vendor');
    location.replace(location.pathname + '?login');
  }

  function setRole(r) {
    role = r; store.stop(); known = null; orders = []; lastMineStatus = null;
    if (r === 'customer') {
      mountAdminPanel(false);
      if (inVendorView()) { kickToLogin(); return; }
      if (mineId) store.listenOne(mineId, onOrders);
      renderVendor();
    } else {
      sessionStorage.setItem('eatongo_vendor', '1');
      store.listenAll(onOrders);
      mountAdminPanel(r === 'admin' && store.mode === 'firebase');
    }
  }

  async function onUser(user) {
    if (!user) {                                   // nobody signed in -> silent anonymous (customer)
      try { await store.auth.signInAnonymously(); }
      catch (e) { console.error(e); toast('<b>Setup needed.</b> Enable Anonymous sign-in in Firebase.'); settleAuth(); }
      return;
    }
    if (user.isAnonymous) { setRole('customer'); settleAuth(); return; }

    let r = null;
    try { r = user.email ? await store.roleOf(user.email) : null; } catch (e) { console.error(e); }
    if (r) {
      setRole(r);
      staffEmail = (user.email || '').toLowerCase();
      const card = $('#vendorAuth');
      if (card && !card.classList.contains('hidden')) {
        if (sessionStorage.getItem('eatongo_intent')) { sessionStorage.removeItem('eatongo_intent'); screen('vendorPlace'); }
        else openVendorOps();                       // already signed in from before: go straight in
      }
    } else {
      sessionStorage.removeItem('eatongo_intent');
      const m = $('#vendorAuthMsg');
      if (m) m.textContent = `${user.email} is not an approved vendor. Ask your admin to add this email.`;
      toast('<b>Not authorised.</b> This account is not a vendor.');
      await store.auth.signOut();                  // -> anonymous again
    }
    settleAuth();
  }

  const authForm = $('#vendorAuthForm');
  if (authForm) authForm.onsubmit = async e => {
    e.preventDefault();
    const msg = $('#vendorAuthMsg'); if (msg) { msg.style.color = '#5d625b'; msg.textContent = 'Signing in…'; }
    const s = store || await ready;
    if (s.mode === 'local') { screen('vendorPlace'); return; }      // local test mode: no real login
    const email = $('#vendorEmail').value.trim(), pass = $('#vendorPass').value;
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
      sessionStorage.removeItem('eatongo_intent'); screen('vendorPlace');
    } else {
      setTimeout(() => { const c = $('#vendorAuth'); if (c && !c.classList.contains('hidden') && msg && msg.textContent === 'Signing in…') msg.textContent = 'Signed in, but could not load your vendor access. Press F12 → Console and send me the red error.'; }, 6000);
    }
  };

  function injectSignOut() {
    const go = async () => { sessionStorage.removeItem('eatongo_vendor'); if (store.auth) await store.auth.signOut(); location.href = location.pathname + '?login'; };
    const top = $('.ops-top');
    if (top && !$('#signOutOps')) { const b = document.createElement('button'); b.id = 'signOutOps'; b.className = 'dashboard-launch'; b.style.marginLeft = '8px'; b.textContent = 'Sign out'; b.onclick = go; top.appendChild(b); }
    const side = $('#vendorApp .side');
    if (side && !$('#signOutSide')) { const b = document.createElement('button'); b.id = 'signOutSide'; b.className = 'navbtn'; b.innerHTML = '<span>⎋</span><span class="navlabel">Sign out</span>'; b.onclick = go; side.appendChild(b); }
  }

  /* ---------- admin panel: manage vendor emails ---------- */
  function mountAdminPanel(on) {
    let p = $('#adminPanel');
    if (!on) { if (p) p.remove(); return; }
    if (p) return;
    p = document.createElement('div'); p.id = 'adminPanel'; p.className = 'panel'; p.style.marginTop = '16px';
    p.innerHTML = '<div class="eyebrow">Admin only</div><h2>Vendor access</h2><p class="sub">Create their account in Firebase (Authentication → Users → Add user) first, then add their email here.</p><div class="scan-input" style="margin:12px 0"><input id="staffEmail" type="email" placeholder="vendor@gmail.com" style="text-transform:none"/><button id="staffAdd" type="button">Add vendor</button></div><div id="staffList"></div>';
    $('#vpage-overview').appendChild(p);
    $('#staffAdd').onclick = async () => {
      const email = $('#staffEmail').value.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast('<b>Enter a valid email.</b>'); return; }
      try { await store.setStaff(email, 'vendor'); $('#staffEmail').value = ''; toast('<b>Vendor added.</b> ' + esc(email)); }
      catch (e) { console.error(e); toast('<b>Could not add.</b> Check database rules.'); }
    };
    p.addEventListener('click', async e => {
      const b = e.target.closest('[data-staff-rm]'); if (!b) return;
      try { await store.removeStaff(b.dataset.staffRm); toast('<b>Removed.</b>'); } catch (err) { toast('<b>Could not remove.</b>'); }
    });
    store.listStaff(map => {
      const me = (store.auth.currentUser && store.auth.currentUser.email || '').toLowerCase();
      $('#staffList').innerHTML = Object.entries(map).map(([k, v]) => {
        const em = keyEmail(k);
        return `<div class="history-row"><span><b>${esc(em)}</b><br><small>${esc(v)}</small></span>${em.toLowerCase() === me ? '<small>you</small>' : `<button class="status preparing" data-staff-rm="${esc(em)}">Remove</button>`}</div>`;
      }).join('') || '<p class="sub">No vendors yet.</p>';
    });
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
      .map(([i, q]) => ({ name: foods[i].name, qty: q, price: foods[i].price }));
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
      const order = {
        id: 'HS-' + c.no, no: c.no, token: String(c.token), auth, owner,
        customer: name, items, subtotal, total: Math.round(subtotal * 1.05),
        pickup: pre ? 'pre' : 'now',
        pickupTime: pre ? `${+preorderHour}:${preorderMinute} ${preorderPeriod}` : null,
        status: 'new', paid: true, createdAt: Date.now(), day
      };
      await store.save(order);
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
  const row = o => `<div class="order-row"><div class="order-no">#${o.no}</div><div><h3>${itemsText(o)}</h3><p>${metaText(o)}<span class="order-auth" aria-label="Authentication code">#${esc(o.auth)}</span></p></div><button class="status ${o.status}" data-oid="${esc(o.id)}">${LABEL[o.status]}</button></div>`;
  const card = o => `<article class="ops-card"><div class="ops-card-top"><div class="ops-number">#${o.no}</div><div class="ops-auth">#${esc(o.auth)}</div></div><h3>${itemsText(o)}</h3><p>${metaText(o)}</p>${o.status === 'collected' ? '<button class="status ready" disabled>Collected ✓</button>' : `<button class="status ${o.status}" data-oid="${esc(o.id)}">${LABEL_OPS[o.status]}</button>`}</article>`;
  const EMPTY_ROW = '<p class="sub" style="padding:14px">No orders here yet. New orders appear instantly.</p>';
  const EMPTY_CARD = '<div class="ops-empty"><b>No orders here</b>The next order will appear automatically.</div>';

  const byTab = t => t === 'live' ? orders.filter(isLive) : t === 'pre' ? orders.filter(isPre) : orders.filter(isDone).slice().reverse();

  window.renderOps = (t = 'live') => { opsTab = t; renderVendor(); };

  function renderVendor() {
    const live = byTab('live'), pre = byTab('pre'), done = byTab('completed');
    const active = orders.filter(o => o.status !== 'collected');

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

    const td = orders.filter(o => o.day === today());
    const sales = td.reduce((a, o) => a + o.total, 0);
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
    orders = list.slice().sort((a, b) => a.createdAt - b.createdAt);
    renderVendor();

    if (isStaffRole() && inVendorView()) fresh.forEach(o => { toast(`<b>New order ${esc(o.id)}</b> · ${esc(o.customer)} · #${esc(o.auth)}`); beep(); });

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
    if (s.mode === 'local') { role = 'admin'; s.listenAll(onOrders); settleAuth(); return; }   // local test: no login
    s.auth.onAuthStateChanged(onUser);
  });

  /* optional: eatongoExport() in console downloads orders.json (staff only) */
  window.eatongoExport = async () => {
    const data = await (store || await ready).exportAll();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = 'orders.json'; a.click();
  };
})();
