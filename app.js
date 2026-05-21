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
let suppliers       = [];
let pembelian       = [];
let kasirData       = [];
let users           = [];
let poData          = [];
let rekening        = [];
let anggaranData    = [];  // anggaran non-PO
let piutangData     = [];  // piutang (uang dipinjamkan)
let piutangBayar    = [];  // riwayat pembayaran piutang
let mutasiData      = [];  // transfer internal tunai ↔ rekening
let saldoAwalTunai  = 0;   // dari Firestore settings/saldo-awal
let editingSupId    = null; // id supplier yang sedang diedit
let bayarPembelianId   = null; // id pembelian yang sedang dikonfirmasi bayar

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

// Helper: kembalikan field inputBy untuk disimpan ke Firestore
function inputByFields() {
  return {
    inputBy:     currentUser?.uid || '',
    inputByNama: currentUserData?.nama || currentUser?.email || '',
    inputByRole: currentRole || '',
  };
}

// Helper: render badge "Diinput Oleh" dari data dokumen
function inputByBadge(item) {
  const nama = item.inputByNama || item.inputBy || '';
  const role = item.inputByRole || users.find(u => u.uid === item.inputBy)?.role || '';
  if (!nama) return '<span class="text-muted-sm">–</span>';
  const roleColor = role === 'pengurus' ? '#7c3aed' : role === 'admin' ? '#15803d' : '#2563eb';
  return `<span style="font-size:11px;color:${roleColor};font-weight:600">👤 ${nama}</span>${role ? `<br><span style="font-size:10px;color:#9ca3af">${role}</span>` : ''}`;
}

const KATEGORI_LABEL = {
  'penjualan':      'Penjualan',
  'bayar-supplier': 'Bayar Supplier',
  'gaji':           'Gaji Karyawan',
  'operasional':    'Operasional',
  'lainnya':        'Lainnya',
  'pribadi':        'Pribadi / Pemilik',
  'non-bisnis':     'Non-Bisnis Lainnya',
};
const NON_BISNIS_KAT = ['pribadi', 'non-bisnis'];

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
  admin:    ['dashboard', 'pembelian', 'kasir', 'supplier', 'po', 'rekening', 'piutang', 'transfer', 'laporan', 'admin'],
  pengurus: ['dashboard', 'pembelian', 'supplier', 'po', 'rekening', 'piutang', 'transfer', 'laporan'],
  kasir:    ['kasir', 'pembelian'],
  pengawas: ['dashboard', 'pembelian', 'kasir', 'po', 'rekening', 'piutang', 'laporan'],
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
  ['form-pembelian-wrap', 'form-kasir-wrap', 'form-supplier-wrap', 'form-po-wrap', 'form-anggaran-wrap', 'form-piutang-wrap'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = isReadOnly ? 'none' : '';
  });

  // Saldo awal hanya admin & pengurus
  const saldoForms = ['form-saldo-tunai-wrap', 'form-rekening-wrap'];
  const showSaldo  = role === 'admin' || role === 'pengurus';
  saldoForms.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = showSaldo ? '' : 'none';
  });

  // Hide hapus buttons via CSS class on the column header (rendered dynamically too)
  document.querySelectorAll('.col-aksi').forEach(th => {
    th.style.display = isReadOnly ? 'none' : '';
  });

  // Approval UI hanya untuk admin & pengurus
  const canApprove = role === 'admin' || role === 'pengurus';
  document.querySelectorAll('.col-approval').forEach(el => {
    el.style.display = canApprove ? '' : 'none';
  });
}

