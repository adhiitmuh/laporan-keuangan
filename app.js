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

// Data app — Firestore tetap di project lama
const dataApp = initializeApp(firebaseConfig, 'data');
const db      = getFirestore(dataApp);
const storage = getStorage(dataApp);

// Auth terpusat via harmoni-indonesia
const harmoniConfig = {
  apiKey:            'AIzaSyA9V5Lw40pDeAWeQKijYCkdvnag8AlEe74',
  authDomain:        'harmoni-indonesia.firebaseapp.com',
  projectId:         'harmoni-indonesia',
  storageBucket:     'harmoni-indonesia.firebasestorage.app',
  messagingSenderId: '825719884876',
  appId:             '1:825719884876:web:a8fd78d382e0f98cf6b8e9',
};
const harmoniApp = initializeApp(harmoniConfig, 'harmoni-auth');
const auth       = getAuth(harmoniApp);
const authDb     = getFirestore(harmoniApp);

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
let kategoriData    = [];  // kategori (sistem + custom + pending)
let pengajuanData   = [];  // pengajuan pengeluaran (pending/done/rejected)
let saldoAwalTunai  = 0;   // dari Firestore settings/saldo-awal
let editingSupId    = null; // id supplier yang sedang diedit
let bayarPembelianId   = null; // id pembelian yang sedang dikonfirmasi bayar

// User yang sedang login
let currentUser     = null; // Firebase Auth user object
let currentUserData = null; // Firestore users/{uid} document data
let currentRole     = null; // string: 'developer' | 'pemilik' | 'pengurus' | 'kasir'

// Flag untuk mencegah onAuthStateChanged mengganggu proses setup
let isSettingUp = false;

// Unsubscribe handles untuk onSnapshot
const unsubs = [];

// ═══════════════════════════════════════════════════════════════════════════════
// Utils
// ═══════════════════════════════════════════════════════════════════════════════
const rupiah       = n => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
const today        = () => new Date().toISOString().split('T')[0];
const formatRibuan = n => Number(n || 0).toLocaleString('id-ID');
const parseRibuan  = s => Number(String(s).replace(/\./g, '').replace(/,/g, '')) || 0;
const monthOf = d => (d ? String(d).slice(0, 7) : '');

// Auto-format input angka dengan titik ribuan saat user mengetik
const RIBUAN_IDS = [
  'beli-qty','beli-harga','beli-total','kas-jumlah','ang-target',
  'piu-jumlah','piu-cicilan','bayar-jumlah','mut-jumlah',
  'saldo-awal-tunai','rek-saldo-awal','kas-piu-cicilan',
];
RIBUAN_IDS.forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('input', () => {
    const raw    = el.value.replace(/\./g, '').replace(/[^0-9]/g, '');
    const cursor = el.selectionStart;
    const before = el.value.slice(0, cursor).replace(/\./g, '').replace(/[^0-9]/g, '').length;
    el.value = raw ? Number(raw).toLocaleString('id-ID') : '';
    // Hitung ulang posisi cursor setelah titik ditambahkan
    let pos = 0, count = 0;
    for (let i = 0; i < el.value.length; i++) {
      if (el.value[i] !== '.') count++;
      if (count === before) { pos = i + 1; break; }
    }
    el.setSelectionRange(pos, pos);
  });
});

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
  const roleColor = role === 'pengurus' ? '#7c3aed' : role === 'developer' ? '#15803d' : '#2563eb';
  return `<span style="font-size:11px;color:${roleColor};font-weight:600">👤 ${nama}</span>${role ? `<br><span style="font-size:10px;color:#9ca3af">${role}</span>` : ''}`;
}

// Kategori bawaan sistem — di-seed ke Firestore saat first-run setup.
// Status='approved', isSystem=true (tidak bisa dihapus).
const KATEGORI_SISTEM = [
  { key: 'penjualan',      label: 'Penjualan',          jenis: 'pemasukan',   tipe: 'bisnis' },
  { key: 'bayar-supplier', label: 'Bayar Supplier',     jenis: 'pengeluaran', tipe: 'bisnis' },
  { key: 'piutang',        label: 'Piutang / Pinjaman', jenis: 'pengeluaran', tipe: 'bisnis' },
  { key: 'gaji',           label: 'Gaji Karyawan',      jenis: 'pengeluaran', tipe: 'bisnis' },
  { key: 'operasional',    label: 'Operasional',        jenis: 'pengeluaran', tipe: 'bisnis' },
  { key: 'lainnya',        label: 'Lainnya',            jenis: 'both',        tipe: 'bisnis' },
  { key: 'pribadi',        label: 'Pribadi / Pemilik',  jenis: 'pengeluaran', tipe: 'non-bisnis' },
  { key: 'non-bisnis',     label: 'Non-Bisnis Lainnya', jenis: 'pengeluaran', tipe: 'non-bisnis' },
];

// Fallback label map (kalau kategoriData belum loaded)
const KATEGORI_LABEL_FALLBACK = Object.fromEntries(KATEGORI_SISTEM.map(k => [k.key, k.label]));

// Dynamic helpers — pakai kategoriData (Firestore), fallback ke sistem
function getKategoriLabel(key) {
  const found = kategoriData.find(k => k.key === key && k.status === 'approved');
  return found?.label || KATEGORI_LABEL_FALLBACK[key] || key;
}
function isKategoriNonBisnis(key) {
  const found = kategoriData.find(k => k.key === key);
  if (found) return found.tipe === 'non-bisnis';
  // fallback ke kategori sistem
  return KATEGORI_SISTEM.find(k => k.key === key)?.tipe === 'non-bisnis';
}
function approvedKategori() {
  return kategoriData.filter(k => k.status === 'approved');
}
function pendingKategori() {
  return kategoriData.filter(k => k.status === 'pending');
}

// Seed kategori sistem ke Firestore (idempotent — pakai setDoc by key)
async function seedKategoriSistem() {
  for (const k of KATEGORI_SISTEM) {
    await setDoc(doc(db, 'kategori', k.key), {
      key: k.key, label: k.label, jenis: k.jenis, tipe: k.tipe,
      status: 'approved', isSystem: true,
      createdAt: serverTimestamp(),
    }, { merge: true });
  }
}
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
  developer: ['dashboard', 'pembelian', 'kasir', 'pengajuan', 'supplier', 'po', 'rekening', 'piutang', 'transfer', 'laporan', 'admin'],
  pemilik:   ['dashboard', 'pembelian', 'kasir', 'pengajuan', 'po', 'rekening', 'piutang', 'transfer', 'laporan'],
  pengurus:  ['dashboard', 'pembelian', 'pengajuan', 'supplier', 'po', 'rekening', 'piutang', 'transfer', 'laporan'],
  kasir:     ['kasir', 'pengajuan', 'pembelian'],
};

function applyRoleUI(role) {
  // Nav buttons
  document.querySelectorAll('.nav-btn').forEach(btn => {
    const page = btn.dataset.page;
    const allowed = (ROLE_PAGES[role] || []).includes(page);
    btn.style.display = allowed ? '' : 'none';
  });

  // Hide action forms for pengawas (read-only)
  const isReadOnly = role === 'pemilik';
  ['form-pembelian-wrap', 'form-kasir-wrap', 'form-supplier-wrap', 'form-po-wrap', 'form-anggaran-wrap', 'form-piutang-wrap', 'form-mutasi-wrap'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = isReadOnly ? 'none' : '';
  });

  // Form pengajuan pengeluaran — hanya admin & pengurus (kasir tidak ajukan, hanya konfirmasi)
  const canAjukan = role === 'developer' || role === 'pengurus';
  const formPgj = document.getElementById('form-pengajuan-wrap');
  if (formPgj) formPgj.style.display = canAjukan ? '' : 'none';

  // Tombol konfirmasi pengajuan — hanya admin & kasir
  const canKonfirmasi = role === 'developer' || role === 'kasir';
  document.querySelectorAll('.col-pengajuan-aksi').forEach(el => {
    el.style.display = canKonfirmasi ? '' : 'none';
  });

  // Saldo awal hanya admin & pengurus
  const saldoForms = ['form-saldo-tunai-wrap', 'form-rekening-wrap'];
  const showSaldo  = role === 'developer' || role === 'pengurus';
  saldoForms.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = showSaldo ? '' : 'none';
  });

  // Hide hapus buttons via CSS class on the column header (rendered dynamically too)
  document.querySelectorAll('.col-aksi').forEach(th => {
    th.style.display = isReadOnly ? 'none' : '';
  });

  // Approval UI hanya untuk admin & pengurus
  const canApprove = role === 'developer' || role === 'pengurus';
  document.querySelectorAll('.col-approval').forEach(el => {
    el.style.display = canApprove ? '' : 'none';
  });

  // Tombol "Ajukan Kategori" — hanya admin/pengurus/kasir (bukan pengawas)
  const btnAjukan = document.getElementById('btn-ajukan-kategori');
  if (btnAjukan) btnAjukan.style.display = ['developer', 'pengurus', 'kasir'].includes(role) ? '' : 'none';
}

// Helper: apakah role saat ini boleh approve
function canApprove() {
  return currentRole === 'developer' || currentRole === 'pengurus';
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
  if (page === 'pengajuan') {
    populatePengajuanKategoriSelect();
    const tglEl = document.getElementById('pgj-tgl');
    if (tglEl && !tglEl.value) tglEl.value = today();
    renderPengajuanPending();
    renderPengajuanRiwayat();
  }
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
  return false; // setup sudah dilakukan, auth dikelola portal
}

// ═══════════════════════════════════════════════════════════════════════════════
// SETUP SCREEN (admin pertama)
// ═══════════════════════════════════════════════════════════════════════════════
// Validasi format username
const USERNAME_REGEX = /^[a-z0-9_]{3,20}$/;

// Cek apakah username sudah dipakai (kembalikan dokumen user yang pakai, atau null)
async function findUserByUsername(uname) {
  const snap = await getDocs(query(collection(db, 'users')));
  return snap.docs.find(d => d.data().username === uname)?.data() || null;
}

