// ═══════════════════════════════════════════════════════════════════════════════
// Firebase imports (SDK v10.14.1 via CDN)
// ═══════════════════════════════════════════════════════════════════════════════
import { initializeApp }                          from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { initializeApp as initializeSecondaryApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js';
import {
  getFirestore,
  collection,
  doc,
  addDoc,
  setDoc,
  getDoc,
  updateDoc,
  deleteDoc,
  getDocs,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Firebase config
// ═══════════════════════════════════════════════════════════════════════════════
const firebaseConfig = {
  apiKey:            'AIzaSyAScvbOX6pJLvIXMgP7O5QqM85ZgTfX-Go',
  authDomain:        'laporan-keuangan-hs.firebaseapp.com',
  projectId:         'laporan-keuangan-hs',
  storageBucket:     'laporan-keuangan-hs.firebasestorage.app',
  messagingSenderId: '1029348456158',
  appId:             '1:1029348456158:web:8de02f1258e332ba96344f',
  measurementId:     'G-0HTZZ3Z4KX',
};

// Primary app (untuk user yang sedang login)
const app     = initializeApp(firebaseConfig);
const auth    = getAuth(app);
const db      = getFirestore(app);
const storage = getStorage(app);

// Secondary app (untuk buat user baru tanpa logout admin)
let secondaryApp  = null;
let secondaryAuth = null;
function getSecondaryAuth() {
  if (!secondaryApp) {
    secondaryApp  = initializeSecondaryApp(firebaseConfig, 'secondary');
    secondaryAuth = getAuth(secondaryApp);
  }
  return secondaryAuth;
}

// ═══════════════════════════════════════════════════════════════════════════════
// State in-memory (diisi oleh onSnapshot)
// ═══════════════════════════════════════════════════════════════════════════════
let suppliers = [];
let pembelian = [];
let kasirData = [];
let users     = [];
let poData    = [];
let rekening  = [];

// User yang sedang login
let currentUser     = null; // Firebase Auth user object
let currentUserData = null; // Firestore users/{uid} document data
let currentRole     = null; // string: 'admin' | 'pengurus' | 'kasir' | 'pengawas'

// Flag untuk mencegah onAuthStateChanged mengganggu proses setup
let isSettingUp = false;

// Unsubscribe handles untuk onSnapshot
const unsubs = [];

// ═══════════════════════════════════════════════════════════════════════════════
// Utils
// ═══════════════════════════════════════════════════════════════════════════════
const rupiah  = n => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
const today   = () => new Date().toISOString().split('T')[0];
const monthOf = d => (d ? String(d).slice(0, 7) : '');

function toast(msg, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast ' + type;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 3000);
}

function showEl(id)  { document.getElementById(id)?.classList.remove('hidden'); }
function hideEl(id)  { document.getElementById(id)?.classList.add('hidden'); }
function setEl(id, v){ const e = document.getElementById(id); if (e) e.textContent = v; }

// ═══════════════════════════════════════════════════════════════════════════════
// Screen switching
// ═══════════════════════════════════════════════════════════════════════════════
function showScreen(name) {
  // name: 'loading' | 'login' | 'setup' | 'app'
  document.getElementById('global-loading').classList.toggle('hidden', name !== 'loading');
  document.getElementById('login-screen').classList.toggle('hidden', name !== 'login');
  document.getElementById('setup-screen').classList.toggle('hidden', name !== 'setup');
  document.getElementById('app').classList.toggle('hidden', name !== 'app');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Role-based nav / UI
// ═══════════════════════════════════════════════════════════════════════════════
const ROLE_PAGES = {
  admin:    ['dashboard', 'pembelian', 'kasir', 'supplier', 'po', 'rekening', 'laporan', 'admin'],
  pengurus: ['dashboard', 'pembelian', 'supplier', 'po', 'rekening', 'laporan'],
  kasir:    ['kasir'],
  pengawas: ['dashboard', 'po', 'laporan'],
};

function applyRoleUI(role) {
  // Nav buttons
  document.querySelectorAll('.nav-btn').forEach(btn => {
    const page = btn.dataset.page;
    const allowed = (ROLE_PAGES[role] || []).includes(page);
    btn.style.display = allowed ? '' : 'none';
  });

  // Hide action forms for pengawas (read-only)
  const isReadOnly = role === 'pengawas';
  ['form-pembelian-wrap', 'form-kasir-wrap', 'form-supplier-wrap', 'form-po-wrap'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = isReadOnly ? 'none' : '';
  });

  // Hide hapus buttons via CSS class on the column header (rendered dynamically too)
  document.querySelectorAll('.col-aksi').forEach(th => {
    th.style.display = isReadOnly ? 'none' : '';
  });
}

function setUserBadge(data) {
  setEl('user-name', data.nama || data.email || '');
  const badge = document.getElementById('user-role-badge');
  if (badge) {
    badge.textContent = data.role;
    badge.className = 'role-badge role-' + data.role;
  }
  const welcomeName = document.getElementById('dash-welcome-name');
  if (welcomeName) welcomeName.textContent = (data.nama || data.email || '').split(' ')[0];
  const welcomeDate = document.getElementById('dash-welcome-date');
  if (welcomeDate) {
    const now = new Date();
    welcomeDate.textContent = now.toLocaleDateString('id-ID', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Navigation
// ═══════════════════════════════════════════════════════════════════════════════
function navigateTo(page) {
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const pageEl = document.getElementById('page-' + page);
  if (pageEl) pageEl.classList.add('active');

  if (page === 'dashboard') renderDashboard();
  if (page === 'laporan')   renderLaporan();
  if (page === 'admin')     renderUsers();
  if (page === 'rekening')  renderRekening();
  if (page === 'po') {
    generatePONumber().then(n => { const el = document.getElementById('po-nomor'); if (el) el.value = n; });
    if (!document.getElementById('tbody-po-items').children.length) addItemRow();
    renderPO();
  }
}

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => navigateTo(btn.dataset.page));
});

// ═══════════════════════════════════════════════════════════════════════════════
// First-run check: baca dokumen meta/config (publicly readable)
// ═══════════════════════════════════════════════════════════════════════════════
async function checkFirstRun() {
  const snap = await getDoc(doc(db, 'meta', 'config'));
  return !snap.exists() || snap.data()?.initialized !== true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SETUP SCREEN (admin pertama)
// ═══════════════════════════════════════════════════════════════════════════════
document.getElementById('btn-setup').addEventListener('click', async () => {
  const nama     = document.getElementById('setup-nama').value.trim();
  const email    = document.getElementById('setup-email').value.trim();
  const password = document.getElementById('setup-password').value;
  const errEl    = document.getElementById('setup-error');
  const loadEl   = document.getElementById('setup-loading');

  errEl.classList.add('hidden');
  if (!nama || !email || !password) { errEl.textContent = 'Semua field wajib diisi.'; errEl.classList.remove('hidden'); return; }
  if (password.length < 6) { errEl.textContent = 'Password minimal 6 karakter.'; errEl.classList.remove('hidden'); return; }

  hideEl('btn-setup');
  showEl('setup-loading');

  try {
    isSettingUp = true;
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await setDoc(doc(db, 'users', cred.user.uid), {
      uid: cred.user.uid, nama, email, role: 'admin', active: true,
      createdAt: serverTimestamp(),
    });
    await setDoc(doc(db, 'meta', 'config'), { initialized: true });
    isSettingUp = false;
    // Trigger manual karena onAuthStateChanged sudah lewat
    currentUser     = cred.user;
    currentUserData = { uid: cred.user.uid, nama, email, role: 'admin', active: true };
    currentRole     = 'admin';
    setUserBadge(currentUserData);
    applyRoleUI('admin');
    startListeners();
    showScreen('app');
    navigateTo('dashboard');
  } catch (e) {
    isSettingUp = false;
    errEl.textContent = friendlyError(e.code);
    errEl.classList.remove('hidden');
    showEl('btn-setup');
    hideEl('setup-loading');
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// LOGIN SCREEN
// ═══════════════════════════════════════════════════════════════════════════════
document.getElementById('btn-login').addEventListener('click', doLogin);
document.getElementById('login-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') doLogin();
});

async function doLogin() {
  const email    = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl    = document.getElementById('login-error');
  errEl.classList.add('hidden');

  if (!email || !password) { errEl.textContent = 'Email dan password wajib diisi.'; errEl.classList.remove('hidden'); return; }

  hideEl('btn-login');
  showEl('login-loading');

  try {
    await signInWithEmailAndPassword(auth, email, password);
    // onAuthStateChanged handle selanjutnya — termasuk cek active
  } catch (e) {
    errEl.textContent = friendlyError(e.code);
    errEl.classList.remove('hidden');
    showEl('btn-login');
    hideEl('login-loading');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGOUT
// ═══════════════════════════════════════════════════════════════════════════════
document.getElementById('btn-logout').addEventListener('click', async () => {
  stopListeners();
  await signOut(auth);
  currentUser     = null;
  currentUserData = null;
  currentRole     = null;
  showScreen('login');
  document.getElementById('login-password').value = '';
  document.getElementById('login-error').classList.add('hidden');
});

// ═══════════════════════════════════════════════════════════════════════════════
// onAuthStateChanged — titik utama alur app
// ═══════════════════════════════════════════════════════════════════════════════
showScreen('loading');

onAuthStateChanged(auth, async (firebaseUser) => {
  if (isSettingUp) return; // Tunggu setup selesai dulu
  if (!firebaseUser) {
    // Tidak login — cek first-run
    try {
      const isFirst = await checkFirstRun();
      showScreen(isFirst ? 'setup' : 'login');
    } catch {
      showScreen('login');
    }
    return;
  }

  // Ambil data user dari Firestore
  try {
    const userSnap = await getDocs(query(collection(db, 'users')));
    const userDoc  = userSnap.docs.find(d => d.id === firebaseUser.uid);
    if (!userDoc) {
      // Data Firestore user tidak ada (mungkin setup belum selesai tulis)
      // Tunggu sebentar lalu coba lagi dengan logout
      await signOut(auth);
      showScreen('login');
      return;
    }
    const userData = userDoc.data();

    // Cek active
    if (userData.active === false) {
      await signOut(auth);
      const errEl = document.getElementById('login-error');
      errEl.textContent = 'Akun Anda telah dinonaktifkan. Hubungi Admin.';
      errEl.classList.remove('hidden');
      showScreen('login');
      return;
    }

    currentUser     = firebaseUser;
    currentUserData = userData;
    currentRole     = userData.role;

    setUserBadge(userData);
    applyRoleUI(currentRole);
    startListeners();
    showScreen('app');
    navigateTo((ROLE_PAGES[currentRole] || ['dashboard'])[0]);

  } catch (e) {
    console.error('Error loading user data:', e);
    await signOut(auth);
    showScreen('login');
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Realtime listeners (onSnapshot)
// ═══════════════════════════════════════════════════════════════════════════════
function startListeners() {
  stopListeners();

  // suppliers
  unsubs.push(onSnapshot(query(collection(db, 'suppliers'), orderBy('createdAt', 'asc')), snap => {
    suppliers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    populateSupplierSelects();
    renderSupplier();
    renderDashboard();
  }));

  // pembelian
  unsubs.push(onSnapshot(query(collection(db, 'pembelian'), orderBy('tgl', 'desc')), snap => {
    pembelian = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderPembelian();
    renderSupplier();
    renderDashboard();
  }));

  // kasir
  unsubs.push(onSnapshot(query(collection(db, 'kasir'), orderBy('tgl', 'desc')), snap => {
    kasirData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderKasir();
    renderSupplier();
    renderDashboard();
  }));

  // users (admin only — tapi kita tetap load untuk keperluan tampil nama)
  unsubs.push(onSnapshot(query(collection(db, 'users'), orderBy('createdAt', 'asc')), snap => {
    users = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (currentRole === 'admin') renderUsers();
  }));

  // rekening
  unsubs.push(onSnapshot(query(collection(db, 'rekening'), orderBy('createdAt', 'asc')), snap => {
    rekening = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    populateRekeningSelects();
    renderRekening();
    renderDashboard();
  }));

  // purchase orders
  unsubs.push(onSnapshot(query(collection(db, 'po'), orderBy('createdAt', 'desc')), snap => {
    poData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderPO();
    renderDashboard();
  }));
}

function stopListeners() {
  unsubs.forEach(u => u && u());
  unsubs.length = 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helper: supplier name & stats
// ═══════════════════════════════════════════════════════════════════════════════
function rekeningName(id) {
  if (!id || id === 'tunai') return 'Tunai';
  const r = rekening.find(x => x.id === id);
  return r ? `${r.nama} (${r.bank})` : id;
}

function populateRekeningSelects() {
  ['kas-rekening'].forEach(selId => {
    const sel = document.getElementById(selId);
    if (!sel) return;
    const prevVal = sel.value;
    const firstOpt = sel.options[0].cloneNode(true);
    sel.innerHTML = '';
    sel.appendChild(firstOpt);
    rekening.forEach(r => {
      const opt = document.createElement('option');
      opt.value = r.id;
      opt.textContent = `${r.nama} (${r.bank})`;
      sel.appendChild(opt);
    });
    sel.value = prevVal;
  });
}

function supplierName(id) {
  return suppliers.find(s => s.id === id)?.nama || id || '-';
}

function supplierStats(supId) {
  const totalBeli  = pembelian
    .filter(p => p.supplierId === supId)
    .reduce((a, p) => a + Number(p.total || 0), 0);
  const totalBayar = kasirData
    .filter(k => k.kategori === 'bayar-supplier' && k.supplierId === supId)
    .reduce((a, k) => a + Number(k.jumlah || 0), 0);
  return { totalBeli, totalBayar, hutang: Math.max(0, totalBeli - totalBayar) };
}

function populateSupplierSelects() {
  ['beli-supplier', 'filter-beli-supplier', 'kas-supplier', 'filter-kas-supplier', 'po-supplier', 'filter-po-supplier'].forEach(selId => {
    const sel = document.getElementById(selId);
    if (!sel) return;
    const prevVal = sel.value;
    const firstOpt = sel.options[0].cloneNode(true);
    sel.innerHTML = '';
    sel.appendChild(firstOpt);
    suppliers.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = `${s.nama} (${s.asal})`;
      sel.appendChild(opt);
    });
    sel.value = prevVal;
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════════
function renderDashboard() {
  const totalMasuk    = kasirData.filter(k => k.jenis === 'pemasukan').reduce((a, k) => a + Number(k.jumlah || 0), 0);
  const totalKeluar   = kasirData.filter(k => k.jenis === 'pengeluaran').reduce((a, k) => a + Number(k.jumlah || 0), 0);
  const totalBeli     = pembelian.reduce((a, p) => a + Number(p.total || 0), 0);
  const totalBayarSup = kasirData.filter(k => k.kategori === 'bayar-supplier').reduce((a, k) => a + Number(k.jumlah || 0), 0);
  const totalHutang   = suppliers.reduce((a, s) => a + supplierStats(s.id).hutang, 0);

  const saldo = totalMasuk - totalKeluar;
  const totalPOAktif = poData
    .filter(p => p.status === 'pending' || p.status === 'dikirim')
    .reduce((a, p) => a + Number(p.totalNilai || 0), 0);
  const perluDisiapkan = Math.max(0, totalPOAktif - saldo);

  setEl('dash-pemasukan',      rupiah(totalMasuk));
  setEl('dash-pengeluaran',    rupiah(totalKeluar));
  setEl('dash-saldo',          rupiah(saldo));
  setEl('dash-hutang',         rupiah(totalHutang));
  setEl('dash-pembelian',      rupiah(totalBeli));
  setEl('dash-bayar-supplier', rupiah(totalBayarSup));
  setEl('dash-po-aktif',       rupiah(totalPOAktif));
  setEl('dash-perlu-disiapkan', rupiah(perluDisiapkan));
  const perluCard = document.getElementById('dash-perlu-card');
  if (perluCard) perluCard.className = 'card ' + (perluDisiapkan > 0 ? 'card-red' : 'card-green');

  setEl('bw-po-aktif', rupiah(totalPOAktif));
  setEl('bw-saldo',    rupiah(saldo));
  const bwPerlu = document.getElementById('bw-perlu');
  if (bwPerlu) {
    bwPerlu.textContent = rupiah(perluDisiapkan);
    bwPerlu.className = 'budget-widget-value ' + (perluDisiapkan > 0 ? 'text-red' : 'text-green');
  }

  // Saldo per rekening
  const tbodySaldo = document.getElementById('tbody-saldo-rek');
  if (tbodySaldo) {
    tbodySaldo.innerHTML = '';
    const saldoTunai = kasirData
      .filter(k => !k.via || k.via === 'tunai')
      .reduce((a, k) => a + (k.jenis === 'pemasukan' ? 1 : -1) * Number(k.jumlah || 0), 0);
    const tunaiTr = document.createElement('tr');
    tunaiTr.innerHTML = `<td><strong>Tunai</strong></td><td>—</td><td class="${saldoTunai >= 0 ? 'text-green' : 'text-red'}"><strong>${rupiah(saldoTunai)}</strong></td>`;
    tbodySaldo.appendChild(tunaiTr);
    rekening.forEach(r => {
      const s = kasirData
        .filter(k => k.rekeningId === r.id)
        .reduce((a, k) => a + (k.jenis === 'pemasukan' ? 1 : -1) * Number(k.jumlah || 0), 0);
      const tr = document.createElement('tr');
      tr.innerHTML = `<td><strong>${r.nama}</strong></td><td>${r.bank}${r.noRek ? ' · ' + r.noRek : ''}</td><td class="${s >= 0 ? 'text-green' : 'text-red'}"><strong>${rupiah(s)}</strong></td>`;
      tbodySaldo.appendChild(tr);
    });
  }

  const tbody = document.getElementById('tbody-hutang-summary');
  if (!tbody) return;
  if (!suppliers.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-note">Belum ada data supplier</td></tr>';
    return;
  }
  tbody.innerHTML = '';
  suppliers.forEach(s => {
    const st = supplierStats(s.id);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${s.nama}</strong></td>
      <td>${s.asal}</td>
      <td>${rupiah(st.totalBeli)}</td>
      <td>${rupiah(st.totalBayar)}</td>
      <td class="${st.hutang > 0 ? 'text-red' : 'text-green'}">${rupiah(st.hutang)}</td>
      <td>${st.hutang <= 0 ? '<span class="badge badge-lunas">Lunas</span>' : '<span class="badge badge-hutang">Ada Hutang</span>'}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUPPLIER page
// ═══════════════════════════════════════════════════════════════════════════════
function renderSupplier() {
  const tbody = document.getElementById('tbody-supplier');
  if (!tbody) return;
  if (!suppliers.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty-note">Belum ada supplier</td></tr>`;
    return;
  }
  tbody.innerHTML = '';
  const isReadOnly = currentRole === 'pengawas';
  suppliers.forEach(s => {
    const st = supplierStats(s.id);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${s.nama}</strong></td>
      <td>${s.asal}</td>
      <td>${s.jenis || '-'}</td>
      <td>${s.hp || '-'}</td>
      <td>${rupiah(st.totalBeli)}</td>
      <td>${rupiah(st.totalBayar)}</td>
      <td class="${st.hutang > 0 ? 'text-red' : 'text-green'}">${rupiah(st.hutang)}</td>
      <td>${st.hutang <= 0 ? '<span class="badge badge-lunas">Lunas</span>' : '<span class="badge badge-hutang">Ada Hutang</span>'}</td>
      <td style="${isReadOnly ? 'display:none' : ''}">
        <button class="btn-sm btn-sm-red" data-del-sup="${s.id}">Hapus</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

document.getElementById('btn-simpan-sup').addEventListener('click', async () => {
  const nama = document.getElementById('sup-nama').value.trim();
  if (!nama) { toast('Nama supplier wajib diisi', 'error'); return; }
  try {
    await addDoc(collection(db, 'suppliers'), {
      nama,
      asal:  document.getElementById('sup-asal').value,
      jenis: document.getElementById('sup-jenis').value.trim() || '-',
      hp:    document.getElementById('sup-hp').value.trim(),
      ket:   document.getElementById('sup-ket').value.trim(),
      createdAt: serverTimestamp(),
    });
    ['sup-nama', 'sup-jenis', 'sup-hp', 'sup-ket'].forEach(id => { document.getElementById(id).value = ''; });
    toast('Supplier berhasil ditambahkan');
  } catch (e) {
    toast('Gagal menyimpan: ' + e.message, 'error');
  }
});

document.getElementById('tbody-supplier').addEventListener('click', e => {
  const id = e.target.dataset.delSup;
  if (!id) return;
  const s = suppliers.find(x => x.id === id);
  confirmDelete(`Hapus supplier <strong>${s?.nama || ''}</strong>?`, async () => {
    try {
      await deleteDoc(doc(db, 'suppliers', id));
      toast('Supplier dihapus');
    } catch (err) {
      toast('Gagal menghapus: ' + err.message, 'error');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PEMBELIAN page
// ═══════════════════════════════════════════════════════════════════════════════
function calcBeliTotal() {
  const qty   = Number(document.getElementById('beli-qty').value) || 0;
  const harga = Number(document.getElementById('beli-harga').value) || 0;
  document.getElementById('beli-total').value = rupiah(qty * harga);
}
document.getElementById('beli-qty').addEventListener('input', calcBeliTotal);
document.getElementById('beli-harga').addEventListener('input', calcBeliTotal);

function renderPembelian(filter = {}) {
  const tbody = document.getElementById('tbody-pembelian');
  if (!tbody) return;
  let data = [...pembelian];
  if (filter.bulan)      data = data.filter(p => monthOf(p.tgl) === filter.bulan);
  if (filter.supplierId) data = data.filter(p => p.supplierId === filter.supplierId);
  data.sort((a, b) => String(b.tgl).localeCompare(String(a.tgl)));

  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty-note">Belum ada data pembelian</td></tr>`;
    setEl('tfoot-pembelian-total', rupiah(0));
    return;
  }

  tbody.innerHTML = '';
  const isReadOnly = currentRole === 'pengawas';
  let totalSum = 0;
  data.forEach(p => {
    totalSum += Number(p.total || 0);
    const bayarBadge = p.caraBayar === 'hutang'
      ? '<span class="badge badge-hutang">Hutang</span>'
      : p.caraBayar === 'tunai'
      ? '<span class="badge badge-tunai">Tunai</span>'
      : '<span class="badge badge-transfer">Transfer</span>';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${p.tgl}</td>
      <td>${supplierName(p.supplierId)}</td>
      <td>${p.jenis}</td>
      <td>${p.qty}</td>
      <td>${rupiah(p.harga)}</td>
      <td><strong>${rupiah(p.total)}</strong></td>
      <td>${bayarBadge}</td>
      <td>${p.ket || '-'}</td>
      <td style="${isReadOnly ? 'display:none' : ''}">
        <button class="btn-sm btn-sm-red" data-del-beli="${p.id}">Hapus</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
  setEl('tfoot-pembelian-total', rupiah(totalSum));
}

document.getElementById('btn-simpan-beli').addEventListener('click', async () => {
  const tgl    = document.getElementById('beli-tgl').value;
  const supId  = document.getElementById('beli-supplier').value;
  const jenis  = document.getElementById('beli-jenis').value.trim();
  const qty    = Number(document.getElementById('beli-qty').value);
  const harga  = Number(document.getElementById('beli-harga').value);
  if (!tgl || !supId || !jenis || !qty || !harga) { toast('Lengkapi semua field wajib', 'error'); return; }
  try {
    await addDoc(collection(db, 'pembelian'), {
      tgl, supplierId: supId, jenis, qty, harga,
      total: qty * harga,
      caraBayar: document.getElementById('beli-carabayar').value,
      ket: document.getElementById('beli-ket').value.trim(),
      createdAt: serverTimestamp(),
    });
    ['beli-tgl', 'beli-jenis', 'beli-qty', 'beli-harga', 'beli-ket'].forEach(id => { document.getElementById(id).value = ''; });
    document.getElementById('beli-total').value = '';
    document.getElementById('beli-supplier').value = '';
    document.getElementById('beli-tgl').value = today();
    toast('Pembelian berhasil disimpan');
  } catch (e) {
    toast('Gagal menyimpan: ' + e.message, 'error');
  }
});

document.getElementById('btn-filter-beli').addEventListener('click', () => {
  renderPembelian({
    bulan:      document.getElementById('filter-beli-bulan').value,
    supplierId: document.getElementById('filter-beli-supplier').value,
  });
});

document.getElementById('tbody-pembelian').addEventListener('click', e => {
  const id = e.target.dataset.delBeli;
  if (!id) return;
  confirmDelete('Hapus data pembelian ini?', async () => {
    try {
      await deleteDoc(doc(db, 'pembelian', id));
      toast('Data pembelian dihapus');
    } catch (err) {
      toast('Gagal menghapus: ' + err.message, 'error');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// KASIR page
// ═══════════════════════════════════════════════════════════════════════════════
document.getElementById('kas-kategori').addEventListener('change', function () {
  document.getElementById('kas-supplier-wrap').style.display =
    this.value === 'bayar-supplier' ? '' : 'none';
});

document.getElementById('kas-via').addEventListener('change', function () {
  document.getElementById('kas-rekening-wrap').style.display =
    this.value === 'transfer' ? '' : 'none';
});

function renderKasir(filter = {}) {
  const tbody = document.getElementById('tbody-kasir');
  if (!tbody) return;
  let data = [...kasirData];
  if (filter.bulan) data = data.filter(k => monthOf(k.tgl) === filter.bulan);
  if (filter.jenis) data = data.filter(k => k.jenis === filter.jenis);
  data.sort((a, b) => String(b.tgl).localeCompare(String(a.tgl)));

  let masuk = 0, keluar = 0;
  const isReadOnly = currentRole === 'pengawas';

  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-note">Belum ada transaksi kas</td></tr>`;
  } else {
    tbody.innerHTML = '';
    data.forEach(k => {
      if (k.jenis === 'pemasukan') masuk  += Number(k.jumlah || 0);
      else                         keluar += Number(k.jumlah || 0);
      const jenisBadge = k.jenis === 'pemasukan'
        ? '<span class="badge badge-pemasukan">Pemasukan</span>'
        : '<span class="badge badge-pengeluaran">Pengeluaran</span>';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${k.tgl}</td>
        <td>${jenisBadge}</td>
        <td>${k.kategori}</td>
        <td>${k.supplierId ? supplierName(k.supplierId) : '-'}</td>
        <td class="${k.jenis === 'pemasukan' ? 'text-green' : 'text-red'}"><strong>${rupiah(k.jumlah)}</strong></td>
        <td>${!k.via || k.via === 'tunai' ? 'Tunai' : rekeningName(k.rekeningId)}</td>
        <td>${k.ket || '-'}</td>
        <td style="${isReadOnly ? 'display:none' : ''}">
          <button class="btn-sm btn-sm-red" data-del-kas="${k.id}">Hapus</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  setEl('tfoot-kas-masuk', rupiah(masuk));
  setEl('tfoot-kas-keluar', rupiah(keluar));
  const saldo    = masuk - keluar;
  const saldoEl  = document.getElementById('tfoot-kas-saldo');
  if (saldoEl) {
    saldoEl.textContent = rupiah(saldo);
    saldoEl.className   = 'tfoot-value ' + (saldo >= 0 ? 'text-green' : 'text-red');
  }
}

document.getElementById('btn-simpan-kas').addEventListener('click', async () => {
  const tgl       = document.getElementById('kas-tgl').value;
  const jenis     = document.getElementById('kas-jenis').value;
  const kategori  = document.getElementById('kas-kategori').value;
  const jumlah    = Number(document.getElementById('kas-jumlah').value);
  const supplierId  = kategori === 'bayar-supplier' ? document.getElementById('kas-supplier').value : null;
  const via         = document.getElementById('kas-via').value;
  const rekeningId  = via === 'transfer' ? document.getElementById('kas-rekening').value : null;

  if (!tgl || !jumlah) { toast('Tanggal dan jumlah wajib diisi', 'error'); return; }
  if (kategori === 'bayar-supplier' && !supplierId) { toast('Pilih supplier untuk pembayaran hutang', 'error'); return; }
  if (via === 'transfer' && !rekeningId) { toast('Pilih rekening untuk transfer', 'error'); return; }

  try {
    await addDoc(collection(db, 'kasir'), {
      tgl, jenis, kategori, jumlah,
      supplierId:  supplierId  || null,
      via,
      rekeningId:  rekeningId  || null,
      ket: document.getElementById('kas-ket').value.trim(),
      createdAt: serverTimestamp(),
    });
    ['kas-tgl', 'kas-jumlah', 'kas-ket'].forEach(id => { document.getElementById(id).value = ''; });
    document.getElementById('kas-supplier').value  = '';
    document.getElementById('kas-rekening').value  = '';
    document.getElementById('kas-supplier-wrap').style.display  = 'none';
    document.getElementById('kas-rekening-wrap').style.display  = 'none';
    document.getElementById('kas-via').value       = 'tunai';
    document.getElementById('kas-tgl').value       = today();
    toast('Transaksi berhasil disimpan');
  } catch (e) {
    toast('Gagal menyimpan: ' + e.message, 'error');
  }
});

document.getElementById('btn-filter-kas').addEventListener('click', () => {
  renderKasir({
    bulan: document.getElementById('filter-kas-bulan').value,
    jenis: document.getElementById('filter-kas-jenis').value,
  });
});

document.getElementById('tbody-kasir').addEventListener('click', e => {
  const id = e.target.dataset.delKas;
  if (!id) return;
  confirmDelete('Hapus transaksi ini?', async () => {
    try {
      await deleteDoc(doc(db, 'kasir', id));
      toast('Transaksi dihapus');
    } catch (err) {
      toast('Gagal menghapus: ' + err.message, 'error');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// LAPORAN page
// ═══════════════════════════════════════════════════════════════════════════════
function renderLaporan() {
  const bulan  = document.getElementById('filter-laporan-bulan').value;
  const output = document.getElementById('laporan-output');
  if (!bulan) { output.innerHTML = '<p class="empty-note">Pilih bulan dan klik "Tampilkan Laporan"</p>'; return; }

  const beliBulan  = pembelian.filter(p => monthOf(p.tgl) === bulan);
  const kasirBulan = kasirData.filter(k => monthOf(k.tgl) === bulan);

  const totalBeli     = beliBulan.reduce((a, p) => a + Number(p.total || 0), 0);
  const totalMasuk    = kasirBulan.filter(k => k.jenis === 'pemasukan').reduce((a, k) => a + Number(k.jumlah || 0), 0);
  const totalKeluar   = kasirBulan.filter(k => k.jenis === 'pengeluaran').reduce((a, k) => a + Number(k.jumlah || 0), 0);
  const totalBayarSup = kasirBulan.filter(k => k.kategori === 'bayar-supplier').reduce((a, k) => a + Number(k.jumlah || 0), 0);

  // Pemasukan & pengeluaran per kategori
  const masukKat = {};
  kasirBulan.filter(k => k.jenis === 'pemasukan').forEach(k => { masukKat[k.kategori] = (masukKat[k.kategori] || 0) + Number(k.jumlah || 0); });
  const keluarKat = {};
  kasirBulan.filter(k => k.jenis === 'pengeluaran').forEach(k => { keluarKat[k.kategori] = (keluarKat[k.kategori] || 0) + Number(k.jumlah || 0); });

  // Hutang kumulatif per supplier s/d bulan ini
  const allBeliUntil  = pembelian.filter(p => monthOf(p.tgl) <= bulan);
  const allBayarUntil = kasirData.filter(k => k.kategori === 'bayar-supplier' && monthOf(k.tgl) <= bulan);
  const hutangRows = suppliers.map(s => {
    const beli  = allBeliUntil.filter(p => p.supplierId === s.id).reduce((a, p) => a + Number(p.total || 0), 0);
    const bayar = allBayarUntil.filter(k => k.supplierId === s.id).reduce((a, k) => a + Number(k.jumlah || 0), 0);
    return { nama: s.nama, asal: s.asal, beli, bayar, hutang: Math.max(0, beli - bayar) };
  });

  const [y, m]    = bulan.split('-');
  const namaBulan = new Date(Number(y), Number(m) - 1).toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });

  let html = `<h2 style="margin-bottom:20px;font-size:17px;font-weight:700">Laporan Keuangan — ${namaBulan}</h2>`;

  // 1. Arus Kas
  html += `<div class="laporan-section"><h3>1. Arus Kas</h3>`;
  html += `<div class="laporan-row"><span><strong>Pemasukan</strong></span></div>`;
  if (Object.keys(masukKat).length) {
    Object.entries(masukKat).forEach(([kat, val]) => {
      html += `<div class="laporan-row" style="padding-left:16px"><span>${kat}</span><span class="text-green">${rupiah(val)}</span></div>`;
    });
  } else {
    html += `<div class="laporan-row" style="padding-left:16px"><span>Tidak ada pemasukan</span><span>Rp 0</span></div>`;
  }
  html += `<div class="laporan-row"><span><em>Total Pemasukan</em></span><span class="text-green"><strong>${rupiah(totalMasuk)}</strong></span></div>`;
  html += `<div class="laporan-row"><span><strong>Pengeluaran</strong></span></div>`;
  if (Object.keys(keluarKat).length) {
    Object.entries(keluarKat).forEach(([kat, val]) => {
      html += `<div class="laporan-row" style="padding-left:16px"><span>${kat}</span><span class="text-red">${rupiah(val)}</span></div>`;
    });
  } else {
    html += `<div class="laporan-row" style="padding-left:16px"><span>Tidak ada pengeluaran</span><span>Rp 0</span></div>`;
  }
  html += `<div class="laporan-row"><span><em>Total Pengeluaran</em></span><span class="text-red"><strong>${rupiah(totalKeluar)}</strong></span></div>`;
  const saldoBulan = totalMasuk - totalKeluar;
  html += `<div class="laporan-total"><span>Saldo Bersih</span><span class="${saldoBulan >= 0 ? 'text-green' : 'text-red'}">${rupiah(saldoBulan)}</span></div>`;
  html += `</div>`;

  // 2. Pembelian Barang
  html += `<div class="laporan-section"><h3>2. Pembelian Barang Bulan Ini</h3>`;
  if (beliBulan.length) {
    [...beliBulan].sort((a, b) => String(b.tgl).localeCompare(String(a.tgl))).forEach(p => {
      html += `<div class="laporan-row"><span>${p.tgl} — ${supplierName(p.supplierId)} — ${p.jenis} (${p.qty} pcs)</span><span>${rupiah(p.total)}</span></div>`;
    });
  } else {
    html += `<div class="laporan-row"><span>Tidak ada pembelian</span><span>Rp 0</span></div>`;
  }
  html += `<div class="laporan-total"><span>Total Pembelian</span><span>${rupiah(totalBeli)}</span></div>`;
  html += `</div>`;

  // 3. Posisi Hutang Kumulatif
  html += `<div class="laporan-section"><h3>3. Posisi Hutang Supplier (s/d ${namaBulan})</h3>`;
  if (hutangRows.length) {
    hutangRows.forEach(r => {
      html += `<div class="laporan-row">
        <span>${r.nama} (${r.asal})</span>
        <span>Beli: ${rupiah(r.beli)} | Bayar: ${rupiah(r.bayar)} | <strong class="${r.hutang > 0 ? 'text-red' : 'text-green'}">Hutang: ${rupiah(r.hutang)}</strong></span>
      </div>`;
    });
    const totalHutang = hutangRows.reduce((a, r) => a + r.hutang, 0);
    html += `<div class="laporan-total"><span>Total Hutang</span><span class="${totalHutang > 0 ? 'text-red' : 'text-green'}">${rupiah(totalHutang)}</span></div>`;
  } else {
    html += `<div class="laporan-row"><span>Belum ada supplier</span><span>-</span></div>`;
  }
  html += `</div>`;

  // 4. Pembayaran ke Supplier bulan ini
  html += `<div class="laporan-section"><h3>4. Pembayaran ke Supplier Bulan Ini</h3>`;
  const bayarBulan = kasirBulan.filter(k => k.kategori === 'bayar-supplier');
  if (bayarBulan.length) {
    bayarBulan.forEach(k => {
      html += `<div class="laporan-row"><span>${k.tgl} — ${supplierName(k.supplierId)}</span><span>${rupiah(k.jumlah)}</span></div>`;
    });
  } else {
    html += `<div class="laporan-row"><span>Tidak ada pembayaran</span><span>Rp 0</span></div>`;
  }
  html += `<div class="laporan-total"><span>Total Bayar Supplier</span><span>${rupiah(totalBayarSup)}</span></div>`;
  html += `</div>`;

  output.innerHTML = html;
}

document.getElementById('btn-generate-laporan').addEventListener('click', renderLaporan);

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN — manajemen user
// ═══════════════════════════════════════════════════════════════════════════════
function renderUsers() {
  const tbody = document.getElementById('tbody-users');
  if (!tbody) return;
  if (!users.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-note">Belum ada data pengguna</td></tr>`;
    return;
  }
  tbody.innerHTML = '';
  users.forEach(u => {
    const isMe  = u.uid === currentUser?.uid;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${u.nama || '-'}</strong></td>
      <td>${u.email}</td>
      <td><span class="role-badge role-${u.role}">${u.role}</span></td>
      <td>${u.active !== false
        ? '<span class="badge badge-aktif">Aktif</span>'
        : '<span class="badge badge-nonaktif">Nonaktif</span>'
      }</td>
      <td>
        ${isMe ? '<em style="color:var(--text-muted);font-size:12px">Anda</em>' : `
          <button class="btn-sm ${u.active !== false ? 'btn-sm-orange' : 'btn-sm-red'}"
            data-toggle-user="${u.id}"
            data-active="${u.active !== false ? 'true' : 'false'}">
            ${u.active !== false ? 'Nonaktifkan' : 'Aktifkan'}
          </button>
        `}
      </td>
    `;
    tbody.appendChild(tr);
  });
}

document.getElementById('btn-simpan-user').addEventListener('click', async () => {
  const nama     = document.getElementById('usr-nama').value.trim();
  const email    = document.getElementById('usr-email').value.trim();
  const password = document.getElementById('usr-password').value;
  const role     = document.getElementById('usr-role').value;

  if (!nama || !email || !password) { toast('Nama, email, dan password wajib diisi', 'error'); return; }
  if (password.length < 6) { toast('Password minimal 6 karakter', 'error'); return; }

  try {
    // Gunakan secondary app agar admin tidak ter-logout
    const secAuth = getSecondaryAuth();
    const cred    = await createUserWithEmailAndPassword(secAuth, email, password);
    await setDoc(doc(db, 'users', cred.user.uid), {
      uid: cred.user.uid, nama, email, role, active: true,
      createdAt: serverTimestamp(),
    });
    // Logout dari secondary app (supaya bersih)
    await signOut(secAuth);

    ['usr-nama', 'usr-email', 'usr-password'].forEach(id => { document.getElementById(id).value = ''; });
    toast(`Pengguna ${nama} berhasil dibuat`);
  } catch (e) {
    toast('Gagal membuat user: ' + friendlyError(e.code), 'error');
  }
});

document.getElementById('tbody-users').addEventListener('click', async e => {
  const id = e.target.dataset.toggleUser;
  if (!id) return;
  const isActive = e.target.dataset.active === 'true';
  const action   = isActive ? 'Nonaktifkan' : 'Aktifkan';
  const u = users.find(x => x.id === id);
  confirmDelete(`${action} pengguna <strong>${u?.nama || ''}</strong>?`, async () => {
    try {
      await updateDoc(doc(db, 'users', id), { active: !isActive });
      toast(`Pengguna berhasil di${isActive ? 'nonaktifkan' : 'aktifkan'}`);
    } catch (err) {
      toast('Gagal memperbarui: ' + err.message, 'error');
    }
  }, action);
});

// ═══════════════════════════════════════════════════════════════════════════════
// GANTI PASSWORD (reauthenticate + updatePassword)
// ═══════════════════════════════════════════════════════════════════════════════
document.getElementById('btn-ganti-password').addEventListener('click', () => {
  document.getElementById('pw-lama').value = '';
  document.getElementById('pw-baru').value = '';
  document.getElementById('pw-konfirmasi').value = '';
  document.getElementById('pw-error').classList.add('hidden');
  document.getElementById('modal-password').classList.remove('hidden');
});

['btn-pw-close', 'btn-pw-cancel'].forEach(id => {
  document.getElementById(id).addEventListener('click', () => {
    document.getElementById('modal-password').classList.add('hidden');
  });
});

document.getElementById('btn-pw-simpan').addEventListener('click', async () => {
  const lama      = document.getElementById('pw-lama').value;
  const baru      = document.getElementById('pw-baru').value;
  const konfirmasi = document.getElementById('pw-konfirmasi').value;
  const errEl     = document.getElementById('pw-error');

  errEl.classList.add('hidden');
  if (!lama || !baru || !konfirmasi) { errEl.textContent = 'Semua field wajib diisi.'; errEl.classList.remove('hidden'); return; }
  if (baru.length < 6) { errEl.textContent = 'Password baru minimal 6 karakter.'; errEl.classList.remove('hidden'); return; }
  if (baru !== konfirmasi) { errEl.textContent = 'Konfirmasi password tidak cocok.'; errEl.classList.remove('hidden'); return; }

  try {
    const credential = EmailAuthProvider.credential(currentUser.email, lama);
    await reauthenticateWithCredential(currentUser, credential);
    await updatePassword(currentUser, baru);
    document.getElementById('modal-password').classList.add('hidden');
    toast('Password berhasil diubah');
  } catch (e) {
    errEl.textContent = friendlyError(e.code);
    errEl.classList.remove('hidden');
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// MODAL KONFIRMASI (multi-purpose: hapus / toggle)
// ═══════════════════════════════════════════════════════════════════════════════
let _confirmCb = null;

function confirmDelete(msg, cb, confirmLabel = 'Hapus') {
  document.getElementById('modal-body').innerHTML = msg;
  document.getElementById('btn-modal-confirm').textContent = confirmLabel;
  document.getElementById('modal-overlay').classList.remove('hidden');
  _confirmCb = cb;
}

document.getElementById('btn-modal-confirm').addEventListener('click', () => {
  if (_confirmCb) _confirmCb();
  document.getElementById('modal-overlay').classList.add('hidden');
  _confirmCb = null;
});

['btn-modal-cancel', 'btn-modal-close'].forEach(id => {
  document.getElementById(id).addEventListener('click', () => {
    document.getElementById('modal-overlay').classList.add('hidden');
    _confirmCb = null;
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Friendly error messages
// ═══════════════════════════════════════════════════════════════════════════════
function friendlyError(code) {
  const map = {
    'auth/invalid-email':             'Format email tidak valid.',
    'auth/user-not-found':            'Email tidak terdaftar.',
    'auth/wrong-password':            'Password salah.',
    'auth/invalid-credential':        'Email atau password salah.',
    'auth/email-already-in-use':      'Email sudah digunakan.',
    'auth/weak-password':             'Password terlalu lemah. Minimal 6 karakter.',
    'auth/too-many-requests':         'Terlalu banyak percobaan. Coba lagi nanti.',
    'auth/network-request-failed':    'Koneksi gagal. Periksa internet Anda.',
    'auth/requires-recent-login':     'Sesi expired. Silakan login ulang.',
  };
  return map[code] || `Terjadi kesalahan (${code || 'unknown'}). Silakan coba lagi.`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PO & BUDGETING
// ═══════════════════════════════════════════════════════════════════════════════
async function generatePONumber() {
  const year  = new Date().getFullYear();
  const month = String(new Date().getMonth() + 1).padStart(2, '0');
  const seq   = poData.filter(p => String(p.noPO || '').startsWith(`PO-${year}`)).length + 1;
  return `PO-${year}${month}-${String(seq).padStart(3, '0')}`;
}

function addItemRow(nama = '', qty = '', harga = '') {
  const tbody = document.getElementById('tbody-po-items');
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" class="po-item-nama" placeholder="Nama barang" value="${nama}" /></td>
    <td><input type="number" class="po-item-qty" placeholder="0" min="0" value="${qty}" /></td>
    <td><input type="number" class="po-item-harga" placeholder="0" min="0" value="${harga}" /></td>
    <td><input type="text" class="po-item-total" readonly placeholder="Rp 0" /></td>
    <td><button type="button" class="btn-sm btn-sm-red btn-del-po-item">✕</button></td>
  `;
  tbody.appendChild(tr);
  const qtyEl   = tr.querySelector('.po-item-qty');
  const hargaEl = tr.querySelector('.po-item-harga');
  const totalEl = tr.querySelector('.po-item-total');
  const calc = () => {
    totalEl.value = rupiah((Number(qtyEl.value) || 0) * (Number(hargaEl.value) || 0));
    calcPOTotal();
  };
  qtyEl.addEventListener('input', calc);
  hargaEl.addEventListener('input', calc);
  if (nama && qty && harga) calc();
}

function calcPOTotal() {
  let total = 0;
  document.querySelectorAll('#tbody-po-items tr').forEach(tr => {
    total += (Number(tr.querySelector('.po-item-qty')?.value) || 0)
           * (Number(tr.querySelector('.po-item-harga')?.value) || 0);
  });
  setEl('tfoot-po-total', rupiah(total));
}

document.getElementById('tbody-po-items').addEventListener('click', e => {
  if (e.target.classList.contains('btn-del-po-item')) {
    e.target.closest('tr').remove();
    calcPOTotal();
  }
});

document.getElementById('btn-add-po-item').addEventListener('click', () => addItemRow());

document.getElementById('btn-simpan-po').addEventListener('click', async () => {
  const tgl    = document.getElementById('po-tgl').value;
  const supId  = document.getElementById('po-supplier').value;
  const caraBayar = document.getElementById('po-carabayar').value;
  const ket    = document.getElementById('po-ket').value.trim();
  const fotoFile = document.getElementById('po-foto').files[0];

  const items = [];
  let totalNilai = 0;
  document.querySelectorAll('#tbody-po-items tr').forEach(tr => {
    const nama  = tr.querySelector('.po-item-nama')?.value.trim();
    const qty   = Number(tr.querySelector('.po-item-qty')?.value) || 0;
    const harga = Number(tr.querySelector('.po-item-harga')?.value) || 0;
    if (nama && qty && harga) { items.push({ nama, qty, harga, total: qty * harga }); totalNilai += qty * harga; }
  });

  if (!tgl)         { toast('Tanggal wajib diisi', 'error'); return; }
  if (!supId)       { toast('Pilih supplier', 'error'); return; }
  if (!items.length){ toast('Tambahkan minimal 1 item', 'error'); return; }

  const noPO = await generatePONumber();
  let fotoUrl = null;

  if (fotoFile) {
    try {
      const snap = await uploadBytes(storageRef(storage, `po-photos/${Date.now()}_${fotoFile.name}`), fotoFile);
      fotoUrl = await getDownloadURL(snap.ref);
    } catch {
      toast('Foto gagal diupload — aktifkan Firebase Storage dulu. PO disimpan tanpa foto.', 'error');
    }
  }

  try {
    await addDoc(collection(db, 'po'), {
      noPO, tgl, supplierId: supId, items, totalNilai, caraBayar,
      status: 'pending', fotoUrl, ket, createdAt: serverTimestamp(),
    });
    document.getElementById('po-tgl').value    = today();
    document.getElementById('po-supplier').value = '';
    document.getElementById('po-ket').value    = '';
    document.getElementById('po-foto').value   = '';
    document.getElementById('tbody-po-items').innerHTML = '';
    setEl('tfoot-po-total', rupiah(0));
    addItemRow();
    generatePONumber().then(n => { document.getElementById('po-nomor').value = n; });
    toast(`PO ${noPO} berhasil dibuat`);
  } catch (e) {
    toast('Gagal menyimpan PO: ' + e.message, 'error');
  }
});

function renderPO(filter = {}) {
  const tbody = document.getElementById('tbody-po');
  if (!tbody) return;
  let data = [...poData];
  if (filter.status)     data = data.filter(p => p.status === filter.status);
  if (filter.bulan)      data = data.filter(p => monthOf(p.tgl) === filter.bulan);
  if (filter.supplierId) data = data.filter(p => p.supplierId === filter.supplierId);

  if (!data.length) { tbody.innerHTML = '<tr><td colspan="8" class="empty-note">Belum ada Purchase Order</td></tr>'; return; }

  const isReadOnly = currentRole === 'pengawas';
  const statusBadge = {
    pending:    '<span class="badge badge-po-pending">Pending</span>',
    dikirim:    '<span class="badge badge-po-dikirim">Dikirim</span>',
    selesai:    '<span class="badge badge-po-selesai">Selesai</span>',
    dibatalkan: '<span class="badge badge-po-dibatalkan">Dibatalkan</span>',
  };

  tbody.innerHTML = '';
  data.forEach(po => {
    const itemSummary = (po.items || []).map(i => `${i.nama} (${i.qty}x)`).join(', ');
    const fotoCell    = po.fotoUrl ? `<a href="${po.fotoUrl}" target="_blank" class="btn-sm btn-sm-blue">Lihat</a>` : '-';
    let aksi = '';
    if (!isReadOnly) {
      if (po.status === 'pending') {
        aksi += `<button class="btn-sm btn-sm-blue" data-po-status="${po.id}" data-new-status="dikirim" style="margin:1px">Kirim</button>`;
        aksi += `<button class="btn-sm btn-sm-red"  data-po-status="${po.id}" data-new-status="dibatalkan" style="margin:1px">Batal</button>`;
      } else if (po.status === 'dikirim') {
        aksi += `<button class="btn-sm btn-sm-green" data-po-selesai="${po.id}" style="margin:1px">Selesai</button>`;
        aksi += `<button class="btn-sm btn-sm-red"   data-po-status="${po.id}" data-new-status="dibatalkan" style="margin:1px">Batal</button>`;
      }
      if (po.status === 'pending' || po.status === 'dikirim') {
        aksi += `<button class="btn-sm btn-sm-red" data-del-po="${po.id}" style="margin:1px">Hapus</button>`;
      }
    }
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${po.noPO}</strong></td>
      <td>${po.tgl}</td>
      <td>${supplierName(po.supplierId)}</td>
      <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${itemSummary}">${itemSummary}</td>
      <td><strong>${rupiah(po.totalNilai)}</strong></td>
      <td>${statusBadge[po.status] || po.status}</td>
      <td>${fotoCell}</td>
      <td style="white-space:nowrap">${aksi}</td>
    `;
    tbody.appendChild(tr);
  });
}

document.getElementById('tbody-po').addEventListener('click', async e => {
  const statusId = e.target.dataset.poStatus;
  if (statusId) {
    const newStatus = e.target.dataset.newStatus;
    const po = poData.find(p => p.id === statusId);
    const label = newStatus === 'dikirim' ? 'Tandai Terkirim' : 'Batalkan PO';
    confirmDelete(`${label} PO <strong>${po?.noPO || ''}</strong>?`, async () => {
      try { await updateDoc(doc(db, 'po', statusId), { status: newStatus }); toast('PO diperbarui'); }
      catch (err) { toast('Gagal: ' + err.message, 'error'); }
    }, label);
    return;
  }

  const selesaiId = e.target.dataset.poSelesai;
  if (selesaiId) {
    const po = poData.find(p => p.id === selesaiId);
    confirmDelete(
      `Selesaikan PO <strong>${po?.noPO || ''}</strong>?<br><small style="color:var(--text-muted)">${(po?.items||[]).length} item akan masuk ke data Pembelian.</small>`,
      async () => {
        try {
          await Promise.all((po.items || []).map(item =>
            addDoc(collection(db, 'pembelian'), {
              tgl: po.tgl, supplierId: po.supplierId,
              jenis: item.nama, qty: item.qty, harga: item.harga, total: item.total,
              caraBayar: po.caraBayar || 'hutang',
              ket: `Dari PO ${po.noPO}`,
              createdAt: serverTimestamp(),
            })
          ));
          await updateDoc(doc(db, 'po', selesaiId), { status: 'selesai' });
          toast(`PO ${po.noPO} selesai — ${po.items.length} item masuk ke Pembelian`);
        } catch (err) { toast('Gagal: ' + err.message, 'error'); }
      }, 'Selesaikan'
    );
    return;
  }

  const delId = e.target.dataset.delPo;
  if (delId) {
    const po = poData.find(p => p.id === delId);
    confirmDelete(`Hapus PO <strong>${po?.noPO || ''}</strong>?`, async () => {
      try { await deleteDoc(doc(db, 'po', delId)); toast('PO dihapus'); }
      catch (err) { toast('Gagal menghapus: ' + err.message, 'error'); }
    });
  }
});

document.getElementById('btn-filter-po').addEventListener('click', () => {
  renderPO({
    status:     document.getElementById('filter-po-status').value,
    bulan:      document.getElementById('filter-po-bulan').value,
    supplierId: document.getElementById('filter-po-supplier').value,
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// REKENING
// ═══════════════════════════════════════════════════════════════════════════════
function renderRekening() {
  const tbody = document.getElementById('tbody-rekening');
  if (!tbody) return;
  if (!rekening.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-note">Belum ada rekening</td></tr>';
    return;
  }
  tbody.innerHTML = '';
  rekening.forEach(r => {
    const saldo = kasirData
      .filter(k => k.rekeningId === r.id)
      .reduce((a, k) => a + (k.jenis === 'pemasukan' ? 1 : -1) * Number(k.jumlah || 0), 0);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${r.nama}</strong></td>
      <td>${r.bank}</td>
      <td>${r.noRek || '-'}</td>
      <td class="${saldo >= 0 ? 'text-green' : 'text-red'}"><strong>${rupiah(saldo)}</strong></td>
      <td><button class="btn-sm btn-sm-red" data-del-rek="${r.id}">Hapus</button></td>
    `;
    tbody.appendChild(tr);
  });
}

document.getElementById('btn-simpan-rek').addEventListener('click', async () => {
  const nama  = document.getElementById('rek-nama').value.trim();
  const bank  = document.getElementById('rek-bank').value.trim();
  const noRek = document.getElementById('rek-norek').value.trim();
  if (!nama || !bank) { toast('Nama dan bank wajib diisi', 'error'); return; }
  try {
    await addDoc(collection(db, 'rekening'), { nama, bank, noRek, createdAt: serverTimestamp() });
    ['rek-nama', 'rek-bank', 'rek-norek'].forEach(id => { document.getElementById(id).value = ''; });
    toast('Rekening berhasil ditambahkan');
  } catch (e) {
    toast('Gagal menyimpan: ' + e.message, 'error');
  }
});

document.getElementById('tbody-rekening').addEventListener('click', e => {
  const id = e.target.dataset.delRek;
  if (!id) return;
  const r = rekening.find(x => x.id === id);
  confirmDelete(`Hapus rekening <strong>${r?.nama || ''}</strong>?<br><small style="color:var(--text-muted)">Riwayat transaksi tidak ikut terhapus.</small>`, async () => {
    try { await deleteDoc(doc(db, 'rekening', id)); toast('Rekening dihapus'); }
    catch (err) { toast('Gagal menghapus: ' + err.message, 'error'); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Init default dates
// ═══════════════════════════════════════════════════════════════════════════════
document.getElementById('beli-tgl').value = today();
document.getElementById('kas-tgl').value  = today();
document.getElementById('po-tgl').value   = today();