// Helper: apakah role saat ini boleh approve
function canApprove() {
  return currentRole === 'admin' || currentRole === 'pengurus';
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
  if (page === 'piutang')   renderPiutang();
  if (page === 'transfer')  renderMutasi();
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

  // anggaran lainnya
  unsubs.push(onSnapshot(query(collection(db, 'anggaran'), orderBy('createdAt', 'desc')), snap => {
    anggaranData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderAnggaran();
    renderDashboard();
  }));

  // mutasi internal
  unsubs.push(onSnapshot(query(collection(db, 'mutasi'), orderBy('tgl', 'desc')), snap => {
    mutasiData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderDashboard();
    renderRekening();
    renderMutasi();
  }));

  // piutang
  unsubs.push(onSnapshot(query(collection(db, 'piutang'), orderBy('createdAt', 'desc')), snap => {
    piutangData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderPiutang();
    renderDashboard();
  }));
  unsubs.push(onSnapshot(query(collection(db, 'piutang_bayar'), orderBy('createdAt', 'asc')), snap => {
    piutangBayar = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderPiutang();
    renderDashboard();
  }));

  // settings (saldo awal)
  unsubs.push(onSnapshot(doc(db, 'settings', 'saldo-awal'), snap => {
    const d = snap.data() || {};
    saldoAwalTunai = Number(d.tunai || 0);
    // isi form input jika sudah ada
    const inputEl = document.getElementById('saldo-awal-tunai');
    if (inputEl && !inputEl.dataset.dirty) inputEl.value = saldoAwalTunai || '';
    renderDashboard();
    renderRekening();
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
  // Dropdown kasir (pilih rekening transfer)
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

  // Dropdown modal bayar supplier (Tunai + semua rekening)
  const bayarRekSel = document.getElementById('bayar-rekening');
  if (bayarRekSel) {
    const prevBayar = bayarRekSel.value;
    bayarRekSel.innerHTML = '<option value="">-- Pilih sumber dana --</option><option value="tunai">💵 Tunai</option>';
    rekening.forEach(r => {
      const opt = document.createElement('option');
      opt.value = r.id;
      opt.textContent = `🏦 ${r.nama} (${r.bank})`;
      bayarRekSel.appendChild(opt);
    });
    if (prevBayar) bayarRekSel.value = prevBayar;
  }

  // Dropdown mutasi: dari & ke (Tunai + semua rekening)
  ['mut-dari', 'mut-ke'].forEach(selId => {
    const sel = document.getElementById(selId);
    if (!sel) return;
    const prevVal = sel.value;
    sel.innerHTML = '<option value="tunai">💵 Tunai</option>';
    rekening.forEach(r => {
      const opt = document.createElement('option');
      opt.value = r.id;
      opt.textContent = `🏦 ${r.nama} (${r.bank})`;
      sel.appendChild(opt);
    });
    sel.value = prevVal || 'tunai';
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
  const totalSaldoAwalRekening = rekening.reduce((a, r) => a + Number(r.saldoAwal || 0), 0);

  const saldo = saldoAwalTunai + totalSaldoAwalRekening + totalMasuk - totalKeluar;
  const totalPOAktif = poData
    .filter(p => p.status === 'pending' || p.status === 'dikirim')
    .reduce((a, p) => a + Number(p.totalNilai || 0), 0);
  const totalAnggaranLain = anggaranData
    .filter(a => a.status !== 'selesai' && a.status !== 'dibatalkan')
    .reduce((a, x) => a + Number(x.target || 0), 0);
  const totalKebutuhan  = totalPOAktif + totalAnggaranLain;
  const perluDisiapkan  = Math.max(0, totalKebutuhan - saldo);

  // Piutang aktif
  const totalPiutangAktif = piutangData
    .filter(p => p.status !== 'lunas')
    .reduce((a, p) => {
      const dibayar = piutangBayar.filter(b => b.piutangId === p.id).reduce((s, b) => s + Number(b.jumlah || 0), 0);
      return a + Math.max(0, Number(p.jumlah || 0) - dibayar);
    }, 0);

  setEl('dash-pemasukan',      rupiah(totalMasuk));
  setEl('dash-pengeluaran',    rupiah(totalKeluar));
  setEl('dash-saldo',          rupiah(saldo));
  setEl('dash-hutang',         rupiah(totalHutang));
  setEl('dash-pembelian',      rupiah(totalBeli));
  setEl('dash-bayar-supplier', rupiah(totalBayarSup));
  setEl('dash-po-aktif',       rupiah(totalPOAktif));
  setEl('dash-perlu-disiapkan', rupiah(perluDisiapkan));
  setEl('dash-piutang',        rupiah(totalPiutangAktif));
  setEl('dash-total-aset',     rupiah(saldo + totalPiutangAktif));
  const perluCard = document.getElementById('dash-perlu-card');
  if (perluCard) perluCard.className = 'card ' + (perluDisiapkan > 0 ? 'card-red' : 'card-green');

  setEl('bw-po-aktif',       rupiah(totalPOAktif));
  setEl('bw-anggaran-lain',  rupiah(totalAnggaranLain));
  setEl('bw-saldo',          rupiah(saldo));
  const bwPerlu = document.getElementById('bw-perlu');
  if (bwPerlu) {
    bwPerlu.textContent = rupiah(perluDisiapkan);
    bwPerlu.className = 'budget-widget-value ' + (perluDisiapkan > 0 ? 'text-red' : 'text-green');
  }

  // Saldo per rekening
  const tbodySaldo = document.getElementById('tbody-saldo-rek');
  if (tbodySaldo) {
    tbodySaldo.innerHTML = '';
    const mutasiMasukTunai  = mutasiData.filter(m => m.ke   === 'tunai').reduce((a, m) => a + Number(m.jumlah || 0), 0);
    const mutasiKeluarTunai = mutasiData.filter(m => m.dari === 'tunai').reduce((a, m) => a + Number(m.jumlah || 0), 0);
    const saldoTunai = saldoAwalTunai
      + kasirData.filter(k => !k.via || k.via === 'tunai')
          .reduce((a, k) => a + (k.jenis === 'pemasukan' ? 1 : -1) * Number(k.jumlah || 0), 0)
      + mutasiMasukTunai - mutasiKeluarTunai;
    const tunaiTr = document.createElement('tr');
    tunaiTr.innerHTML = `<td><strong>Tunai</strong></td><td>—</td><td class="${saldoTunai >= 0 ? 'text-green' : 'text-red'}"><strong>${rupiah(saldoTunai)}</strong></td>`;
    tbodySaldo.appendChild(tunaiTr);
    rekening.forEach(r => {
      const mutMasuk  = mutasiData.filter(m => m.ke   === r.id).reduce((a, m) => a + Number(m.jumlah || 0), 0);
      const mutKeluar = mutasiData.filter(m => m.dari === r.id).reduce((a, m) => a + Number(m.jumlah || 0), 0);
      const s = Number(r.saldoAwal || 0)
        + kasirData.filter(k => k.rekeningId === r.id)
            .reduce((a, k) => a + (k.jenis === 'pemasukan' ? 1 : -1) * Number(k.jumlah || 0), 0)
        + mutMasuk - mutKeluar;
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
function resetSupForm() {
  editingSupId = null;
  ['sup-nama', 'sup-jenis', 'sup-hp', 'sup-ket'].forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('sup-asal').value = 'Jawa';
  document.getElementById('sup-form-title').textContent = 'Tambah Supplier';
  document.getElementById('btn-simpan-sup').textContent = 'Simpan Supplier';
  document.getElementById('btn-batal-sup').style.display = 'none';
}

function renderSupplier() {
  const tbody = document.getElementById('tbody-supplier');
  if (!tbody) return;
  if (!suppliers.length) {
    tbody.innerHTML = `<tr><td colspan="10" class="empty-note">Belum ada supplier</td></tr>`;
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
      <td>${inputByBadge(s)}</td>
      <td style="${isReadOnly ? 'display:none' : ''}">
        <div style="display:flex;gap:4px">
          <button class="btn-sm btn-sm-blue" data-edit-sup="${s.id}">✏️ Edit</button>
          <button class="btn-sm btn-sm-red"  data-del-sup="${s.id}">Hapus</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

document.getElementById('btn-simpan-sup').addEventListener('click', async () => {
  const nama = document.getElementById('sup-nama').value.trim();
  if (!nama) { toast('Nama supplier wajib diisi', 'error'); return; }
  const data = {
    nama,
    asal:  document.getElementById('sup-asal').value,
    jenis: document.getElementById('sup-jenis').value.trim() || '-',
    hp:    document.getElementById('sup-hp').value.trim(),
    ket:   document.getElementById('sup-ket').value.trim(),
  };
  try {
    if (editingSupId) {
      // Mode edit — update dokumen yang ada
      await updateDoc(doc(db, 'suppliers', editingSupId), data);
      toast('Supplier berhasil diperbarui ✓');
    } else {
      // Mode tambah baru
      await addDoc(collection(db, 'suppliers'), { ...data, ...inputByFields(), createdAt: serverTimestamp() });
      toast('Supplier berhasil ditambahkan');
    }
    resetSupForm();
  } catch (e) {
    toast('Gagal menyimpan: ' + e.message, 'error');
  }
});

document.getElementById('btn-batal-sup').addEventListener('click', () => resetSupForm());

document.getElementById('tbody-supplier').addEventListener('click', e => {
  // Edit supplier
  const editId = e.target.dataset.editSup;
  if (editId) {
    const s = suppliers.find(x => x.id === editId);
    if (!s) return;
    editingSupId = editId;
    document.getElementById('sup-nama').value  = s.nama  || '';
    document.getElementById('sup-asal').value  = s.asal  || 'Jawa';
    document.getElementById('sup-jenis').value = s.jenis !== '-' ? (s.jenis || '') : '';
    document.getElementById('sup-hp').value    = s.hp    || '';
    document.getElementById('sup-ket').value   = s.ket   || '';
    document.getElementById('sup-form-title').textContent    = `Edit Supplier: ${s.nama}`;
    document.getElementById('btn-simpan-sup').textContent    = 'Update Supplier';
    document.getElementById('btn-batal-sup').style.display   = '';
    // Scroll ke form
    document.getElementById('form-supplier-wrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }

  // Hapus supplier
  const delId = e.target.dataset.delSup;
  if (!delId) return;
  const s = suppliers.find(x => x.id === delId);
  confirmDelete(`Hapus supplier <strong>${s?.nama || ''}</strong>?`, async () => {
    try {
      await deleteDoc(doc(db, 'suppliers', delId));
      toast('Supplier dihapus');
    } catch (err) {
      toast('Gagal menghapus: ' + err.message, 'error');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TRANSFER INTERNAL (MUTASI)
// ═══════════════════════════════════════════════════════════════════════════════
document.getElementById('btn-simpan-mutasi').addEventListener('click', async () => {
  const dari   = document.getElementById('mut-dari').value;
  const ke     = document.getElementById('mut-ke').value;
  const jumlah = Number(document.getElementById('mut-jumlah').value) || 0;
  const tgl    = document.getElementById('mut-tgl').value;
  if (dari === ke)  { toast('Dari dan Ke tidak boleh sama', 'error'); return; }
  if (!jumlah)      { toast('Jumlah wajib diisi', 'error'); return; }
  if (!tgl)         { toast('Tanggal wajib diisi', 'error'); return; }
  const dariLabel = dari === 'tunai' ? 'Tunai' : (rekening.find(r => r.id === dari)?.nama || dari);
  const keLabel   = ke   === 'tunai' ? 'Tunai' : (rekening.find(r => r.id === ke)?.nama   || ke);
  try {
    await addDoc(collection(db, 'mutasi'), {
      dari, ke, jumlah, tgl,
      dariLabel, keLabel,
      ket: document.getElementById('mut-ket').value.trim() || `Transfer ${dariLabel} → ${keLabel}`,
      ...inputByFields(),
      createdAt: serverTimestamp(),
    });
    ['mut-jumlah', 'mut-ket'].forEach(id => { document.getElementById(id).value = ''; });
    document.getElementById('mut-tgl').value = today();
    toast(`✓ Transfer ${dariLabel} → ${keLabel} berhasil dicatat`);
  } catch (e) { toast('Gagal: ' + e.message, 'error'); }
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
    tbody.innerHTML = `<tr><td colspan="11" class="empty-note">Belum ada data pembelian</td></tr>`;
    setEl('tfoot-pembelian-total', rupiah(0));
    return;
  }

  const isReadOnly   = currentRole === 'pengawas';
  const approvePerms = canApprove();
  tbody.innerHTML = '';
  let totalSum = 0;

  data.forEach(p => {
    totalSum += Number(p.total || 0);

    // Badge cara bayar
    const bayarBadge = p.caraBayar === 'hutang'
      ? '<span class="badge badge-hutang">Hutang</span>'
      : p.caraBayar === 'tunai'
      ? '<span class="badge badge-tunai">Tunai</span>'
      : '<span class="badge badge-transfer">Transfer</span>';

    // Badge status approval
    const status = p.statusApproval || 'menunggu';
    const statusBadge = status === 'disetujui'
      ? '<span class="badge badge-approval-ok">✓ Disetujui</span>'
      : status === 'ditolak'
      ? '<span class="badge badge-approval-no">✗ Ditolak</span>'
      : '<span class="badge badge-approval-wait">⏳ Menunggu</span>';

    // Bukti transfer cell
    const buktiHtml = p.buktiTransfer
      ? `<a href="${p.buktiTransfer}" target="_blank" class="link-bukti">📎 Lihat</a>`
      : '<span class="text-muted-sm">–</span>';

    // Tombol aksi approval (hanya pengurus/admin)
    let approvalBtns = '';
    if (approvePerms) {
      if (status === 'menunggu') {
        approvalBtns = `
          <button class="btn-sm btn-sm-green" data-approve-beli="${p.id}">✓ Setujui</button>
          <button class="btn-sm btn-sm-red"   data-reject-beli="${p.id}">✗ Tolak</button>`;
      }
      approvalBtns += `<button class="btn-sm btn-sm-blue" data-upload-bukti="${p.id}" title="Upload bukti transfer">📎 Bukti</button>`;
    }

    // Badge siapa yang input
    const inputBadge = inputByBadge(p);

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${p.tgl}</td>
      <td>${supplierName(p.supplierId)}</td>
      <td>${p.jenis}</td>
      <td>${p.qty}</td>
      <td>${rupiah(p.harga)}</td>
      <td><strong>${rupiah(p.total)}</strong></td>
      <td>${bayarBadge}</td>
      <td>${p.ket || '–'}</td>
      <td>${inputBadge}</td>
      <td>${statusBadge}</td>
      <td>${buktiHtml}</td>
      <td class="col-aksi" style="${isReadOnly ? 'display:none' : ''}">
        <div style="display:flex;gap:4px;flex-wrap:wrap">
          ${approvalBtns}
          <button class="btn-sm btn-sm-red" data-del-beli="${p.id}">🗑</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });

  setEl('tfoot-pembelian-total', rupiah(totalSum));

  // Sembunyikan kolom aksi untuk kasir jika bukan approval column
  if (!approvePerms && !isReadOnly) {
    // kasir hanya bisa lihat, tidak bisa approve/hapus
    tbody.querySelectorAll('[data-del-beli]').forEach(btn => {
      if (currentRole === 'kasir') btn.style.display = 'none';
    });
  }
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
      statusApproval: 'menunggu',
      buktiTransfer: null,
      inputBy: currentUser?.uid || '',
      inputByNama: currentUserData?.nama || '',
      createdAt: serverTimestamp(),
    });
    ['beli-tgl', 'beli-jenis', 'beli-qty', 'beli-harga', 'beli-ket'].forEach(id => { document.getElementById(id).value = ''; });
    document.getElementById('beli-total').value = '';
    document.getElementById('beli-supplier').value = '';
    document.getElementById('beli-tgl').value = today();
    toast('Pembelian berhasil disimpan, menunggu approval pengurus');
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

document.getElementById('tbody-pembelian').addEventListener('click', async e => {
  // Hapus
  const delId = e.target.dataset.delBeli;
  if (delId) {
    confirmDelete('Hapus data pembelian ini?', async () => {
      try {
        await deleteDoc(doc(db, 'pembelian', delId));
        toast('Data pembelian dihapus');
      } catch (err) {
        toast('Gagal menghapus: ' + err.message, 'error');
      }
    });
    return;
  }

  // Setujui
  const approveId = e.target.dataset.approveBeli;
  if (approveId && canApprove()) {
    try {
      await updateDoc(doc(db, 'pembelian', approveId), {
        statusApproval: 'disetujui',
        approvedBy:   currentUser?.uid || '',
        approvedNama: currentUserData?.nama || '',
        approvedAt:   serverTimestamp(),
      });
      toast('Pembelian disetujui');
    } catch (err) {
      toast('Gagal: ' + err.message, 'error');
    }
    return;
  }

  // Tolak
  const rejectId = e.target.dataset.rejectBeli;
  if (rejectId && canApprove()) {
    try {
      await updateDoc(doc(db, 'pembelian', rejectId), {
        statusApproval: 'ditolak',
        approvedBy:   currentUser?.uid || '',
        approvedNama: currentUserData?.nama || '',
        approvedAt:   serverTimestamp(),
      });
      toast('Pembelian ditolak');
    } catch (err) {
      toast('Gagal: ' + err.message, 'error');
    }
    return;
  }

  // Upload bukti transfer → buka modal konfirmasi bayar
  const uploadId = e.target.dataset.uploadBukti;
  if (uploadId && canApprove()) {
    const p = pembelian.find(x => x.id === uploadId);
    if (!p) return;
    bayarPembelianId = uploadId;
    document.getElementById('bayar-info-supplier').textContent = supplierName(p.supplierId);
    document.getElementById('bayar-info-total').textContent    = rupiah(p.total);
    document.getElementById('bayar-tgl').value                 = today();
    document.getElementById('bayar-bukti-file').value          = '';
    document.getElementById('modal-bayar').classList.remove('hidden');
    return;
  }
});

// ─── Modal Konfirmasi Bayar Supplier ────────────────────────────────────────
function closeBayarModal() {
  document.getElementById('modal-bayar').classList.add('hidden');
  bayarPembelianId = null;
}
['btn-bayar-close', 'btn-bayar-cancel'].forEach(id =>
  document.getElementById(id).addEventListener('click', closeBayarModal)
);

document.getElementById('btn-bayar-konfirm').addEventListener('click', async () => {
  if (!bayarPembelianId) return;
  const tgl       = document.getElementById('bayar-tgl').value;
  const rekeningId = document.getElementById('bayar-rekening').value;
  const file      = document.getElementById('bayar-bukti-file').files[0];

  if (!tgl)       { toast('Tanggal bayar wajib diisi', 'error'); return; }
  if (!rekeningId){ toast('Pilih sumber dana (rekening / tunai)', 'error'); return; }

  const p = pembelian.find(x => x.id === bayarPembelianId);
  if (!p) { closeBayarModal(); return; }

  const btn = document.getElementById('btn-bayar-konfirm');
  btn.disabled = true;
  btn.textContent = '⏳ Menyimpan…';

  try {
    // 1. Upload bukti (jika ada file)
    let buktiUrl = p.buktiTransfer || null;
    if (file) {
      toast('Mengupload bukti…');
      const ref = storageRef(storage, `bukti-transfer/${bayarPembelianId}_${Date.now()}_${file.name}`);
      await uploadBytes(ref, file);
      buktiUrl = await getDownloadURL(ref);
    }

    // 2. Update pembelian: bukti + auto-approve
    await updateDoc(doc(db, 'pembelian', bayarPembelianId), {
      buktiTransfer:   buktiUrl,
      statusApproval:  'disetujui',
      approvedBy:      currentUser?.email || '',
      approvedAt:      serverTimestamp(),
    });

    // 3. Buat entri kasir otomatis
    const via = rekeningId === 'tunai' ? 'tunai' : 'transfer';
    await addDoc(collection(db, 'kasir'), {
      tgl,
      jenis:       'pengeluaran',
      kategori:    'bayar-supplier',
      supplierId:  p.supplierId || null,
      jumlah:      Number(p.total || 0),
      via,
      rekeningId:  via === 'transfer' ? rekeningId : null,
      ket:         `Auto — bayar pembelian ${p.jenis || ''} (${p.tgl})`,
      autoFromBeli: bayarPembelianId,
      ...inputByFields(),
      createdAt:   serverTimestamp(),
    });

    toast('Pembayaran dikonfirmasi, saldo diperbarui ✓');
    closeBayarModal();
  } catch (err) {
    toast('Gagal: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '💾 Konfirmasi Bayar';
  }
});

function renderMutasi() {
  const tbody = document.getElementById('tbody-mutasi');
  if (!tbody) return;
  const data = [...mutasiData].sort((a, b) => String(b.tgl).localeCompare(String(a.tgl)));
  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-note">Belum ada riwayat transfer</td></tr>';
    return;
  }
  tbody.innerHTML = '';
  data.forEach(m => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${m.tgl}</td>
      <td><strong>${m.dariLabel || m.dari}</strong></td>
      <td><strong>${m.keLabel || m.ke}</strong></td>
      <td class="text-green"><strong>${rupiah(m.jumlah)}</strong></td>
      <td>${m.ket || '–'}</td>
      <td>${inputByBadge(m)}</td>
    `;
    tbody.appendChild(tr);
  });
}

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
      const isNonBisnis = NON_BISNIS_KAT.includes(k.kategori);
      const katLabel    = KATEGORI_LABEL[k.kategori] || k.kategori;
      const nbTag       = isNonBisnis ? ' <span class="badge badge-non-bisnis">Non-Bisnis</span>' : '';
      const tr = document.createElement('tr');
      if (isNonBisnis) tr.classList.add('row-non-bisnis');
      tr.innerHTML = `
        <td>${k.tgl}</td>
        <td>${jenisBadge}</td>
        <td>${katLabel}${nbTag}</td>
        <td>${k.supplierId ? supplierName(k.supplierId) : '-'}</td>
        <td class="${k.jenis === 'pemasukan' ? 'text-green' : 'text-red'}"><strong>${rupiah(k.jumlah)}</strong></td>
        <td>${!k.via || k.via === 'tunai' ? 'Tunai' : rekeningName(k.rekeningId)}</td>
        <td>${k.ket || '-'}</td>
        <td>${inputByBadge(k)}</td>
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
      ...inputByFields(),
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
  const keluarSemua   = kasirBulan.filter(k => k.jenis === 'pengeluaran');
  const keluarBisnis  = keluarSemua.filter(k => !NON_BISNIS_KAT.includes(k.kategori));
  const keluarNonBisnis = keluarSemua.filter(k => NON_BISNIS_KAT.includes(k.kategori));
  const totalKeluar         = keluarSemua.reduce((a, k) => a + Number(k.jumlah || 0), 0);
  const totalKeluarBisnis   = keluarBisnis.reduce((a, k) => a + Number(k.jumlah || 0), 0);
  const totalKeluarNonBisnis= keluarNonBisnis.reduce((a, k) => a + Number(k.jumlah || 0), 0);
  const totalBayarSup = kasirBulan.filter(k => k.kategori === 'bayar-supplier').reduce((a, k) => a + Number(k.jumlah || 0), 0);

  // Pemasukan & pengeluaran per kategori
  const masukKat = {};
  kasirBulan.filter(k => k.jenis === 'pemasukan').forEach(k => { masukKat[k.kategori] = (masukKat[k.kategori] || 0) + Number(k.jumlah || 0); });
  const keluarBisnisKat = {};
  keluarBisnis.forEach(k => { keluarBisnisKat[k.kategori] = (keluarBisnisKat[k.kategori] || 0) + Number(k.jumlah || 0); });
  const keluarNonBisnisKat = {};
  keluarNonBisnis.forEach(k => { keluarNonBisnisKat[k.kategori] = (keluarNonBisnisKat[k.kategori] || 0) + Number(k.jumlah || 0); });

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
  html += `<div class="laporan-row"><span><strong>Pengeluaran Bisnis</strong></span></div>`;
  if (Object.keys(keluarBisnisKat).length) {
    Object.entries(keluarBisnisKat).forEach(([kat, val]) => {
      html += `<div class="laporan-row" style="padding-left:16px"><span>${KATEGORI_LABEL[kat] || kat}</span><span class="text-red">${rupiah(val)}</span></div>`;
    });
  } else {
    html += `<div class="laporan-row" style="padding-left:16px"><span>Tidak ada pengeluaran bisnis</span><span>Rp 0</span></div>`;
  }
  html += `<div class="laporan-row"><span><em>Total Pengeluaran Bisnis</em></span><span class="text-red"><strong>${rupiah(totalKeluarBisnis)}</strong></span></div>`;
  html += `<div class="laporan-row" style="margin-top:8px"><span><strong>Pengeluaran Non-Bisnis</strong></span></div>`;
  if (Object.keys(keluarNonBisnisKat).length) {
    Object.entries(keluarNonBisnisKat).forEach(([kat, val]) => {
      html += `<div class="laporan-row" style="padding-left:16px;background:#fffbeb"><span>👤 ${KATEGORI_LABEL[kat] || kat}</span><span class="text-amber">${rupiah(val)}</span></div>`;
    });
  } else {
    html += `<div class="laporan-row" style="padding-left:16px"><span>Tidak ada pengeluaran non-bisnis</span><span>Rp 0</span></div>`;
  }
  html += `<div class="laporan-row"><span><em>Total Non-Bisnis</em></span><span class="text-amber"><strong>${rupiah(totalKeluarNonBisnis)}</strong></span></div>`;
  html += `<div class="laporan-row" style="border-top:1px dashed #d1d5db;margin-top:4px;padding-top:8px"><span><em>Total Semua Pengeluaran</em></span><span class="text-red"><strong>${rupiah(totalKeluar)}</strong></span></div>`;
  const saldoBulan       = totalMasuk - totalKeluar;
  const saldoBisnisOnly  = totalMasuk - totalKeluarBisnis;
  html += `<div class="laporan-total"><span>Saldo Bersih (semua)</span><span class="${saldoBulan >= 0 ? 'text-green' : 'text-red'}">${rupiah(saldoBulan)}</span></div>`;
  html += `<div class="laporan-row text-muted-sm" style="padding:4px 8px;font-size:12px">💡 Saldo bisnis murni (tanpa non-bisnis): <strong class="${saldoBisnisOnly >= 0 ? 'text-green' : 'text-red'}">${rupiah(saldoBisnisOnly)}</strong></div>`;
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
      status: 'pending', fotoUrl, ket, ...inputByFields(), createdAt: serverTimestamp(),
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

  if (!data.length) { tbody.innerHTML = '<tr><td colspan="9" class="empty-note">Belum ada Purchase Order</td></tr>'; return; }

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
      <td>${inputByBadge(po)}</td>
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
// ANGGARAN LAINNYA
// ═══════════════════════════════════════════════════════════════════════════════
const ANGGARAN_STATUS = {
  rencana:    { label: '📝 Rencana',    badge: 'badge-approval-wait' },
  disetujui:  { label: '✓ Disetujui',  badge: 'badge-approval-ok'   },
  selesai:    { label: '✔ Selesai',    badge: 'badge-lunas'          },
  dibatalkan: { label: '✗ Dibatalkan', badge: 'badge-po-dibatalkan'  },
};

function renderAnggaran() {
  const tbody = document.getElementById('tbody-anggaran');
  if (!tbody) return;
  if (!anggaranData.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-note">Belum ada rencana anggaran</td></tr>';
    return;
  }
  const isReadOnly = currentRole === 'pengawas' || currentRole === 'kasir';
  tbody.innerHTML = '';
  anggaranData.forEach(a => {
    const st  = ANGGARAN_STATUS[a.status] || ANGGARAN_STATUS.rencana;
    const tr  = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${a.nama}</strong></td>
      <td>${a.kategori || '–'}</td>
      <td><strong>${rupiah(a.target || 0)}</strong></td>
      <td>${a.tgl || '–'}</td>
      <td><span class="badge ${st.badge}">${st.label}</span></td>
      <td>${a.ket || '–'}</td>
      <td>${inputByBadge(a)}</td>
      <td style="${isReadOnly ? 'display:none' : ''}">
        <div style="display:flex;gap:4px;flex-wrap:wrap">
          ${a.status !== 'selesai' && a.status !== 'dibatalkan' ? `
            <select class="ang-status-select" data-ang-id="${a.id}" style="border:1.5px solid var(--gray-border);border-radius:6px;padding:3px 6px;font-size:12px;background:var(--gray-light)">
              <option value="rencana"    ${a.status === 'rencana'   ? 'selected' : ''}>Rencana</option>
              <option value="disetujui"  ${a.status === 'disetujui' ? 'selected' : ''}>Disetujui</option>
              <option value="selesai"    >Selesai</option>
              <option value="dibatalkan" >Batalkan</option>
            </select>` : ''}
          <button class="btn-sm btn-sm-red" data-del-ang="${a.id}">Hapus</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });

  // Event: ubah status langsung dari dropdown
  tbody.querySelectorAll('.ang-status-select').forEach(sel => {
    sel.addEventListener('change', async function () {
      try {
        await updateDoc(doc(db, 'anggaran', this.dataset.angId), { status: this.value });
        toast('Status anggaran diperbarui ✓');
      } catch (e) { toast('Gagal: ' + e.message, 'error'); }
    });
  });
}

document.getElementById('btn-simpan-ang').addEventListener('click', async () => {
  const nama   = document.getElementById('ang-nama').value.trim();
  const target = Number(document.getElementById('ang-target').value) || 0;
  if (!nama)   { toast('Nama anggaran wajib diisi', 'error'); return; }
  if (!target) { toast('Target dana wajib diisi', 'error'); return; }
  try {
    await addDoc(collection(db, 'anggaran'), {
      nama,
      kategori: document.getElementById('ang-kategori').value,
      target,
      tgl:    document.getElementById('ang-tgl').value,
      ket:    document.getElementById('ang-ket').value.trim(),
      status: 'rencana',
      ...inputByFields(),
      createdAt: serverTimestamp(),
    });
    ['ang-nama', 'ang-target', 'ang-tgl', 'ang-ket'].forEach(id => { document.getElementById(id).value = ''; });
    toast('Rencana anggaran disimpan ✓');
  } catch (e) {
    toast('Gagal menyimpan: ' + e.message, 'error');
  }
});

document.getElementById('tbody-anggaran').addEventListener('click', e => {
  const delId = e.target.dataset.delAng;
  if (!delId) return;
  confirmDelete('Hapus rencana anggaran ini?', async () => {
    try {
      await deleteDoc(doc(db, 'anggaran', delId));
      toast('Anggaran dihapus');
    } catch (err) {
      toast('Gagal: ' + err.message, 'error');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PIUTANG
// ═══════════════════════════════════════════════════════════════════════════════
function piutangStats(id) {
  const dibayar = piutangBayar
    .filter(b => b.piutangId === id)
    .reduce((a, b) => a + Number(b.jumlah || 0), 0);
  return dibayar;
}

function nextCicilanDate(tglMulai, cicilanPerBulan, dibayar, total) {
  if (!tglMulai || !cicilanPerBulan) return '–';
  const sisa = total - dibayar;
  if (sisa <= 0) return '–';
  const start = new Date(tglMulai);
  const bulanSudah = Math.floor(dibayar / cicilanPerBulan);
  const next = new Date(start);
  next.setMonth(next.getMonth() + bulanSudah);
  return next.toISOString().slice(0, 10);
}

function renderPiutang() {
  const tbody = document.getElementById('tbody-piutang');
  if (!tbody) return;
  if (!piutangData.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty-note">Belum ada data piutang</td></tr>';
    ['tfoot-piu-pinjaman','tfoot-piu-bayar','tfoot-piu-sisa'].forEach(id => setEl(id, rupiah(0)));
    return;
  }
  const isReadOnly = currentRole === 'pengawas';
  tbody.innerHTML = '';
  let totPinjaman = 0, totBayar = 0, totSisa = 0;

  piutangData.forEach(p => {
    const dibayar = piutangStats(p.id);
    const sisa    = Math.max(0, Number(p.jumlah || 0) - dibayar);
    const lunas   = sisa <= 0 || p.status === 'lunas';
    const nextTgl = nextCicilanDate(p.tglCicilan, Number(p.cicilan || 0), dibayar, Number(p.jumlah || 0));

    if (!lunas) { totPinjaman += Number(p.jumlah || 0); totBayar += dibayar; totSisa += sisa; }

    const pct = Number(p.jumlah) > 0 ? Math.min(100, Math.round(dibayar / Number(p.jumlah) * 100)) : 0;
    const tr  = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${p.nama}</strong>${p.ket ? `<br><small style="color:var(--text-muted)">${p.ket}</small>` : ''}</td>
      <td>${p.tgl || '–'}</td>
      <td>${rupiah(p.jumlah)}</td>
      <td>
        ${rupiah(dibayar)}
        <div style="height:4px;background:#e2e8f0;border-radius:2px;margin-top:4px;width:80px">
          <div style="height:4px;background:${lunas?'#16a34a':'#0891b2'};border-radius:2px;width:${pct}%"></div>
        </div>
      </td>
      <td class="${sisa > 0 ? 'text-red' : 'text-green'}"><strong>${rupiah(sisa)}</strong></td>
      <td>${p.cicilan ? rupiah(p.cicilan) + '/bln' : '–'}</td>
      <td>${nextTgl !== '–' ? `<span style="font-weight:600">${nextTgl}</span>` : '–'}</td>
      <td>${lunas ? '<span class="badge badge-lunas">✓ Lunas</span>' : '<span class="badge badge-hutang">Aktif</span>'}</td>
      <td>${inputByBadge(p)}</td>
      <td style="${isReadOnly ? 'display:none' : ''}">
        <div style="display:flex;gap:4px;flex-wrap:wrap">
          ${!lunas ? `<button class="btn-sm btn-sm-blue" data-catat-bayar="${p.id}" data-nama="${p.nama}" data-cicilan="${p.cicilan||0}">💰 Catat Bayar</button>` : ''}
          <button class="btn-sm btn-sm-red" data-del-piutang="${p.id}">Hapus</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });

  setEl('tfoot-piu-pinjaman', rupiah(totPinjaman));
  setEl('tfoot-piu-bayar',    rupiah(totBayar));
  setEl('tfoot-piu-sisa',     rupiah(totSisa));
}

// Tambah piutang baru
document.getElementById('btn-simpan-piutang').addEventListener('click', async () => {
  const nama   = document.getElementById('piu-nama').value.trim();
  const jumlah = Number(document.getElementById('piu-jumlah').value) || 0;
  const tgl    = document.getElementById('piu-tgl').value;
  if (!nama || !jumlah || !tgl) { toast('Nama, jumlah, dan tanggal wajib diisi', 'error'); return; }
  try {
    await addDoc(collection(db, 'piutang'), {
      nama, jumlah, tgl,
      cicilan:    Number(document.getElementById('piu-cicilan').value) || 0,
      tglCicilan: document.getElementById('piu-tgl-cicilan').value,
      ket:        document.getElementById('piu-ket').value.trim(),
      status:     'aktif',
      ...inputByFields(),
      createdAt:  serverTimestamp(),
    });
    ['piu-nama','piu-jumlah','piu-tgl','piu-cicilan','piu-tgl-cicilan','piu-ket'].forEach(id => { document.getElementById(id).value = ''; });
    document.getElementById('piu-tgl').value = today();
    toast('Piutang berhasil disimpan ✓');
  } catch (e) { toast('Gagal: ' + e.message, 'error'); }
});

// Klik tabel piutang: catat bayar atau hapus
document.getElementById('tbody-piutang').addEventListener('click', e => {
  const catId = e.target.dataset.catatBayar;
  if (catId) {
    const nama    = e.target.dataset.nama;
    const cicilan = e.target.dataset.cicilan;
    document.getElementById('bayar-piutang-id').value = catId;
    document.getElementById('panel-bayar-title').textContent = `Catat Pembayaran — ${nama}`;
    document.getElementById('bayar-tgl').value    = today();
    document.getElementById('bayar-jumlah').value = cicilan > 0 ? cicilan : '';
    document.getElementById('bayar-ket').value    = '';
    const panel = document.getElementById('panel-catat-bayar');
    panel.style.display = '';
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  const delId = e.target.dataset.delPiutang;
  if (!delId) return;
  const p = piutangData.find(x => x.id === delId);
  confirmDelete(`Hapus piutang <strong>${p?.nama || ''}</strong>? Riwayat bayar ikut terhapus.`, async () => {
    try {
      await deleteDoc(doc(db, 'piutang', delId));
      // hapus semua bayar terkait
      const q = await getDocs(query(collection(db, 'piutang_bayar')));
      await Promise.all(q.docs.filter(d => d.data().piutangId === delId).map(d => deleteDoc(d.ref)));
      toast('Piutang dihapus');
    } catch (err) { toast('Gagal: ' + err.message, 'error'); }
  });
});

// Simpan pembayaran
document.getElementById('btn-simpan-bayar-piutang').addEventListener('click', async () => {
  const piuId  = document.getElementById('bayar-piutang-id').value;
  const jumlah = Number(document.getElementById('bayar-jumlah').value) || 0;
  const tgl    = document.getElementById('bayar-tgl').value;
  if (!jumlah || !tgl) { toast('Tanggal dan jumlah wajib diisi', 'error'); return; }
  try {
    await addDoc(collection(db, 'piutang_bayar'), {
      piutangId: piuId, jumlah, tgl,
      ket: document.getElementById('bayar-ket').value.trim(),
      ...inputByFields(),
      createdAt: serverTimestamp(),
    });
    // Cek apakah sudah lunas
    const p = piutangData.find(x => x.id === piuId);
    if (p) {
      const totalBayarBaru = piutangBayar.filter(b => b.piutangId === piuId).reduce((a, b) => a + Number(b.jumlah||0), 0) + jumlah;
      if (totalBayarBaru >= Number(p.jumlah || 0)) {
        await updateDoc(doc(db, 'piutang', piuId), { status: 'lunas' });
        toast('Pembayaran dicatat — Piutang LUNAS! 🎉');
      } else {
        toast('Pembayaran berhasil dicatat ✓');
      }
    }
    document.getElementById('panel-catat-bayar').style.display = 'none';
  } catch (e) { toast('Gagal: ' + e.message, 'error'); }
});

document.getElementById('btn-batal-bayar-piutang').addEventListener('click', () => {
  document.getElementById('panel-catat-bayar').style.display = 'none';
});

// ═══════════════════════════════════════════════════════════════════════════════
// REKENING
// ═══════════════════════════════════════════════════════════════════════════════
function renderRekening() {
  const tbody = document.getElementById('tbody-rekening');
  if (!tbody) return;
  if (!rekening.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-note">Belum ada rekening</td></tr>';
    return;
  }
  tbody.innerHTML = '';
  rekening.forEach(r => {
    const saldoAwal   = Number(r.saldoAwal || 0);
    const mutMasuk    = mutasiData.filter(m => m.ke   === r.id).reduce((a, m) => a + Number(m.jumlah || 0), 0);
    const mutKeluar   = mutasiData.filter(m => m.dari === r.id).reduce((a, m) => a + Number(m.jumlah || 0), 0);
    const saldoSkrng  = saldoAwal
      + kasirData.filter(k => k.rekeningId === r.id)
          .reduce((a, k) => a + (k.jenis === 'pemasukan' ? 1 : -1) * Number(k.jumlah || 0), 0)
      + mutMasuk - mutKeluar;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${r.nama}</strong></td>
      <td>${r.bank}</td>
      <td>${r.noRek || '–'}</td>
      <td class="cell-saldo-awal" data-rek-id="${r.id}">
        <div class="saldo-awal-display" style="display:flex;align-items:center;gap:6px">
          <span>${rupiah(saldoAwal)}</span>
          <button class="btn-sm btn-sm-blue" data-edit-saldo-rek="${r.id}" data-current="${saldoAwal}" title="Ubah saldo awal">✏️</button>
        </div>
      </td>
      <td class="${saldoSkrng >= 0 ? 'text-green' : 'text-red'}"><strong>${rupiah(saldoSkrng)}</strong></td>
      <td>
        <button class="btn-sm btn-sm-red" data-del-rek="${r.id}">Hapus</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

document.getElementById('btn-simpan-saldo-tunai').addEventListener('click', async () => {
  const val = Number(document.getElementById('saldo-awal-tunai').value) || 0;
  try {
    await setDoc(doc(db, 'settings', 'saldo-awal'), { tunai: val }, { merge: true });
    toast('Saldo awal tunai disimpan ✓');
  } catch (e) {
    toast('Gagal: ' + e.message, 'error');
  }
});

document.getElementById('btn-simpan-rek').addEventListener('click', async () => {
  const nama      = document.getElementById('rek-nama').value.trim();
  const bank      = document.getElementById('rek-bank').value.trim();
  const noRek     = document.getElementById('rek-norek').value.trim();
  const saldoAwal = Number(document.getElementById('rek-saldo-awal').value) || 0;
  if (!nama || !bank) { toast('Nama dan bank wajib diisi', 'error'); return; }
  try {
    await addDoc(collection(db, 'rekening'), { nama, bank, noRek, saldoAwal, createdAt: serverTimestamp() });
    ['rek-nama', 'rek-bank', 'rek-norek', 'rek-saldo-awal'].forEach(id => { document.getElementById(id).value = ''; });
    toast('Rekening berhasil ditambahkan');
  } catch (e) {
    toast('Gagal menyimpan: ' + e.message, 'error');
  }
});

document.getElementById('tbody-rekening').addEventListener('click', async e => {
  // Hapus rekening
  const delId = e.target.dataset.delRek;
  if (delId) {
    const r = rekening.find(x => x.id === delId);
    confirmDelete(`Hapus rekening <strong>${r?.nama || ''}</strong>?<br><small style="color:var(--text-muted)">Riwayat transaksi tidak ikut terhapus.</small>`, async () => {
      try { await deleteDoc(doc(db, 'rekening', delId)); toast('Rekening dihapus'); }
      catch (err) { toast('Gagal menghapus: ' + err.message, 'error'); }
    });
    return;
  }

  // Edit saldo awal rekening — inline di sel tabel
  const editId = e.target.dataset.editSaldoRek;
  if (editId) {
    const cell    = document.querySelector(`.cell-saldo-awal[data-rek-id="${editId}"]`);
    if (!cell || cell.querySelector('.inline-saldo-input')) return; // sudah terbuka
    const current = Number(e.target.dataset.current) || 0;
    cell.innerHTML = `
      <div style="display:flex;align-items:center;gap:4px">
        <input class="inline-saldo-input" type="number" value="${current}" min="0"
          style="width:120px;border:1.5px solid #16a34a;border-radius:6px;padding:4px 8px;font-size:13px;outline:none" />
        <button class="btn-sm btn-sm-green" data-save-saldo-rek="${editId}">✓</button>
        <button class="btn-sm btn-sm-red"   data-cancel-saldo-rek="${editId}">✗</button>
      </div>`;
    cell.querySelector('.inline-saldo-input').focus();
    return;
  }

  // Simpan inline saldo awal
  const saveId = e.target.dataset.saveSaldoRek;
  if (saveId) {
    const cell  = document.querySelector(`.cell-saldo-awal[data-rek-id="${saveId}"]`);
    const newVal = Number(cell?.querySelector('.inline-saldo-input')?.value) || 0;
    try {
      await updateDoc(doc(db, 'rekening', saveId), { saldoAwal: newVal });
      toast('Saldo awal diperbarui ✓');
    } catch (err) {
      toast('Gagal: ' + err.message, 'error');
    }
    return;
  }

  // Batal edit inline
  const cancelId = e.target.dataset.cancelSaldoRek;
  if (cancelId) {
    renderRekening(); // re-render untuk kembali ke tampilan normal
    return;
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Init default dates
// ═══════════════════════════════════════════════════════════════════════════════
document.getElementById('beli-tgl').value = today();
document.getElementById('kas-tgl').value  = today();
document.getElementById('po-tgl').value   = today();
document.getElementById('mut-tgl').value  = today();
document.getElementById('piu-tgl').value  = today();