document.getElementById('btn-setup').addEventListener('click', async () => {
  const nama     = document.getElementById('setup-nama').value.trim();
  const username = document.getElementById('setup-username').value.trim().toLowerCase();
  const email    = document.getElementById('setup-email').value.trim();
  const password = document.getElementById('setup-password').value;
  const errEl    = document.getElementById('setup-error');

  errEl.classList.add('hidden');
  if (!nama || !username || !email || !password) { errEl.textContent = 'Semua field wajib diisi.'; errEl.classList.remove('hidden'); return; }
  if (!USERNAME_REGEX.test(username)) { errEl.textContent = 'Username 3-20 karakter, hanya huruf kecil/angka/underscore.'; errEl.classList.remove('hidden'); return; }
  if (password.length < 6) { errEl.textContent = 'Password minimal 6 karakter.'; errEl.classList.remove('hidden'); return; }

  hideEl('btn-setup');
  showEl('setup-loading');

  try {
    isSettingUp = true;
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await setDoc(doc(db, 'users', cred.user.uid), {
      uid: cred.user.uid, nama, username, email, role: 'developer', active: true,
      createdAt: serverTimestamp(),
    });
    await setDoc(doc(db, 'meta', 'config'), { initialized: true });
    // Seed kategori sistem
    await seedKategoriSistem();
    isSettingUp = false;
    // Trigger manual karena onAuthStateChanged sudah lewat
    currentUser     = cred.user;
    currentUserData = { uid: cred.user.uid, nama, username, email, role: 'developer', active: true };
    currentRole     = 'developer';
    setUserBadge(currentUserData);
    applyRoleUI('developer');
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
  const identifier = document.getElementById('login-email').value.trim();
  const password   = document.getElementById('login-password').value;
  const errEl      = document.getElementById('login-error');
  errEl.classList.add('hidden');

  if (!identifier || !password) { errEl.textContent = 'Username/Email dan password wajib diisi.'; errEl.classList.remove('hidden'); return; }

  hideEl('btn-login');
  showEl('login-loading');

  try {
    let email = identifier;
    // Kalau bukan email (tidak ada '@'), lookup email dari username
    if (!identifier.includes('@')) {
      const uname = identifier.toLowerCase();
      const userDoc = await findUserByUsername(uname);
      if (!userDoc || !userDoc.email) {
        throw { code: 'auth/user-not-found' };
      }
      email = userDoc.email;
    }
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

  // Ambil data user dari harmoni-indonesia (portal terpusat)
  try {
    const userDoc = await getDoc(doc(authDb, 'users', firebaseUser.uid));
    if (!userDoc.exists()) {
      await signOut(auth);
      showScreen('login');
      return;
    }
    const rawData = userDoc.data();

    // Cek aktif
    if (!rawData.aktif) {
      showScreen('login');
      const errEl = document.getElementById('login-error');
      errEl.textContent = 'Akun belum diaktifkan. Hubungi admin.';
      errEl.classList.remove('hidden');
      return;
    }

    // Tentukan role: owner dapat developer, staff baca dari apps.laporan_keuangan
    let mappedRole;
    if (rawData.role === 'owner') {
      mappedRole = 'developer';
    } else {
      const appAccess = rawData.apps?.laporan_keuangan;
      if (!appAccess?.akses) {
        showScreen('login');
        const errEl = document.getElementById('login-error');
        errEl.textContent = 'Akun ini tidak memiliki akses ke Laporan Keuangan.';
        errEl.classList.remove('hidden');
        return;
      }
      mappedRole = appAccess.role || 'kasir';
    }

    const userData = { ...rawData, role: mappedRole, email: firebaseUser.email };

    currentUser     = firebaseUser;
    currentUserData = userData;
    currentRole     = mappedRole;

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
    if (currentRole === 'developer') renderUsers();
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

  // pengajuan pengeluaran (Pengurus → Kasir konfirmasi)
  unsubs.push(onSnapshot(query(collection(db, 'pengajuan_kas'), orderBy('createdAt', 'desc')), snap => {
    pengajuanData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderPengajuanPending();
    renderPengajuanRiwayat();
    updatePendingPengajuanBadge();
  }));

  // kategori (dinamis: sistem + custom + pending)
  unsubs.push(onSnapshot(collection(db, 'kategori'), async snap => {
    kategoriData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    // Auto-seed: kalau kategori sistem belum ada (database lama), seed sekarang (admin only)
    if (currentRole === 'developer' && KATEGORI_SISTEM.some(k => !kategoriData.find(x => x.key === k.key))) {
      try { await seedKategoriSistem(); } catch {}
    }
    populateKategoriSelect();
    renderPendingKategori();
    renderKategoriAktif();
    updatePendingKategoriBadge();
    // Re-render halaman yang bergantung ke label kategori
    renderKasir();
    renderLaporanIfActive();
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
  // Dropdown kasir + pengajuan (pilih rekening transfer)
  ['kas-rekening', 'pgj-rekening'].forEach(selId => {
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
  ['beli-supplier', 'filter-beli-supplier', 'kas-supplier', 'filter-kas-supplier', 'po-supplier', 'filter-po-supplier', 'pgj-supplier'].forEach(selId => {
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
      const { dibayar, diambil } = piutangStats(p.id);
      return a + Math.max(0, Number(p.jumlah || 0) + diambil - dibayar);
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
  const isReadOnly = currentRole === 'pemilik';
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
  const jumlah = parseRibuan(document.getElementById('mut-jumlah').value) || 0;
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
  const qty   = parseRibuan(document.getElementById('beli-qty').value) || 0;
  const harga = parseRibuan(document.getElementById('beli-harga').value) || 0;
  if (qty && harga) {
    document.getElementById('beli-total').value = formatRibuan(qty * harga);
  }
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
    tbody.innerHTML = `<tr><td colspan="12" class="empty-note">Belum ada data pembelian</td></tr>`;
    setEl('tfoot-pembelian-total', rupiah(0));
    return;
  }

  const isReadOnly   = currentRole === 'pemilik';
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

    // Nota (foto / link)
    const notaLinks = [];
    if (p.fotoNota)  notaLinks.push(`<a href="${p.fotoNota}"  target="_blank" class="link-bukti">📷 Foto</a>`);
    if (p.linkNota)  notaLinks.push(`<a href="${p.linkNota}"  target="_blank" class="link-bukti">🔗 Link</a>`);
    const notaHtml = notaLinks.length ? notaLinks.join(' ') : '<span class="text-muted-sm">–</span>';

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
      <td>${p.qty || '–'}</td>
      <td>${p.harga ? rupiah(p.harga) : '–'}</td>
      <td><strong>${rupiah(p.total)}</strong></td>
      <td>${notaHtml}</td>
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
  const tgl   = document.getElementById('beli-tgl').value;
  const supId = document.getElementById('beli-supplier').value;
  const jenis = document.getElementById('beli-jenis').value.trim();
  const total = parseRibuan(document.getElementById('beli-total').value);
  const qty   = parseRibuan(document.getElementById('beli-qty').value) || null;
  const harga = parseRibuan(document.getElementById('beli-harga').value) || null;
  const link  = document.getElementById('beli-link').value.trim();
  const file  = document.getElementById('beli-foto').files[0];

  if (!tgl || !supId || !jenis || !total) { toast('Tanggal, supplier, jenis, dan total wajib diisi', 'error'); return; }
  if (link && !/^https?:\/\/.+/.test(link)) { toast('Link nota harus diawali https:// atau http://', 'error'); return; }

  const btn = document.getElementById('btn-simpan-beli');
  btn.disabled = true; btn.textContent = '⏳ Menyimpan…';

  try {
    let fotoNota = null;
    if (file) {
      toast('Mengupload foto nota…');
      const ref = storageRef(storage, `nota-pembelian/${Date.now()}_${file.name}`);
      await uploadBytes(ref, file);
      fotoNota = await getDownloadURL(ref);
    }

    await addDoc(collection(db, 'pembelian'), {
      tgl, supplierId: supId, jenis, qty, harga, total,
      fotoNota, linkNota: link || null,
      caraBayar: document.getElementById('beli-carabayar').value,
      ket: document.getElementById('beli-ket').value.trim(),
      statusApproval: 'menunggu',
      buktiTransfer: null,
      ...inputByFields(),
      createdAt: serverTimestamp(),
    });
    ['beli-jenis','beli-qty','beli-harga','beli-total','beli-ket','beli-link'].forEach(id => { document.getElementById(id).value = ''; });
    document.getElementById('beli-foto').value    = '';
    document.getElementById('beli-supplier').value = '';
    document.getElementById('beli-tgl').value     = today();
    toast('Pembelian berhasil disimpan, menunggu approval pengurus');
  } catch (e) {
    toast('Gagal menyimpan: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Simpan Pembelian';
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
    document.getElementById('bayar-bukti-link').value          = '';
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
  const tgl        = document.getElementById('bayar-tgl').value;
  const rekeningId = document.getElementById('bayar-rekening').value;
  const file       = document.getElementById('bayar-bukti-file').files[0];
  const linkInput  = document.getElementById('bayar-bukti-link').value.trim();

  if (!tgl)       { toast('Tanggal bayar wajib diisi', 'error'); return; }
  if (!rekeningId){ toast('Pilih sumber dana (rekening / tunai)', 'error'); return; }
  if (linkInput && !/^https?:\/\/.+/.test(linkInput)) {
    toast('Link bukti harus diawali https:// atau http://', 'error'); return;
  }

  const p = pembelian.find(x => x.id === bayarPembelianId);
  if (!p) { closeBayarModal(); return; }

  const btn = document.getElementById('btn-bayar-konfirm');
  btn.disabled = true;
  btn.textContent = '⏳ Menyimpan…';

  try {
    // 1. Upload bukti (jika ada file), atau gunakan link yang diinput
    let buktiUrl = p.buktiTransfer || null;
    if (file) {
      toast('Mengupload bukti…');
      const ref = storageRef(storage, `bukti-transfer/${bayarPembelianId}_${Date.now()}_${file.name}`);
      await uploadBytes(ref, file);
      buktiUrl = await getDownloadURL(ref);
    } else if (linkInput) {
      buktiUrl = linkInput;
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
  document.getElementById('kas-piutang-wrap').style.display =
    this.value === 'piutang' ? '' : 'none';
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
  const isReadOnly = currentRole === 'pemilik';

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
      const isNonBisnis = isKategoriNonBisnis(k.kategori);
      const katLabel    = getKategoriLabel(k.kategori);
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
  const jumlah    = parseRibuan(document.getElementById('kas-jumlah').value);
  const supplierId  = kategori === 'bayar-supplier' ? document.getElementById('kas-supplier').value : null;
  const via         = document.getElementById('kas-via').value;
  const rekeningId  = via === 'transfer' ? document.getElementById('kas-rekening').value : null;

  const piuNama = kategori === 'piutang' ? document.getElementById('kas-piu-nama').value.trim() : '';

  if (!tgl || !jumlah) { toast('Tanggal dan jumlah wajib diisi', 'error'); return; }
  if (kategori === 'bayar-supplier' && !supplierId) { toast('Pilih supplier untuk pembayaran hutang', 'error'); return; }
  if (kategori === 'piutang' && !piuNama) { toast('Nama peminjam wajib diisi', 'error'); return; }
  if (via === 'transfer' && !rekeningId) { toast('Pilih rekening untuk transfer', 'error'); return; }

  try {
    const ket = document.getElementById('kas-ket').value.trim();
    await addDoc(collection(db, 'kasir'), {
      tgl, jenis, kategori, jumlah,
      supplierId:  supplierId  || null,
      via,
      rekeningId:  rekeningId  || null,
      ket,
      ...inputByFields(),
      createdAt: serverTimestamp(),
    });

    // Jika kategori piutang, otomatis buat entri piutang
    if (kategori === 'piutang') {
      const cicilan   = parseRibuan(document.getElementById('kas-piu-cicilan').value) || 0;
      const tglCicilan = document.getElementById('kas-piu-tgl-cicilan').value;
      await addDoc(collection(db, 'piutang'), {
        nama: piuNama, jumlah, tgl,
        cicilan, tglCicilan,
        ket: ket || `Dicatat dari kasir ${tgl}`,
        status: 'aktif',
        ...inputByFields(),
        createdAt: serverTimestamp(),
      });
    }

    ['kas-tgl', 'kas-jumlah', 'kas-ket', 'kas-piu-nama', 'kas-piu-cicilan', 'kas-piu-tgl-cicilan']
      .forEach(id => { document.getElementById(id).value = ''; });
    document.getElementById('kas-supplier').value  = '';
    document.getElementById('kas-rekening').value  = '';
    document.getElementById('kas-supplier-wrap').style.display  = 'none';
    document.getElementById('kas-rekening-wrap').style.display  = 'none';
    document.getElementById('kas-piutang-wrap').style.display   = 'none';
    document.getElementById('kas-via').value       = 'tunai';
    document.getElementById('kas-tgl').value       = today();
    toast(kategori === 'piutang' ? 'Transaksi & piutang berhasil disimpan ✓' : 'Transaksi berhasil disimpan');
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
let laporanMode = 'bulanan';

function setLaporanMode(mode) {
  laporanMode = mode;
  document.getElementById('btn-mode-bulanan').classList.toggle('active', mode === 'bulanan');
  document.getElementById('btn-mode-tahunan').classList.toggle('active', mode === 'tahunan');
  document.getElementById('filter-laporan-bulanan').style.display = mode === 'bulanan' ? 'flex' : 'none';
  document.getElementById('filter-laporan-tahunan').style.display = mode === 'tahunan' ? 'flex' : 'none';
  if (mode === 'tahunan') populateLaporanTahunSelect();
  document.getElementById('laporan-output').innerHTML = '<p class="empty-note">Pilih periode dan klik "Tampilkan Laporan"</p>';
}

function populateLaporanTahunSelect() {
  const sel = document.getElementById('filter-laporan-tahun');
  const currentYear = new Date().getFullYear();
  const years = new Set([String(currentYear)]);
  kasirData.forEach(k => { if (k.tgl) years.add(String(k.tgl).slice(0, 4)); });
  pembelian.forEach(p => { if (p.tgl) years.add(String(p.tgl).slice(0, 4)); });
  const sorted = [...years].sort((a, b) => b.localeCompare(a));
  const prev = sel.value;
  sel.innerHTML = sorted.map(y => `<option value="${y}">${y}</option>`).join('');
  if (prev && sorted.includes(prev)) sel.value = prev;
}

function renderLaporan() {
  const output = document.getElementById('laporan-output');
  if (laporanMode === 'tahunan') { renderLaporanTahunan(output); return; }

  const bulan  = document.getElementById('filter-laporan-bulan').value;
  if (!bulan) { output.innerHTML = '<p class="empty-note">Pilih bulan dan klik "Tampilkan Laporan"</p>'; return; }

  const beliBulan  = pembelian.filter(p => monthOf(p.tgl) === bulan);
  const kasirBulan = kasirData.filter(k => monthOf(k.tgl) === bulan);

  const totalBeli     = beliBulan.reduce((a, p) => a + Number(p.total || 0), 0);
  const totalMasuk    = kasirBulan.filter(k => k.jenis === 'pemasukan').reduce((a, k) => a + Number(k.jumlah || 0), 0);
  const keluarSemua   = kasirBulan.filter(k => k.jenis === 'pengeluaran');
  const keluarBisnis  = keluarSemua.filter(k => !isKategoriNonBisnis(k.kategori));
  const keluarNonBisnis = keluarSemua.filter(k => isKategoriNonBisnis(k.kategori));
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
      html += `<div class="laporan-row" style="padding-left:16px"><span>${getKategoriLabel(kat)}</span><span class="text-green">${rupiah(val)}</span></div>`;
    });
  } else {
    html += `<div class="laporan-row" style="padding-left:16px"><span>Tidak ada pemasukan</span><span>Rp 0</span></div>`;
  }
  html += `<div class="laporan-row"><span><em>Total Pemasukan</em></span><span class="text-green"><strong>${rupiah(totalMasuk)}</strong></span></div>`;
  html += `<div class="laporan-row"><span><strong>Pengeluaran Bisnis</strong></span></div>`;
  if (Object.keys(keluarBisnisKat).length) {
    Object.entries(keluarBisnisKat).forEach(([kat, val]) => {
      html += `<div class="laporan-row" style="padding-left:16px"><span>${getKategoriLabel(kat)}</span><span class="text-red">${rupiah(val)}</span></div>`;
    });
  } else {
    html += `<div class="laporan-row" style="padding-left:16px"><span>Tidak ada pengeluaran bisnis</span><span>Rp 0</span></div>`;
  }
  html += `<div class="laporan-row"><span><em>Total Pengeluaran Bisnis</em></span><span class="text-red"><strong>${rupiah(totalKeluarBisnis)}</strong></span></div>`;
  html += `<div class="laporan-row" style="margin-top:8px"><span><strong>Pengeluaran Non-Bisnis</strong></span></div>`;
  if (Object.keys(keluarNonBisnisKat).length) {
    Object.entries(keluarNonBisnisKat).forEach(([kat, val]) => {
      html += `<div class="laporan-row" style="padding-left:16px;background:#fffbeb"><span>👤 ${getKategoriLabel(kat)}</span><span class="text-amber">${rupiah(val)}</span></div>`;
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

  // 5. Piutang
  const piutangBulan     = piutangData.filter(p => monthOf(p.tgl) === bulan);
  const bayarPiuBulan    = piutangBayar.filter(b => b.type !== 'ambil' && monthOf(b.tgl) === bulan);
  const totalPiuBaru     = piutangBulan.reduce((a, p) => a + Number(p.jumlah || 0), 0);
  const totalBayarPiu    = bayarPiuBulan.reduce((a, b) => a + Number(b.jumlah || 0), 0);
  const piutangAktif     = piutangData.filter(p => {
    const { dibayar, diambil } = piutangStats(p.id);
    return dibayar < (Number(p.jumlah || 0) + diambil);
  });
  const totalPiuAktif    = piutangAktif.reduce((a, p) => {
    const { dibayar, diambil } = piutangStats(p.id);
    return a + Math.max(0, Number(p.jumlah || 0) + diambil - dibayar);
  }, 0);
  html += `<div class="laporan-section"><h3>5. Piutang (s/d ${namaBulan})</h3>`;
  html += `<div class="laporan-row"><span>Piutang baru bulan ini</span><span>${rupiah(totalPiuBaru)}</span></div>`;
  html += `<div class="laporan-row"><span>Pembayaran diterima bulan ini</span><span class="text-green">${rupiah(totalBayarPiu)}</span></div>`;
  if (piutangAktif.length) {
    html += `<div class="laporan-row" style="margin-top:4px"><span><strong>Piutang Masih Aktif</strong></span></div>`;
    piutangAktif.forEach(p => {
      const { dibayar, diambil } = piutangStats(p.id);
      const sisa = Math.max(0, Number(p.jumlah || 0) + diambil - dibayar);
      html += `<div class="laporan-row" style="padding-left:16px"><span>${p.nama}</span><span class="text-red">${rupiah(sisa)}</span></div>`;
    });
  }
  html += `<div class="laporan-total"><span>Total Piutang Belum Lunas</span><span class="text-red">${rupiah(totalPiuAktif)}</span></div>`;
  html += `</div>`;

  output.innerHTML = html;
}

function renderLaporanTahunan(output) {
  const tahun = document.getElementById('filter-laporan-tahun').value;
  if (!tahun) { output.innerHTML = '<p class="empty-note">Pilih tahun dan klik "Tampilkan Laporan"</p>'; return; }

  const beliTahun  = pembelian.filter(p => String(p.tgl || '').startsWith(tahun + '-'));
  const kasirTahun = kasirData.filter(k => String(k.tgl || '').startsWith(tahun + '-'));

  const totalBeli            = beliTahun.reduce((a, p) => a + Number(p.total || 0), 0);
  const totalMasuk           = kasirTahun.filter(k => k.jenis === 'pemasukan').reduce((a, k) => a + Number(k.jumlah || 0), 0);
  const keluarSemua          = kasirTahun.filter(k => k.jenis === 'pengeluaran');
  const keluarBisnis         = keluarSemua.filter(k => !isKategoriNonBisnis(k.kategori));
  const keluarNonBisnis      = keluarSemua.filter(k => isKategoriNonBisnis(k.kategori));
  const totalKeluar          = keluarSemua.reduce((a, k) => a + Number(k.jumlah || 0), 0);
  const totalKeluarBisnis    = keluarBisnis.reduce((a, k) => a + Number(k.jumlah || 0), 0);
  const totalKeluarNonBisnis = keluarNonBisnis.reduce((a, k) => a + Number(k.jumlah || 0), 0);
  const saldoBersih          = totalMasuk - totalKeluar;

  const keluarBisnisKat = {};
  keluarBisnis.forEach(k => { keluarBisnisKat[k.kategori] = (keluarBisnisKat[k.kategori] || 0) + Number(k.jumlah || 0); });
  const keluarNonBisnisKat = {};
  keluarNonBisnis.forEach(k => { keluarNonBisnisKat[k.kategori] = (keluarNonBisnisKat[k.kategori] || 0) + Number(k.jumlah || 0); });

  const MONTHS     = ['01','02','03','04','05','06','07','08','09','10','11','12'];
  const MONTH_NAMES = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];

  const monthlyData = MONTHS.map((m, i) => {
    const key    = `${tahun}-${m}`;
    const kasirM = kasirTahun.filter(k => monthOf(k.tgl) === key);
    const masuk  = kasirM.filter(k => k.jenis === 'pemasukan').reduce((a, k) => a + Number(k.jumlah || 0), 0);
    const keluarB  = kasirM.filter(k => k.jenis === 'pengeluaran' && !isKategoriNonBisnis(k.kategori)).reduce((a, k) => a + Number(k.jumlah || 0), 0);
    const keluarNB = kasirM.filter(k => k.jenis === 'pengeluaran' && isKategoriNonBisnis(k.kategori)).reduce((a, k) => a + Number(k.jumlah || 0), 0);
    const beli   = beliTahun.filter(p => monthOf(p.tgl) === key).reduce((a, p) => a + Number(p.total || 0), 0);
    return { name: MONTH_NAMES[i], masuk, keluarB, keluarNB, keluar: keluarB + keluarNB, beli, saldo: masuk - (keluarB + keluarNB) };
  });

  const endOfYear    = `${tahun}-12`;
  const allBeliUntil  = pembelian.filter(p => monthOf(p.tgl) <= endOfYear);
  const allBayarUntil = kasirData.filter(k => k.kategori === 'bayar-supplier' && monthOf(k.tgl) <= endOfYear);
  const hutangRows = suppliers.map(s => {
    const beli  = allBeliUntil.filter(p => p.supplierId === s.id).reduce((a, p) => a + Number(p.total || 0), 0);
    const bayar = allBayarUntil.filter(k => k.supplierId === s.id).reduce((a, k) => a + Number(k.jumlah || 0), 0);
    return { nama: s.nama, asal: s.asal, beli, bayar, hutang: Math.max(0, beli - bayar) };
  });

  let html = `<h2 style="margin-bottom:20px;font-size:17px;font-weight:700">Laporan Keuangan Tahunan — ${tahun}</h2>`;

  // 1. Ringkasan Tahunan
  html += `<div class="laporan-section"><h3>1. Ringkasan Tahunan ${tahun}</h3>`;
  html += `<div class="laporan-row"><span>Total Pemasukan</span><span class="text-green"><strong>${rupiah(totalMasuk)}</strong></span></div>`;
  html += `<div class="laporan-row"><span>Total Pengeluaran Bisnis</span><span class="text-red"><strong>${rupiah(totalKeluarBisnis)}</strong></span></div>`;
  html += `<div class="laporan-row"><span>Total Pengeluaran Non-Bisnis</span><span class="text-amber"><strong>${rupiah(totalKeluarNonBisnis)}</strong></span></div>`;
  html += `<div class="laporan-row"><span>Total Pembelian Barang</span><span><strong>${rupiah(totalBeli)}</strong></span></div>`;
  html += `<div class="laporan-total"><span>Saldo Bersih</span><span class="${saldoBersih >= 0 ? 'text-green' : 'text-red'}">${rupiah(saldoBersih)}</span></div>`;
  html += `</div>`;

  // 2. Total Pengeluaran per Kategori
  html += `<div class="laporan-section"><h3>2. Total Pengeluaran per Kategori</h3>`;
  html += `<div class="laporan-row"><span><strong>Pengeluaran Bisnis</strong></span></div>`;
  if (Object.keys(keluarBisnisKat).length) {
    Object.entries(keluarBisnisKat).sort((a, b) => b[1] - a[1]).forEach(([kat, val]) => {
      const pct = totalKeluarBisnis > 0 ? ((val / totalKeluarBisnis) * 100).toFixed(1) : '0.0';
      html += `<div class="laporan-row" style="padding-left:16px"><span>${getKategoriLabel(kat)}</span><span class="text-red">${rupiah(val)} <small style="color:#9ca3af">(${pct}%)</small></span></div>`;
    });
  } else {
    html += `<div class="laporan-row" style="padding-left:16px"><span>Tidak ada pengeluaran bisnis</span><span>Rp 0</span></div>`;
  }
  html += `<div class="laporan-row"><span><em>Total Bisnis</em></span><span class="text-red"><strong>${rupiah(totalKeluarBisnis)}</strong></span></div>`;
  if (Object.keys(keluarNonBisnisKat).length) {
    html += `<div class="laporan-row" style="margin-top:8px"><span><strong>Pengeluaran Non-Bisnis</strong></span></div>`;
    Object.entries(keluarNonBisnisKat).sort((a, b) => b[1] - a[1]).forEach(([kat, val]) => {
      html += `<div class="laporan-row" style="padding-left:16px;background:#fffbeb"><span>👤 ${getKategoriLabel(kat)}</span><span class="text-amber">${rupiah(val)}</span></div>`;
    });
    html += `<div class="laporan-row"><span><em>Total Non-Bisnis</em></span><span class="text-amber"><strong>${rupiah(totalKeluarNonBisnis)}</strong></span></div>`;
  }
  html += `</div>`;

  // 3. Rekap per Bulan
  html += `<div class="laporan-section"><h3>3. Rekap per Bulan</h3>`;
  html += `<div style="overflow-x:auto"><table class="tbl" style="width:100%;font-size:13px"><thead><tr>
    <th>Bulan</th><th>Pemasukan</th><th>Keluar Bisnis</th><th>Keluar Non-Bisnis</th><th>Pembelian</th><th>Saldo</th>
  </tr></thead><tbody>`;
  let hasAny = false;
  monthlyData.forEach(md => {
    if (md.masuk === 0 && md.keluar === 0 && md.beli === 0) return;
    hasAny = true;
    html += `<tr>
      <td>${md.name}</td>
      <td class="text-green">${rupiah(md.masuk)}</td>
      <td class="text-red">${rupiah(md.keluarB)}</td>
      <td class="text-amber">${rupiah(md.keluarNB)}</td>
      <td>${rupiah(md.beli)}</td>
      <td class="${md.saldo >= 0 ? 'text-green' : 'text-red'}"><strong>${rupiah(md.saldo)}</strong></td>
    </tr>`;
  });
  if (!hasAny) {
    html += `<tr><td colspan="6" style="text-align:center;color:#9ca3af">Tidak ada data di tahun ${tahun}</td></tr>`;
  }
  html += `<tr style="font-weight:700;border-top:2px solid #d1d5db">
    <td>TOTAL</td>
    <td class="text-green">${rupiah(totalMasuk)}</td>
    <td class="text-red">${rupiah(totalKeluarBisnis)}</td>
    <td class="text-amber">${rupiah(totalKeluarNonBisnis)}</td>
    <td>${rupiah(totalBeli)}</td>
    <td class="${saldoBersih >= 0 ? 'text-green' : 'text-red'}">${rupiah(saldoBersih)}</td>
  </tr></tbody></table></div></div>`;

  // 4. Posisi Hutang Supplier
  html += `<div class="laporan-section"><h3>4. Posisi Hutang Supplier (s/d Akhir ${tahun})</h3>`;
  if (hutangRows.length) {
    hutangRows.forEach(r => {
      html += `<div class="laporan-row"><span>${r.nama} (${r.asal})</span>
        <span>Beli: ${rupiah(r.beli)} | Bayar: ${rupiah(r.bayar)} | <strong class="${r.hutang > 0 ? 'text-red' : 'text-green'}">Hutang: ${rupiah(r.hutang)}</strong></span></div>`;
    });
    const totalHutang = hutangRows.reduce((a, r) => a + r.hutang, 0);
    html += `<div class="laporan-total"><span>Total Hutang</span><span class="${totalHutang > 0 ? 'text-red' : 'text-green'}">${rupiah(totalHutang)}</span></div>`;
  } else {
    html += `<div class="laporan-row"><span>Belum ada supplier</span><span>-</span></div>`;
  }
  html += `</div>`;

  // 5. Piutang Tahunan
  const piutangTahun  = piutangData.filter(p => String(p.tgl || '').startsWith(tahun + '-'));
  const totalPiuBaru  = piutangTahun.reduce((a, p) => a + Number(p.jumlah || 0), 0);
  const bayarPiuTahun = piutangBayar.filter(b => b.type !== 'ambil' && String(b.tgl || '').startsWith(tahun + '-'));
  const totalBayarPiu = bayarPiuTahun.reduce((a, b) => a + Number(b.jumlah || 0), 0);
  const piutangAktif  = piutangData.filter(p => {
    const { dibayar, diambil } = piutangStats(p.id);
    return dibayar < (Number(p.jumlah || 0) + diambil);
  });
  const totalPiuAktif = piutangAktif.reduce((a, p) => {
    const { dibayar, diambil } = piutangStats(p.id);
    return a + Math.max(0, Number(p.jumlah || 0) + diambil - dibayar);
  }, 0);
  html += `<div class="laporan-section"><h3>5. Piutang Tahun ${tahun}</h3>`;
  html += `<div class="laporan-row"><span>Piutang baru tahun ini</span><span>${rupiah(totalPiuBaru)}</span></div>`;
  html += `<div class="laporan-row"><span>Pembayaran diterima tahun ini</span><span class="text-green">${rupiah(totalBayarPiu)}</span></div>`;
  if (piutangAktif.length) {
    html += `<div class="laporan-row" style="margin-top:4px"><span><strong>Piutang Masih Aktif (semua)</strong></span></div>`;
    piutangAktif.forEach(p => {
      const { dibayar, diambil } = piutangStats(p.id);
      const sisa = Math.max(0, Number(p.jumlah || 0) + diambil - dibayar);
      html += `<div class="laporan-row" style="padding-left:16px"><span>${p.nama}</span><span class="text-red">${rupiah(sisa)}</span></div>`;
    });
  }
  html += `<div class="laporan-total"><span>Total Piutang Belum Lunas</span><span class="text-red">${rupiah(totalPiuAktif)}</span></div>`;
  html += `</div>`;

  output.innerHTML = html;
}

document.getElementById('btn-generate-laporan').addEventListener('click', renderLaporan);
document.getElementById('btn-mode-bulanan').addEventListener('click', () => setLaporanMode('bulanan'));
document.getElementById('btn-mode-tahunan').addEventListener('click', () => setLaporanMode('tahunan'));

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN — manajemen user
// ═══════════════════════════════════════════════════════════════════════════════
function renderUsers() {
  const tbody = document.getElementById('tbody-users');
  if (!tbody) return;
  if (!users.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-note">Belum ada data pengguna</td></tr>`;
    return;
  }
  tbody.innerHTML = '';
  users.forEach(u => {
    const isMe  = u.uid === currentUser?.uid;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${u.nama || '-'}</strong></td>
      <td>${u.username
        ? `<code style="background:var(--brand-light);color:var(--brand);padding:2px 8px;border-radius:4px;font-size:12px">${u.username}</code>`
        : '<span class="text-muted-sm">–</span>'}</td>
      <td>${u.email}</td>
      <td><span class="role-badge role-${u.role}">${u.role}</span></td>
      <td>${u.active !== false
        ? '<span class="badge badge-aktif">Aktif</span>'
        : '<span class="badge badge-nonaktif">Nonaktif</span>'
      }</td>
      <td>
        <button class="btn-sm btn-sm-blue" data-edit-user="${u.id}" style="margin-right:4px">Edit</button>
        ${isMe ? '<em style="color:var(--text-muted);font-size:12px">(Anda)</em>' : `
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
  if (currentRole !== 'developer') { toast('Hanya Admin yang bisa membuat user', 'error'); return; }
  const nama     = document.getElementById('usr-nama').value.trim();
  const username = document.getElementById('usr-username').value.trim().toLowerCase();
  const email    = document.getElementById('usr-email').value.trim();
  const password = document.getElementById('usr-password').value;
  const role     = document.getElementById('usr-role').value;

  if (!nama || !username || !email || !password) { toast('Semua field wajib diisi', 'error'); return; }
  if (!USERNAME_REGEX.test(username)) { toast('Username 3-20 karakter, huruf kecil/angka/underscore', 'error'); return; }
  if (password.length < 6) { toast('Password minimal 6 karakter', 'error'); return; }

  // Cek username unique
  if (users.some(u => u.username === username)) { toast(`Username "${username}" sudah dipakai`, 'error'); return; }

  try {
    // Gunakan secondary app agar admin tidak ter-logout
    const secAuth = getSecondaryAuth();
    const cred    = await createUserWithEmailAndPassword(secAuth, email, password);
    await setDoc(doc(db, 'users', cred.user.uid), {
      uid: cred.user.uid, nama, username, email, role, active: true,
      createdAt: serverTimestamp(),
    });
    // Logout dari secondary app (supaya bersih)
    await signOut(secAuth);

    ['usr-nama', 'usr-username', 'usr-email', 'usr-password'].forEach(id => { document.getElementById(id).value = ''; });
    toast(`Pengguna ${nama} berhasil dibuat`);
  } catch (e) {
    toast('Gagal membuat user: ' + friendlyError(e.code), 'error');
  }
});

document.getElementById('tbody-users').addEventListener('click', async e => {
  // Tombol Edit
  const editId = e.target.dataset.editUser;
  if (editId) {
    if (currentRole !== 'developer') { toast('Hanya Admin yang bisa edit user', 'error'); return; }
    const u = users.find(x => x.id === editId);
    if (!u) return;
    document.getElementById('edit-user-id').value       = u.id;
    document.getElementById('edit-user-nama').value     = u.nama || '';
    document.getElementById('edit-user-username').value = u.username || '';
    document.getElementById('edit-user-email').value    = u.email || '';
    document.getElementById('edit-user-role').value     = u.role || 'kasir';
    document.getElementById('edit-user-error').classList.add('hidden');
    // Cegah ubah role diri sendiri
    const isMe = u.uid === currentUser?.uid;
    document.getElementById('edit-user-role').disabled = isMe;
    document.getElementById('edit-user-role-hint').style.display = isMe ? '' : 'none';
    document.getElementById('modal-edit-user').classList.remove('hidden');
    return;
  }

  // Tombol Toggle aktif
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
// MODAL EDIT USER
// ═══════════════════════════════════════════════════════════════════════════════
['btn-edit-user-close', 'btn-edit-user-cancel'].forEach(id => {
  document.getElementById(id)?.addEventListener('click', () => {
    document.getElementById('modal-edit-user').classList.add('hidden');
  });
});

document.getElementById('btn-edit-user-save')?.addEventListener('click', async () => {
  if (currentRole !== 'developer') { toast('Hanya Admin', 'error'); return; }
  const id       = document.getElementById('edit-user-id').value;
  const nama     = document.getElementById('edit-user-nama').value.trim();
  const username = document.getElementById('edit-user-username').value.trim().toLowerCase();
  const role     = document.getElementById('edit-user-role').value;
  const errEl    = document.getElementById('edit-user-error');
  errEl.classList.add('hidden');

  const u = users.find(x => x.id === id);
  if (!u) { errEl.textContent = 'User tidak ditemukan.'; errEl.classList.remove('hidden'); return; }
  if (!nama) { errEl.textContent = 'Nama wajib diisi.'; errEl.classList.remove('hidden'); return; }
  if (username && !USERNAME_REGEX.test(username)) { errEl.textContent = 'Username 3-20 karakter, huruf kecil/angka/underscore.'; errEl.classList.remove('hidden'); return; }
  // Cek username unique (kecuali milik user ini sendiri)
  if (username && users.some(x => x.id !== id && x.username === username)) {
    errEl.textContent = `Username "${username}" sudah dipakai user lain.`; errEl.classList.remove('hidden'); return;
  }

  // Cegah ubah role diri sendiri
  const isMe = u.uid === currentUser?.uid;
  const newRole = isMe ? u.role : role;

  try {
    const patch = { nama, username: username || null, role: newRole };
    await updateDoc(doc(db, 'users', id), patch);
    document.getElementById('modal-edit-user').classList.add('hidden');
    toast(`Data pengguna ${nama} diperbarui`);
    // Kalau yang diedit diri sendiri, update tampilan badge
    if (isMe) {
      currentUserData = { ...currentUserData, ...patch };
      setUserBadge(currentUserData);
    }
  } catch (e) {
    errEl.textContent = 'Gagal: ' + (e.message || e.code);
    errEl.classList.remove('hidden');
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// KATEGORI — populate select kas, ajukan, approve, render daftar
// ═══════════════════════════════════════════════════════════════════════════════

// Populate dropdown kas-kategori dengan kategori approved sesuai jenis
function populateKategoriSelect() {
  const sel = document.getElementById('kas-kategori');
  if (!sel) return;
  const currentJenis = document.getElementById('kas-jenis')?.value || 'pemasukan';
  const list = approvedKategori().filter(k => k.jenis === currentJenis || k.jenis === 'both');

  // Group: bisnis dulu, lalu non-bisnis
  const bisnis    = list.filter(k => k.tipe !== 'non-bisnis');
  const nonBisnis = list.filter(k => k.tipe === 'non-bisnis');

  const prevValue = sel.value;
  sel.innerHTML = '';
  if (bisnis.length) {
    const og = document.createElement('optgroup');
    og.label = '── Bisnis ──';
    bisnis.forEach(k => {
      const o = document.createElement('option');
      o.value = k.key; o.textContent = k.label;
      og.appendChild(o);
    });
    sel.appendChild(og);
  }
  if (nonBisnis.length) {
    const og = document.createElement('optgroup');
    og.label = '── Non-Bisnis ──';
    nonBisnis.forEach(k => {
      const o = document.createElement('option');
      o.value = k.key; o.textContent = '👤 ' + k.label;
      og.appendChild(o);
    });
    sel.appendChild(og);
  }
  // Restore previous value kalau masih ada
  if (prevValue && list.some(k => k.key === prevValue)) sel.value = prevValue;
  // Trigger supplier-wrap toggle
  document.getElementById('kas-supplier-wrap').style.display =
    sel.value === 'bayar-supplier' ? '' : 'none';
}

// Helper: re-render laporan kalau halaman laporan sedang aktif
function renderLaporanIfActive() {
  if (document.getElementById('page-laporan')?.classList.contains('active')) {
    try { renderLaporan(); } catch {}
  }
}

// ── Tombol "Ajukan Kategori Baru" ──
document.getElementById('btn-ajukan-kategori')?.addEventListener('click', () => {
  if (!['developer', 'pengurus', 'kasir'].includes(currentRole)) return;
  ['kat-label', 'kat-ket'].forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('kat-jenis').value = 'pengeluaran';
  document.getElementById('kat-tipe').value  = 'bisnis';
  document.getElementById('kat-error').classList.add('hidden');
  document.getElementById('modal-kategori').classList.remove('hidden');
});

['btn-kat-close', 'btn-kat-cancel'].forEach(id => {
  document.getElementById(id)?.addEventListener('click', () => {
    document.getElementById('modal-kategori').classList.add('hidden');
  });
});

document.getElementById('btn-kat-submit')?.addEventListener('click', async () => {
  const label = document.getElementById('kat-label').value.trim();
  const jenis = document.getElementById('kat-jenis').value;
  const tipe  = document.getElementById('kat-tipe').value;
  const ket   = document.getElementById('kat-ket').value.trim();
  const errEl = document.getElementById('kat-error');
  errEl.classList.add('hidden');

  if (!label) { errEl.textContent = 'Nama kategori wajib diisi.'; errEl.classList.remove('hidden'); return; }

  // Generate key dari label (lowercase, alphanumeric+dash)
  const key = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  if (!key) { errEl.textContent = 'Nama kategori tidak valid.'; errEl.classList.remove('hidden'); return; }
  if (kategoriData.some(k => k.key === key)) { errEl.textContent = 'Kategori dengan nama serupa sudah ada.'; errEl.classList.remove('hidden'); return; }

  // Admin auto-approve, lainnya pending
  const status = currentRole === 'developer' ? 'approved' : 'pending';

  try {
    await setDoc(doc(db, 'kategori', key), {
      key, label, jenis, tipe, ket,
      status,
      isSystem: false,
      pengajuId:   currentUser?.uid || '',
      pengajuNama: currentUserData?.nama || '',
      pengajuRole: currentRole || '',
      createdAt: serverTimestamp(),
    });
    document.getElementById('modal-kategori').classList.add('hidden');
    toast(status === 'approved'
      ? `Kategori "${label}" berhasil dibuat`
      : `Pengajuan "${label}" terkirim, menunggu approval Admin`);
  } catch (e) {
    errEl.textContent = 'Gagal menyimpan: ' + (e.message || e.code);
    errEl.classList.remove('hidden');
  }
});

// ── Render tabel pending kategori (Admin) ──
function renderPendingKategori() {
  const tbody = document.getElementById('tbody-pending-kategori');
  if (!tbody) return;
  const list = pendingKategori();
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-note">Tidak ada pengajuan</td></tr>`;
    return;
  }
  tbody.innerHTML = '';
  list.forEach(k => {
    const tgl = k.createdAt?.toDate ? k.createdAt.toDate().toLocaleDateString('id-ID') : '–';
    const jenisLabel = k.jenis === 'pemasukan' ? 'Pemasukan' : k.jenis === 'pengeluaran' ? 'Pengeluaran' : 'Keduanya';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${tgl}</td>
      <td><strong>${k.label}</strong>${k.tipe === 'non-bisnis' ? ' <span class="badge badge-non-bisnis">Non-Bisnis</span>' : ''}</td>
      <td>${jenisLabel}</td>
      <td><span style="font-size:12px;font-weight:600">${k.pengajuNama || '–'}</span><br><span style="font-size:10px;color:#9ca3af">${k.pengajuRole || ''}</span></td>
      <td>${k.ket || '<span class="text-muted-sm">–</span>'}</td>
      <td>
        <button class="btn-sm btn-sm-green" data-approve-kat="${k.key}">Approve</button>
        <button class="btn-sm btn-sm-red" data-reject-kat="${k.key}">Tolak</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

// ── Render tabel kategori aktif (Admin) ──
function renderKategoriAktif() {
  const tbody = document.getElementById('tbody-kategori-aktif');
  if (!tbody) return;
  const list = approvedKategori();
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-note">Belum ada kategori aktif</td></tr>`;
    return;
  }
  tbody.innerHTML = '';
  list.forEach(k => {
    const jenisLabel = k.jenis === 'pemasukan' ? 'Pemasukan' : k.jenis === 'pengeluaran' ? 'Pengeluaran' : 'Keduanya';
    const tipeBadge = k.tipe === 'non-bisnis'
      ? '<span class="badge badge-non-bisnis">Non-Bisnis</span>'
      : '<span class="badge badge-lunas">Bisnis</span>';
    const sumber = k.isSystem ? '<span class="text-muted-sm">🔒 Sistem</span>' : `<span style="font-size:12px">👤 ${k.pengajuNama || '–'}</span>`;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${k.label}</strong></td>
      <td>${jenisLabel}</td>
      <td>${tipeBadge}</td>
      <td>${sumber}</td>
      <td>${k.isSystem
        ? '<em style="color:var(--text-muted);font-size:12px">Terkunci</em>'
        : `<button class="btn-sm btn-sm-red" data-del-kat="${k.key}">Hapus</button>`}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ── Handler Approve / Tolak / Hapus kategori ──
document.getElementById('tbody-pending-kategori')?.addEventListener('click', async e => {
  const approveKey = e.target.dataset.approveKat;
  const rejectKey  = e.target.dataset.rejectKat;
  if (!approveKey && !rejectKey) return;
  if (currentRole !== 'developer') { toast('Hanya Admin yang bisa approval', 'error'); return; }
  const key = approveKey || rejectKey;
  const k = kategoriData.find(x => x.key === key);
  if (!k) return;
  try {
    if (approveKey) {
      await updateDoc(doc(db, 'kategori', key), {
        status: 'approved',
        approverId:   currentUser.uid,
        approverNama: currentUserData?.nama || '',
        approvedAt:   serverTimestamp(),
      });
      toast(`Kategori "${k.label}" disetujui`);
    } else {
      // Tolak → hapus saja agar key bisa diajukan ulang
      await deleteDoc(doc(db, 'kategori', key));
      toast(`Pengajuan "${k.label}" ditolak`);
    }
  } catch (err) {
    toast('Gagal: ' + err.message, 'error');
  }
});

document.getElementById('tbody-kategori-aktif')?.addEventListener('click', async e => {
  const key = e.target.dataset.delKat;
  if (!key) return;
  if (currentRole !== 'developer') return;
  const k = kategoriData.find(x => x.key === key);
  if (!k || k.isSystem) { toast('Kategori sistem tidak bisa dihapus', 'error'); return; }
  // Cek apakah kategori dipakai
  const dipakai = kasirData.some(r => r.kategori === key);
  if (dipakai) {
    toast('Kategori sedang dipakai transaksi, tidak bisa dihapus', 'error');
    return;
  }
  confirmDelete(`Hapus kategori <strong>${k.label}</strong>?`, async () => {
    try {
      await deleteDoc(doc(db, 'kategori', key));
      toast('Kategori dihapus');
    } catch (err) {
      toast('Gagal: ' + err.message, 'error');
    }
  }, 'Hapus');
});

// Update badge pending kategori di nav Admin
function updatePendingKategoriBadge() {
  const count = pendingKategori().length;
  const badge = document.getElementById('badge-pending-kategori');
  if (badge) {
    if (count > 0) {
      badge.textContent = count;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }
  // Nav button badge
  const navAdmin = document.querySelector('.nav-btn[data-page="admin"]');
  if (navAdmin) {
    const original = navAdmin.dataset.originalText || navAdmin.textContent.replace(/\s*\(\d+\)\s*$/, '').trim();
    navAdmin.dataset.originalText = original;
    navAdmin.textContent = count > 0 ? `${original} (${count})` : original;
  }
}

// Re-populate dropdown kas-kategori ketika jenis berubah
document.getElementById('kas-jenis')?.addEventListener('change', populateKategoriSelect);

// ═══════════════════════════════════════════════════════════════════════════════
// PENGAJUAN PENGELUARAN — Pengurus ajukan → Kasir konfirmasi → masuk kas
// ═══════════════════════════════════════════════════════════════════════════════

// Populate dropdown kategori di form pengajuan (hanya pengeluaran)
function populatePengajuanKategoriSelect() {
  const sel = document.getElementById('pgj-kategori');
  if (!sel) return;
  const list = approvedKategori().filter(k => k.jenis === 'pengeluaran' || k.jenis === 'both');
  const bisnis    = list.filter(k => k.tipe !== 'non-bisnis');
  const nonBisnis = list.filter(k => k.tipe === 'non-bisnis');

  const prev = sel.value;
  sel.innerHTML = '';
  if (bisnis.length) {
    const og = document.createElement('optgroup');
    og.label = '── Bisnis ──';
    bisnis.forEach(k => {
      const o = document.createElement('option');
      o.value = k.key; o.textContent = k.label;
      og.appendChild(o);
    });
    sel.appendChild(og);
  }
  if (nonBisnis.length) {
    const og = document.createElement('optgroup');
    og.label = '── Non-Bisnis ──';
    nonBisnis.forEach(k => {
      const o = document.createElement('option');
      o.value = k.key; o.textContent = '👤 ' + k.label;
      og.appendChild(o);
    });
    sel.appendChild(og);
  }
  if (prev && list.some(k => k.key === prev)) sel.value = prev;
  togglePgjSupplierWrap();
}

function togglePgjSupplierWrap() {
  const sel = document.getElementById('pgj-kategori');
  const wrap = document.getElementById('pgj-supplier-wrap');
  if (sel && wrap) wrap.style.display = sel.value === 'bayar-supplier' ? '' : 'none';
}

document.getElementById('pgj-kategori')?.addEventListener('change', togglePgjSupplierWrap);
document.getElementById('pgj-via')?.addEventListener('change', function () {
  document.getElementById('pgj-rekening-wrap').style.display =
    this.value === 'transfer' ? '' : 'none';
});

// Submit pengajuan
document.getElementById('btn-simpan-pengajuan')?.addEventListener('click', async () => {
  if (!['developer', 'pengurus'].includes(currentRole)) { toast('Tidak ada akses', 'error'); return; }
  const tgl       = document.getElementById('pgj-tgl').value;
  const kategori  = document.getElementById('pgj-kategori').value;
  const jumlah    = Number(document.getElementById('pgj-jumlah').value);
  const supplierId  = kategori === 'bayar-supplier' ? document.getElementById('pgj-supplier').value : null;
  const via         = document.getElementById('pgj-via').value;
  const rekeningId  = via === 'transfer' ? document.getElementById('pgj-rekening').value : null;
  const ket         = document.getElementById('pgj-ket').value.trim();

  if (!tgl || !kategori || !jumlah) { toast('Tanggal, kategori, dan jumlah wajib', 'error'); return; }
  if (kategori === 'bayar-supplier' && !supplierId) { toast('Pilih supplier', 'error'); return; }
  if (via === 'transfer' && !rekeningId) { toast('Pilih rekening', 'error'); return; }

  try {
    await addDoc(collection(db, 'pengajuan_kas'), {
      tgl, kategori, jumlah,
      supplierId:  supplierId  || null,
      via,
      rekeningId:  rekeningId  || null,
      ket,
      status: 'pending',
      pengajuId:   currentUser.uid,
      pengajuNama: currentUserData?.nama || '',
      pengajuRole: currentRole || '',
      createdAt:   serverTimestamp(),
    });
    // Clear form
    ['pgj-jumlah', 'pgj-ket'].forEach(id => { document.getElementById(id).value = ''; });
    document.getElementById('pgj-supplier').value = '';
    document.getElementById('pgj-rekening').value = '';
    document.getElementById('pgj-via').value = 'tunai';
    document.getElementById('pgj-supplier-wrap').style.display = 'none';
    document.getElementById('pgj-rekening-wrap').style.display = 'none';
    document.getElementById('pgj-tgl').value = today();
    toast('Pengajuan terkirim, menunggu konfirmasi Kasir');
  } catch (e) {
    toast('Gagal: ' + e.message, 'error');
  }
});

// Render: pengajuan pending (untuk Kasir/Admin konfirmasi)
function renderPengajuanPending() {
  const tbody = document.getElementById('tbody-pengajuan-pending');
  if (!tbody) return;
  const list = pengajuanData.filter(p => p.status === 'pending');
  const canKonfirmasi = currentRole === 'developer' || currentRole === 'kasir';

  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-note">Tidak ada pengajuan menunggu konfirmasi</td></tr>`;
    return;
  }
  tbody.innerHTML = '';
  list.forEach(p => {
    const katLabel = getKategoriLabel(p.kategori);
    const isNonBisnis = isKategoriNonBisnis(p.kategori);
    const viaLabel = p.via === 'transfer' ? rekeningName(p.rekeningId) : 'Tunai';
    const supLabel = p.supplierId ? supplierName(p.supplierId) : '–';
    const tr = document.createElement('tr');
    if (isNonBisnis) tr.classList.add('row-non-bisnis');
    tr.innerHTML = `
      <td>${p.tgl}</td>
      <td>${katLabel}${isNonBisnis ? ' <span class="badge badge-non-bisnis">Non-Bisnis</span>' : ''}</td>
      <td>${supLabel}</td>
      <td class="text-red"><strong>${rupiah(p.jumlah)}</strong></td>
      <td>${viaLabel}</td>
      <td>${p.ket || '–'}</td>
      <td><span style="font-size:12px;font-weight:600">${p.pengajuNama || '–'}</span><br><span style="font-size:10px;color:#9ca3af">${p.pengajuRole || ''}</span></td>
      <td class="col-pengajuan-aksi" style="${canKonfirmasi ? '' : 'display:none'}">
        <button class="btn-sm btn-sm-green" data-konfirmasi-pgj="${p.id}">✓ Konfirmasi</button>
        <button class="btn-sm btn-sm-red" data-tolak-pgj="${p.id}">Tolak</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

// Render: riwayat semua pengajuan
function renderPengajuanRiwayat() {
  const tbody = document.getElementById('tbody-pengajuan-riwayat');
  if (!tbody) return;
  if (!pengajuanData.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-note">Belum ada pengajuan</td></tr>`;
    return;
  }
  tbody.innerHTML = '';
  pengajuanData.forEach(p => {
    const katLabel = getKategoriLabel(p.kategori);
    const viaLabel = p.via === 'transfer' ? rekeningName(p.rekeningId) : 'Tunai';
    let statusBadge = '';
    if (p.status === 'pending')  statusBadge = '<span class="badge badge-po-pending">Pending</span>';
    if (p.status === 'done')     statusBadge = '<span class="badge badge-lunas">✓ Disetujui</span>';
    if (p.status === 'rejected') statusBadge = `<span class="badge badge-hutang">Ditolak</span>${p.rejectReason ? `<br><small style="color:#9ca3af">${p.rejectReason}</small>` : ''}`;
    const konfirm = p.konfirmasiNama
      ? `<span style="font-size:12px">${p.konfirmasiNama}</span>`
      : '<span class="text-muted-sm">–</span>';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${p.tgl}</td>
      <td>${katLabel}</td>
      <td><strong>${rupiah(p.jumlah)}</strong></td>
      <td>${viaLabel}</td>
      <td><span style="font-size:12px">${p.pengajuNama || '–'}</span></td>
      <td>${statusBadge}</td>
      <td>${konfirm}</td>
    `;
    tbody.appendChild(tr);
  });
}

// Handler konfirmasi / tolak
document.getElementById('tbody-pengajuan-pending')?.addEventListener('click', async e => {
  const konfId = e.target.dataset.konfirmasiPgj;
  const tolakId = e.target.dataset.tolakPgj;
  if (!konfId && !tolakId) return;
  if (!['developer', 'kasir'].includes(currentRole)) { toast('Hanya Kasir/Admin yang bisa konfirmasi', 'error'); return; }

  const id = konfId || tolakId;
  const p = pengajuanData.find(x => x.id === id);
  if (!p) return;

  if (konfId) {
    confirmDelete(`Konfirmasi pengajuan <strong>${getKategoriLabel(p.kategori)}</strong> sebesar <strong>${rupiah(p.jumlah)}</strong>?<br>Ini akan masuk sebagai pengeluaran kas.`, async () => {
      try {
        // 1. Buat entry di kasir collection (pengeluaran)
        const kasirRef = await addDoc(collection(db, 'kasir'), {
          tgl: p.tgl,
          jenis: 'pengeluaran',
          kategori: p.kategori,
          jumlah: p.jumlah,
          supplierId: p.supplierId || null,
          via: p.via,
          rekeningId: p.rekeningId || null,
          ket: p.ket || '',
          inputBy:     currentUser.uid,
          inputByNama: currentUserData?.nama || '',
          inputByRole: currentRole || '',
          sumberPengajuanId: p.id,
          sumberPengajuanOleh: p.pengajuNama || '',
          createdAt: serverTimestamp(),
        });
        // 2. Update pengajuan jadi done
        await updateDoc(doc(db, 'pengajuan_kas', p.id), {
          status: 'done',
          konfirmasiId: currentUser.uid,
          konfirmasiNama: currentUserData?.nama || '',
          kasirDocId: kasirRef.id,
          doneAt: serverTimestamp(),
        });
        toast('Pengajuan dikonfirmasi & masuk ke kas');
      } catch (err) {
        toast('Gagal: ' + err.message, 'error');
      }
    }, 'Konfirmasi');
  } else {
    // Tolak — minta alasan via prompt sederhana
    const reason = prompt('Alasan penolakan (opsional):') || '';
    try {
      await updateDoc(doc(db, 'pengajuan_kas', p.id), {
        status: 'rejected',
        konfirmasiId: currentUser.uid,
        konfirmasiNama: currentUserData?.nama || '',
        rejectReason: reason,
        doneAt: serverTimestamp(),
      });
      toast('Pengajuan ditolak');
    } catch (err) {
      toast('Gagal: ' + err.message, 'error');
    }
  }
});

// Badge angka di nav "Pengajuan" untuk kasir/admin
function updatePendingPengajuanBadge() {
  const count = pengajuanData.filter(p => p.status === 'pending').length;
  const badge = document.getElementById('badge-pending-pengajuan');
  if (badge) {
    if (count > 0) { badge.textContent = count; badge.classList.remove('hidden'); }
    else badge.classList.add('hidden');
  }
  // Nav button "Pengajuan" — tampilkan badge untuk admin/kasir (yg perlu konfirmasi)
  const navPgj = document.querySelector('.nav-btn[data-page="pengajuan"]');
  if (navPgj) {
    const original = navPgj.dataset.originalText || navPgj.textContent.replace(/\s*\(\d+\)\s*$/, '').trim();
    navPgj.dataset.originalText = original;
    const showBadge = ['developer', 'kasir'].includes(currentRole) && count > 0;
    navPgj.textContent = showBadge ? `${original} (${count})` : original;
  }
}

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

  const isReadOnly = currentRole === 'pemilik';
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
              ...inputByFields(),
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
  const isReadOnly = currentRole === 'pemilik' || currentRole === 'kasir';
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
  const target = parseRibuan(document.getElementById('ang-target').value) || 0;
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
  const records  = piutangBayar.filter(b => b.piutangId === id);
  const dibayar  = records.filter(b => !b.type || b.type === 'bayar').reduce((a, b) => a + Number(b.jumlah || 0), 0);
  const diambil  = records.filter(b => b.type === 'ambil').reduce((a, b) => a + Number(b.jumlah || 0), 0);
  return { dibayar, diambil };
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
  const isReadOnly = currentRole === 'pemilik';
  tbody.innerHTML = '';
  let totPinjaman = 0, totBayar = 0, totSisa = 0;

  piutangData.forEach(p => {
    const { dibayar, diambil } = piutangStats(p.id);
    const totalPinjaman = Number(p.jumlah || 0) + diambil;
    const sisa    = Math.max(0, totalPinjaman - dibayar);
    const lunas   = sisa <= 0 || p.status === 'lunas';
    const nextTgl = nextCicilanDate(p.tglCicilan, Number(p.cicilan || 0), dibayar, totalPinjaman);

    if (!lunas) { totPinjaman += totalPinjaman; totBayar += dibayar; totSisa += sisa; }

    const pct = totalPinjaman > 0 ? Math.min(100, Math.round(dibayar / totalPinjaman * 100)) : 0;
    const tr  = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${p.nama}</strong>${p.ket ? `<br><small style="color:var(--text-muted)">${p.ket}</small>` : ''}</td>
      <td>${p.tgl || '–'}</td>
      <td>${rupiah(totalPinjaman)}${diambil > 0 ? `<br><small style="color:#0891b2">+${rupiah(diambil)} ambil lagi</small>` : ''}</td>
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
      <td>
        <div style="display:flex;gap:4px;flex-wrap:wrap">
          <button class="btn-sm btn-sm-gray" data-riwayat-piu="${p.id}">📋 Riwayat</button>
          ${!isReadOnly && !lunas ? `<button class="btn-sm btn-sm-blue" data-catat-bayar="${p.id}" data-nama="${p.nama}" data-cicilan="${p.cicilan||0}">💰 Catat Bayar</button>` : ''}
          ${!isReadOnly && !lunas ? `<button class="btn-sm btn-sm-orange" data-ambil-lagi="${p.id}" data-nama="${p.nama}">💸 Ambil Lagi</button>` : ''}
          ${!isReadOnly ? `<button class="btn-sm btn-sm-red" data-del-piutang="${p.id}">Hapus</button>` : ''}
        </div>
      </td>
    `;
    tbody.appendChild(tr);

    // Baris detail riwayat (tersembunyi)
    const trDetail = document.createElement('tr');
    trDetail.id = `riwayat-row-${p.id}`;
    trDetail.style.display = 'none';
    trDetail.innerHTML = `<td colspan="10" style="padding:0;background:#f8fafc">
      <div style="padding:12px 16px">
        <strong style="font-size:13px;color:#0891b2">📋 Riwayat Pembayaran — ${p.nama}</strong>
        <table style="width:100%;margin-top:8px;font-size:12px;border-collapse:collapse">
          <thead>
            <tr style="background:#e0f2fe;color:#075985">
              <th style="padding:6px 8px;text-align:left;border-radius:4px 0 0 4px">Tanggal</th>
              <th style="padding:6px 8px;text-align:right">Jumlah</th>
              <th style="padding:6px 8px;text-align:left">Keterangan</th>
              <th style="padding:6px 8px;text-align:left;border-radius:0 4px 4px 0">Diinput Oleh</th>
            </tr>
          </thead>
          <tbody id="riwayat-piu-${p.id}">
            <tr><td colspan="4" style="padding:8px;color:#9ca3af;text-align:center">Memuat…</td></tr>
          </tbody>
        </table>
      </div>
    </td>`;
    tbody.appendChild(trDetail);
  });

  setEl('tfoot-piu-pinjaman', rupiah(totPinjaman));
  setEl('tfoot-piu-bayar',    rupiah(totBayar));
  setEl('tfoot-piu-sisa',     rupiah(totSisa));
}

// Tambah piutang baru
document.getElementById('btn-simpan-piutang').addEventListener('click', async () => {
  const nama   = document.getElementById('piu-nama').value.trim();
  const jumlah = parseRibuan(document.getElementById('piu-jumlah').value) || 0;
  const tgl    = document.getElementById('piu-tgl').value;
  if (!nama || !jumlah || !tgl) { toast('Nama, jumlah, dan tanggal wajib diisi', 'error'); return; }
  try {
    await addDoc(collection(db, 'piutang'), {
      nama, jumlah, tgl,
      cicilan:    parseRibuan(document.getElementById('piu-cicilan').value) || 0,
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

// Klik tabel piutang: riwayat, catat bayar, atau hapus
document.getElementById('tbody-piutang').addEventListener('click', e => {
  const riwId = e.target.dataset.riwayatPiu;
  if (riwId) {
    const row = document.getElementById(`riwayat-row-${riwId}`);
    if (!row) return;
    const isOpen = row.style.display !== 'none';
    row.style.display = isOpen ? 'none' : '';
    if (!isOpen) {
      const tbody = document.getElementById(`riwayat-piu-${riwId}`);
      const bayar = piutangBayar.filter(b => b.piutangId === riwId)
        .sort((a, b) => (a.tgl || '') < (b.tgl || '') ? -1 : 1);
      if (!bayar.length) {
        tbody.innerHTML = '<tr><td colspan="4" style="padding:8px;color:#9ca3af;text-align:center">Belum ada riwayat</td></tr>';
      } else {
        tbody.innerHTML = bayar.map(b => {
          const isAmbil = b.type === 'ambil';
          return `
          <tr style="border-top:1px solid #e2e8f0;background:${isAmbil ? '#fff7ed' : 'transparent'}">
            <td style="padding:6px 8px">${b.tgl || '–'}</td>
            <td style="padding:6px 8px;text-align:right;font-weight:600;color:${isAmbil ? '#d97706' : '#16a34a'}">
              ${isAmbil ? '−' : '+'}${rupiah(b.jumlah)}
            </td>
            <td style="padding:6px 8px">
              ${isAmbil
                ? '<span style="background:#fef3c7;color:#92400e;font-size:11px;padding:2px 6px;border-radius:4px">💸 Ambil</span>'
                : '<span style="background:#dcfce7;color:#166534;font-size:11px;padding:2px 6px;border-radius:4px">✓ Bayar</span>'}
              ${b.ket ? `<span style="color:#6b7280;margin-left:4px">${b.ket}</span>` : ''}
            </td>
            <td style="padding:6px 8px;color:#6b7280">${b.inputByNama || b.inputBy || '–'}</td>
          </tr>`;
        }).join('');
      }
    }
    return;
  }

  const ambilId = e.target.dataset.ambilLagi;
  if (ambilId) {
    const nama = e.target.dataset.nama;
    ambilLagiId = ambilId;
    document.getElementById('ambil-piutang-id').value = ambilId;
    document.getElementById('panel-ambil-title').textContent = `Catat Pengambilan Uang — ${nama}`;
    document.getElementById('ambil-tgl').value    = today();
    document.getElementById('ambil-jumlah').value = '';
    document.getElementById('ambil-ket').value    = '';
    document.getElementById('panel-catat-bayar').style.display = 'none';
    const panel = document.getElementById('panel-ambil-lagi');
    panel.style.display = '';
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }

  const catId = e.target.dataset.catatBayar;
  if (catId) {
    const nama    = e.target.dataset.nama;
    const cicilan = e.target.dataset.cicilan;
    document.getElementById('bayar-piutang-id').value = catId;
    document.getElementById('panel-bayar-title').textContent = `Catat Pembayaran — ${nama}`;
    document.getElementById('bayar-tgl').value    = today();
    document.getElementById('bayar-jumlah').value = cicilan > 0 ? formatRibuan(cicilan) : '';
    document.getElementById('bayar-ket').value    = '';
    document.getElementById('panel-ambil-lagi').style.display = 'none';
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
  const jumlah = parseRibuan(document.getElementById('bayar-jumlah').value) || 0;
  const tgl    = document.getElementById('bayar-tgl').value;
  if (!jumlah || !tgl) { toast('Tanggal dan jumlah wajib diisi', 'error'); return; }
  try {
    await addDoc(collection(db, 'piutang_bayar'), {
      piutangId: piuId, jumlah, tgl, type: 'bayar',
      ket: document.getElementById('bayar-ket').value.trim(),
      ...inputByFields(),
      createdAt: serverTimestamp(),
    });
    // Cek apakah sudah lunas
    const p = piutangData.find(x => x.id === piuId);
    if (p) {
      const { dibayar, diambil } = piutangStats(piuId);
      const totalBayarBaru = dibayar + jumlah;
      const totalPinjaman  = Number(p.jumlah || 0) + diambil;
      if (totalBayarBaru >= totalPinjaman) {
        await updateDoc(doc(db, 'piutang', piuId), { status: 'lunas' });
        toast('Pembayaran dicatat — Piutang LUNAS! 🎉');
      } else {
        toast('Pembayaran berhasil dicatat ✓');
      }
    }
    document.getElementById('panel-catat-bayar').style.display = 'none';
  } catch (e) { toast('Gagal: ' + e.message, 'error'); }
});

// Simpan pengambilan tambahan (ambil lagi)
let ambilLagiId = null;
document.getElementById('tbody-piutang').addEventListener('click', e => {}, { capture: true });

document.getElementById('panel-catat-bayar').insertAdjacentHTML('afterend', `
  <div id="panel-ambil-lagi" class="form-card" style="display:none;margin-top:16px;border-top-color:#f59e0b">
    <h3 id="panel-ambil-title">Catat Pengambilan Uang</h3>
    <input type="hidden" id="ambil-piutang-id" />
    <div class="form-grid">
      <div class="form-group">
        <label>Tanggal Ambil</label>
        <input type="date" id="ambil-tgl" />
      </div>
      <div class="form-group">
        <label>Jumlah Diambil (Rp)</label>
        <input type="text" inputmode="numeric" id="ambil-jumlah" placeholder="0" />
      </div>
      <div class="form-group">
        <label>Keterangan</label>
        <input type="text" id="ambil-ket" placeholder="Opsional" />
      </div>
    </div>
    <button class="btn-primary" id="btn-simpan-ambil">Simpan Pengambilan</button>
    <button class="btn-outline" id="btn-batal-ambil" style="margin-left:8px">Batal</button>
  </div>
`);

// Daftarkan field ambil-jumlah ke auto-format
(function() {
  const el = document.getElementById('ambil-jumlah');
  el.addEventListener('input', () => {
    const raw = el.value.replace(/\./g, '').replace(/[^0-9]/g, '');
    el.value = raw ? Number(raw).toLocaleString('id-ID') : '';
  });
})();

document.getElementById('btn-batal-ambil').addEventListener('click', () => {
  document.getElementById('panel-ambil-lagi').style.display = 'none';
  ambilLagiId = null;
});

document.getElementById('btn-simpan-ambil').addEventListener('click', async () => {
  const piuId  = document.getElementById('ambil-piutang-id').value;
  const jumlah = parseRibuan(document.getElementById('ambil-jumlah').value) || 0;
  const tgl    = document.getElementById('ambil-tgl').value;
  if (!jumlah || !tgl) { toast('Tanggal dan jumlah wajib diisi', 'error'); return; }
  try {
    await addDoc(collection(db, 'piutang_bayar'), {
      piutangId: piuId, jumlah, tgl, type: 'ambil',
      ket: document.getElementById('ambil-ket').value.trim(),
      ...inputByFields(),
      createdAt: serverTimestamp(),
    });
    toast('Pengambilan berhasil dicatat ✓');
    document.getElementById('panel-ambil-lagi').style.display = 'none';
    ambilLagiId = null;
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
  const val = parseRibuan(document.getElementById('saldo-awal-tunai').value) || 0;
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
  const saldoAwal = parseRibuan(document.getElementById('rek-saldo-awal').value) || 0;
  if (!nama || !bank) { toast('Nama dan bank wajib diisi', 'error'); return; }
  try {
    await addDoc(collection(db, 'rekening'), { nama, bank, noRek, saldoAwal, createdAt: serverTimestamp(), ...inputByFields() });
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
// BACKUP & EXPORT
// ═══════════════════════════════════════════════════════════════════════════════
window.exportBackupJSON = function() {
  const backup = {
    exportDate: new Date().toISOString(),
    collections: {
      suppliers, pembelian, kasirData, poData, rekening,
      piutangData, piutangBayar,
    },
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `LapKeu_backup_${today()}.json`;
  a.click();
  toast('Backup JSON berhasil diunduh');
};

window.exportExcelFinansial = function() {
  if (typeof XLSX === 'undefined') { toast('Library Excel belum dimuat, coba lagi', 'error'); return; }
  const wb = XLSX.utils.book_new();

  const sheetKasir = XLSX.utils.json_to_sheet(kasirData.map(k => ({
    Tanggal: k.tgl, Jenis: k.jenis, Kategori: getKategoriLabel(k.kategori),
    'Jumlah (Rp)': k.jumlah, Keterangan: k.ket || '', 'Input Oleh': k.inputByNama || '',
  })));
  XLSX.utils.book_append_sheet(wb, sheetKasir, 'Transaksi Kas');

  const sheetBeli = XLSX.utils.json_to_sheet(pembelian.map(p => ({
    Tanggal: p.tgl, Supplier: supplierName(p.supplierId), Jenis: p.jenis,
    Qty: p.qty, 'Harga (Rp)': p.harga, 'Total (Rp)': p.total,
    'Cara Bayar': p.caraBayar, 'Input Oleh': p.inputByNama || '',
  })));
  XLSX.utils.book_append_sheet(wb, sheetBeli, 'Pembelian');

  const sheetPiutang = XLSX.utils.json_to_sheet(piutangData.map(p => {
    const { dibayar, diambil } = piutangStats(p.id);
    return {
      Tanggal: p.tgl, Nama: p.nama, 'Jumlah (Rp)': p.jumlah,
      'Tambahan (Rp)': diambil, 'Dibayar (Rp)': dibayar,
      'Sisa (Rp)': Math.max(0, Number(p.jumlah || 0) + diambil - dibayar),
      Status: p.status || 'aktif', 'Input Oleh': p.inputByNama || '',
    };
  }));
  XLSX.utils.book_append_sheet(wb, sheetPiutang, 'Piutang');

  [sheetKasir, sheetBeli, sheetPiutang].forEach(ws => {
    const ref = XLSX.utils.decode_range(ws['!ref'] || 'A1');
    const cols = [];
    for (let C = ref.s.c; C <= ref.e.c; C++) {
      let max = 10;
      for (let R = ref.s.r; R <= ref.e.r; R++) {
        const cell = ws[XLSX.utils.encode_cell({r: R, c: C})];
        if (cell?.v != null) max = Math.min(40, Math.max(max, String(cell.v).length + 2));
      }
      cols.push({wch: max});
    }
    ws['!cols'] = cols;
  });

  XLSX.writeFile(wb, `LapKeu_export_${today()}.xlsx`);
  toast('Export Excel berhasil diunduh');
};

// ═══════════════════════════════════════════════════════════════════════════════
// Init default dates
// ═══════════════════════════════════════════════════════════════════════════════
document.getElementById('beli-tgl').value = today();
document.getElementById('kas-tgl').value  = today();
document.getElementById('po-tgl').value   = today();
document.getElementById('mut-tgl').value  = today();
document.getElementById('piu-tgl').value  = today();
