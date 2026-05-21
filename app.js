// ─── Storage helpers ─────────────────────────────────────────────────────────
const load = (key, def = []) => { try { return JSON.parse(localStorage.getItem(key)) ?? def; } catch { return def; } };
const save = (key, val) => localStorage.setItem(key, JSON.stringify(val));

// ─── State ───────────────────────────────────────────────────────────────────
let suppliers  = load('suppliers', []);
let pembelian  = load('pembelian', []);
let kasir      = load('kasir', []);

// ─── Utils ───────────────────────────────────────────────────────────────────
const rupiah = n => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
const uid    = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const today  = () => new Date().toISOString().split('T')[0];
const monthOf = d => d ? d.slice(0, 7) : '';

function toast(msg, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast ' + type;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 2800);
}

// ─── Navigation ──────────────────────────────────────────────────────────────
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('page-' + btn.dataset.page).classList.add('active');
    if (btn.dataset.page === 'dashboard') renderDashboard();
    if (btn.dataset.page === 'laporan') renderLaporan();
  });
});

// ─── Supplier helpers ─────────────────────────────────────────────────────────
function supplierName(id) {
  return suppliers.find(s => s.id === id)?.nama || id || '-';
}

function supplierStats(supId) {
  const totalBeli = pembelian
    .filter(p => p.supplierId === supId)
    .reduce((a, p) => a + Number(p.total), 0);
  const totalBayar = kasir
    .filter(k => k.kategori === 'bayar-supplier' && k.supplierId === supId)
    .reduce((a, k) => a + Number(k.jumlah), 0);
  return { totalBeli, totalBayar, hutang: Math.max(0, totalBeli - totalBayar) };
}

function populateSupplierSelects() {
  const selects = ['beli-supplier', 'filter-beli-supplier', 'kas-supplier', 'filter-kas-supplier'].map(id => document.getElementById(id)).filter(Boolean);
  selects.forEach(sel => {
    const val = sel.value;
    const first = sel.options[0];
    sel.innerHTML = '';
    sel.appendChild(first);
    suppliers.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = `${s.nama} (${s.asal})`;
      sel.appendChild(opt);
    });
    sel.value = val;
  });
}

// ─── SUPPLIER page ────────────────────────────────────────────────────────────
function renderSupplier() {
  const tbody = document.getElementById('tbody-supplier');
  tbody.innerHTML = '';
  if (!suppliers.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-note">Belum ada supplier</td></tr>';
    return;
  }
  suppliers.forEach(s => {
    const st = supplierStats(s.id);
    const status = st.hutang <= 0 ? '<span class="badge badge-lunas">Lunas</span>' : '<span class="badge badge-hutang">Ada Hutang</span>';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${s.nama}</strong></td>
      <td>${s.asal}</td>
      <td>${s.jenis}</td>
      <td>${s.hp || '-'}</td>
      <td>${rupiah(st.totalBeli)}</td>
      <td>${rupiah(st.totalBayar)}</td>
      <td class="${st.hutang > 0 ? 'text-red' : 'text-green'}">${rupiah(st.hutang)}</td>
      <td>${status}</td>
      <td><button class="btn-sm btn-sm-red" data-del-sup="${s.id}">Hapus</button></td>
    `;
    tbody.appendChild(tr);
  });
}

document.getElementById('btn-simpan-sup').addEventListener('click', () => {
  const nama = document.getElementById('sup-nama').value.trim();
  if (!nama) { toast('Nama supplier wajib diisi', 'error'); return; }
  suppliers.push({
    id: uid(),
    nama,
    asal: document.getElementById('sup-asal').value,
    jenis: document.getElementById('sup-jenis').value.trim() || '-',
    hp: document.getElementById('sup-hp').value.trim(),
    ket: document.getElementById('sup-ket').value.trim(),
  });
  save('suppliers', suppliers);
  populateSupplierSelects();
  renderSupplier();
  renderDashboard();
  ['sup-nama','sup-jenis','sup-hp','sup-ket'].forEach(id => document.getElementById(id).value = '');
  toast('Supplier berhasil ditambahkan');
});

document.getElementById('tbody-supplier').addEventListener('click', e => {
  const id = e.target.dataset.delSup;
  if (!id) return;
  const s = suppliers.find(x => x.id === id);
  confirmDelete(`Hapus supplier <strong>${s.nama}</strong>?`, () => {
    suppliers = suppliers.filter(x => x.id !== id);
    save('suppliers', suppliers);
    populateSupplierSelects();
    renderSupplier();
    renderDashboard();
    toast('Supplier dihapus');
  });
});

// ─── PEMBELIAN page ───────────────────────────────────────────────────────────
function calcBeliTotal() {
  const qty = Number(document.getElementById('beli-qty').value) || 0;
  const harga = Number(document.getElementById('beli-harga').value) || 0;
  document.getElementById('beli-total').value = rupiah(qty * harga);
}
document.getElementById('beli-qty').addEventListener('input', calcBeliTotal);
document.getElementById('beli-harga').addEventListener('input', calcBeliTotal);

function renderPembelian(filter = {}) {
  const tbody = document.getElementById('tbody-pembelian');
  tbody.innerHTML = '';
  let data = [...pembelian];
  if (filter.bulan) data = data.filter(p => monthOf(p.tgl) === filter.bulan);
  if (filter.supplierId) data = data.filter(p => p.supplierId === filter.supplierId);
  data.sort((a, b) => b.tgl.localeCompare(a.tgl));

  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-note">Belum ada data pembelian</td></tr>';
    document.getElementById('tfoot-pembelian-total').textContent = rupiah(0);
    return;
  }
  let totalSum = 0;
  data.forEach(p => {
    totalSum += Number(p.total);
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
      <td><button class="btn-sm btn-sm-red" data-del-beli="${p.id}">Hapus</button></td>
    `;
    tbody.appendChild(tr);
  });
  document.getElementById('tfoot-pembelian-total').textContent = rupiah(totalSum);
}

document.getElementById('btn-simpan-beli').addEventListener('click', () => {
  const tgl = document.getElementById('beli-tgl').value;
  const supId = document.getElementById('beli-supplier').value;
  const jenis = document.getElementById('beli-jenis').value.trim();
  const qty = Number(document.getElementById('beli-qty').value);
  const harga = Number(document.getElementById('beli-harga').value);
  if (!tgl || !supId || !jenis || !qty || !harga) { toast('Lengkapi semua field wajib', 'error'); return; }
  const entry = {
    id: uid(), tgl, supplierId: supId, jenis, qty, harga,
    total: qty * harga,
    caraBayar: document.getElementById('beli-carabayar').value,
    ket: document.getElementById('beli-ket').value.trim(),
  };
  pembelian.push(entry);
  save('pembelian', pembelian);
  renderPembelian();
  renderSupplier();
  renderDashboard();
  ['beli-tgl','beli-jenis','beli-qty','beli-harga','beli-ket'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('beli-total').value = '';
  document.getElementById('beli-supplier').value = '';
  toast('Pembelian berhasil disimpan');
});

document.getElementById('btn-filter-beli').addEventListener('click', () => {
  renderPembelian({
    bulan: document.getElementById('filter-beli-bulan').value,
    supplierId: document.getElementById('filter-beli-supplier').value,
  });
});

document.getElementById('tbody-pembelian').addEventListener('click', e => {
  const id = e.target.dataset.delBeli;
  if (!id) return;
  confirmDelete('Hapus data pembelian ini?', () => {
    pembelian = pembelian.filter(p => p.id !== id);
    save('pembelian', pembelian);
    renderPembelian();
    renderSupplier();
    renderDashboard();
    toast('Data pembelian dihapus');
  });
});

// ─── KASIR page ───────────────────────────────────────────────────────────────
document.getElementById('kas-kategori').addEventListener('change', function() {
  document.getElementById('kas-supplier-wrap').style.display =
    this.value === 'bayar-supplier' ? '' : 'none';
});

function renderKasir(filter = {}) {
  const tbody = document.getElementById('tbody-kasir');
  tbody.innerHTML = '';
  let data = [...kasir];
  if (filter.bulan) data = data.filter(k => monthOf(k.tgl) === filter.bulan);
  if (filter.jenis) data = data.filter(k => k.jenis === filter.jenis);
  data.sort((a, b) => b.tgl.localeCompare(a.tgl));

  let masuk = 0, keluar = 0;
  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-note">Belum ada transaksi kas</td></tr>';
  } else {
    data.forEach(k => {
      if (k.jenis === 'pemasukan') masuk += Number(k.jumlah);
      else keluar += Number(k.jumlah);
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
        <td>${k.ket || '-'}</td>
        <td><button class="btn-sm btn-sm-red" data-del-kas="${k.id}">Hapus</button></td>
      `;
      tbody.appendChild(tr);
    });
  }
  document.getElementById('tfoot-kas-masuk').textContent = rupiah(masuk);
  document.getElementById('tfoot-kas-keluar').textContent = rupiah(keluar);
  const saldo = masuk - keluar;
  const saldoEl = document.getElementById('tfoot-kas-saldo');
  saldoEl.textContent = rupiah(saldo);
  saldoEl.className = 'tfoot-value ' + (saldo >= 0 ? 'text-green' : 'text-red');
}

document.getElementById('btn-simpan-kas').addEventListener('click', () => {
  const tgl = document.getElementById('kas-tgl').value;
  const jenis = document.getElementById('kas-jenis').value;
  const kategori = document.getElementById('kas-kategori').value;
  const jumlah = Number(document.getElementById('kas-jumlah').value);
  const supplierId = kategori === 'bayar-supplier' ? document.getElementById('kas-supplier').value : null;
  if (!tgl || !jumlah) { toast('Tanggal dan jumlah wajib diisi', 'error'); return; }
  if (kategori === 'bayar-supplier' && !supplierId) { toast('Pilih supplier untuk pembayaran hutang', 'error'); return; }
  kasir.push({
    id: uid(), tgl, jenis, kategori, jumlah,
    supplierId: supplierId || null,
    ket: document.getElementById('kas-ket').value.trim(),
  });
  save('kasir', kasir);
  renderKasir();
  renderSupplier();
  renderDashboard();
  ['kas-tgl','kas-jumlah','kas-ket'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('kas-supplier').value = '';
  document.getElementById('kas-supplier-wrap').style.display = 'none';
  toast('Transaksi berhasil disimpan');
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
  confirmDelete('Hapus transaksi ini?', () => {
    kasir = kasir.filter(k => k.id !== id);
    save('kasir', kasir);
    renderKasir();
    renderSupplier();
    renderDashboard();
    toast('Transaksi dihapus');
  });
});

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
function renderDashboard() {
  const totalMasuk  = kasir.filter(k => k.jenis === 'pemasukan').reduce((a, k) => a + Number(k.jumlah), 0);
  const totalKeluar = kasir.filter(k => k.jenis === 'pengeluaran').reduce((a, k) => a + Number(k.jumlah), 0);
  const totalBeli   = pembelian.reduce((a, p) => a + Number(p.total), 0);
  const totalBayarSup = kasir.filter(k => k.kategori === 'bayar-supplier').reduce((a, k) => a + Number(k.jumlah), 0);
  const totalHutang = Math.max(0, suppliers.reduce((a, s) => a + supplierStats(s.id).hutang, 0));

  document.getElementById('dash-pemasukan').textContent    = rupiah(totalMasuk);
  document.getElementById('dash-pengeluaran').textContent  = rupiah(totalKeluar);
  document.getElementById('dash-saldo').textContent        = rupiah(totalMasuk - totalKeluar);
  document.getElementById('dash-hutang').textContent       = rupiah(totalHutang);
  document.getElementById('dash-pembelian').textContent    = rupiah(totalBeli);
  document.getElementById('dash-bayar-supplier').textContent = rupiah(totalBayarSup);

  const tbody = document.getElementById('tbody-hutang-summary');
  tbody.innerHTML = '';
  if (!suppliers.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-note">Belum ada data supplier</td></tr>';
    return;
  }
  suppliers.forEach(s => {
    const st = supplierStats(s.id);
    const status = st.hutang <= 0 ? '<span class="badge badge-lunas">Lunas</span>' : '<span class="badge badge-hutang">Ada Hutang</span>';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${s.nama}</strong></td>
      <td>${s.asal}</td>
      <td>${rupiah(st.totalBeli)}</td>
      <td>${rupiah(st.totalBayar)}</td>
      <td class="${st.hutang > 0 ? 'text-red' : 'text-green'}">${rupiah(st.hutang)}</td>
      <td>${status}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ─── LAPORAN ──────────────────────────────────────────────────────────────────
function renderLaporan() {
  const bulan = document.getElementById('filter-laporan-bulan').value;
  const output = document.getElementById('laporan-output');
  if (!bulan) { output.innerHTML = '<p class="empty-note">Pilih bulan dan klik "Tampilkan Laporan"</p>'; return; }

  const beliBulan  = pembelian.filter(p => monthOf(p.tgl) === bulan);
  const kasirBulan = kasir.filter(k => monthOf(k.tgl) === bulan);

  const totalBeli   = beliBulan.reduce((a, p) => a + Number(p.total), 0);
  const totalMasuk  = kasirBulan.filter(k => k.jenis === 'pemasukan').reduce((a, k) => a + Number(k.jumlah), 0);
  const totalKeluar = kasirBulan.filter(k => k.jenis === 'pengeluaran').reduce((a, k) => a + Number(k.jumlah), 0);
  const totalBayarSup = kasirBulan.filter(k => k.kategori === 'bayar-supplier').reduce((a, k) => a + Number(k.jumlah), 0);

  // Pemasukan per kategori
  const masukKat = {};
  kasirBulan.filter(k => k.jenis === 'pemasukan').forEach(k => { masukKat[k.kategori] = (masukKat[k.kategori] || 0) + Number(k.jumlah); });
  const keluarKat = {};
  kasirBulan.filter(k => k.jenis === 'pengeluaran').forEach(k => { keluarKat[k.kategori] = (keluarKat[k.kategori] || 0) + Number(k.jumlah); });

  // Hutang per supplier (kumulatif s/d bulan ini)
  const allBeliUntil = pembelian.filter(p => monthOf(p.tgl) <= bulan);
  const allBayarUntil = kasir.filter(k => k.kategori === 'bayar-supplier' && monthOf(k.tgl) <= bulan);
  const hutangRows = suppliers.map(s => {
    const beli  = allBeliUntil.filter(p => p.supplierId === s.id).reduce((a, p) => a + Number(p.total), 0);
    const bayar = allBayarUntil.filter(k => k.supplierId === s.id).reduce((a, k) => a + Number(k.jumlah), 0);
    return { nama: s.nama, asal: s.asal, beli, bayar, hutang: Math.max(0, beli - bayar) };
  });

  const [y, m] = bulan.split('-');
  const namaBulan = new Date(y, m - 1).toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });

  let html = `<h2 style="margin-bottom:20px">Laporan Keuangan — ${namaBulan}</h2>`;

  // 1. Arus Kas
  html += `<div class="laporan-section"><h3>1. Arus Kas</h3>`;
  html += `<div class="laporan-row"><span>Pemasukan</span></div>`;
  Object.entries(masukKat).forEach(([kat, val]) => {
    html += `<div class="laporan-row" style="padding-left:16px"><span>${kat}</span><span class="text-green">${rupiah(val)}</span></div>`;
  });
  if (!Object.keys(masukKat).length) html += `<div class="laporan-row" style="padding-left:16px"><span>-</span><span>Rp 0</span></div>`;
  html += `<div class="laporan-row"><span><em>Total Pemasukan</em></span><span class="text-green"><strong>${rupiah(totalMasuk)}</strong></span></div>`;
  html += `<div class="laporan-row"><span>Pengeluaran</span></div>`;
  Object.entries(keluarKat).forEach(([kat, val]) => {
    html += `<div class="laporan-row" style="padding-left:16px"><span>${kat}</span><span class="text-red">${rupiah(val)}</span></div>`;
  });
  if (!Object.keys(keluarKat).length) html += `<div class="laporan-row" style="padding-left:16px"><span>-</span><span>Rp 0</span></div>`;
  html += `<div class="laporan-row"><span><em>Total Pengeluaran</em></span><span class="text-red"><strong>${rupiah(totalKeluar)}</strong></span></div>`;
  const saldoBulan = totalMasuk - totalKeluar;
  html += `<div class="laporan-total"><span>Saldo Bersih</span><span class="${saldoBulan >= 0 ? 'text-green' : 'text-red'}">${rupiah(saldoBulan)}</span></div>`;
  html += `</div>`;

  // 2. Pembelian Barang
  html += `<div class="laporan-section"><h3>2. Pembelian Barang Bulan Ini</h3>`;
  if (beliBulan.length) {
    beliBulan.sort((a, b) => b.tgl.localeCompare(a.tgl)).forEach(p => {
      html += `<div class="laporan-row"><span>${p.tgl} — ${supplierName(p.supplierId)} — ${p.jenis} (${p.qty} pcs)</span><span>${rupiah(p.total)}</span></div>`;
    });
  } else {
    html += `<div class="laporan-row"><span>Tidak ada pembelian</span><span>Rp 0</span></div>`;
  }
  html += `<div class="laporan-total"><span>Total Pembelian</span><span>${rupiah(totalBeli)}</span></div>`;
  html += `</div>`;

  // 3. Hutang Supplier (kumulatif)
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

// ─── MODAL confirm ────────────────────────────────────────────────────────────
let _confirmCb = null;
function confirmDelete(msg, cb) {
  document.getElementById('modal-body').innerHTML = msg;
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

// ─── Init ─────────────────────────────────────────────────────────────────────
document.getElementById('beli-tgl').value = today();
document.getElementById('kas-tgl').value  = today();
populateSupplierSelects();
renderDashboard();
renderSupplier();
renderPembelian();
renderKasir();
