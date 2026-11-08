// Pembaca mutasi / rekening koran bank (PDF e-statement atau CSV/Excel) → baris { tgl, ket, kredit, debit }.
// PDF dibaca teksnya (bukan foto), lalu dikenali per baris:
//   • baris diawali tanggal (dd/mm/yy, dd/mm/yyyy, dd-mm, dd/mm, dd MMM yyyy, yyyy-mm-dd)
//   • nominal 1,234,567.00 atau 1.234.567,00; penanda DB/D = keluar, CR/K = masuk
//   • tanpa penanda: 3+ nominal = Debet | Kredit | Saldo (BRI, Mandiri, CIMB); 1–2 nominal = uang masuk (BCA tanpa "DB")
//   • baris lanjutan tanpa tanggal = sambungan keterangan
// Dipakai Custom Order & Laporan Keuangan — salin file ini bila diubah.

const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/'
const BLN = { jan: 1, feb: 2, mar: 3, apr: 4, mei: 5, may: 5, jun: 6, jul: 7, agu: 8, aug: 8, ags: 8, sep: 9, okt: 10, oct: 10, nov: 11, des: 12, dec: 12 }
const pad = n => String(n).padStart(2, '0')
const RE_NOMINAL = /(?<![\d.,])(\d{1,3}(?:,\d{3})+\.\d{2}|\d{1,3}(?:\.\d{3})+,\d{2}|\d{1,3}\.\d{2}|\d{1,3},\d{2})(?![\d])(\s*(?:DB|CR|D|K)\b)?/g

export function angkaNominal(s) {
  s = String(s).trim()
  if (/,\d{2}$/.test(s) && !/\.\d{2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.')
  else s = s.replace(/,/g, '')
  return parseFloat(s) || 0
}

function tanggalAwal(line, tahun) {
  let m = line.match(/^\s*(\d{4})-(\d{2})-(\d{2})/)
  if (m) return { tgl: `${m[1]}-${m[2]}-${m[3]}`, sisa: line.slice(m[0].length) }
  m = line.match(/^\s*(\d{1,2})[/.\-](\d{1,2})(?:[/.\-](\d{2,4}))?(?!\d)/)
  if (m && +m[2] >= 1 && +m[2] <= 12 && +m[1] >= 1 && +m[1] <= 31) {
    const y = m[3] ? (m[3].length === 2 ? '20' + m[3] : m[3]) : tahun
    return { tgl: `${y}-${pad(m[2])}-${pad(m[1])}`, sisa: line.slice(m[0].length) }
  }
  m = line.match(/^\s*(\d{1,2})[\s\-]([A-Za-z]{3})[A-Za-z]*[\s\-](\d{2,4})/)
  if (m && BLN[m[2].toLowerCase()]) {
    const y = m[3].length === 2 ? '20' + m[3] : m[3]
    return { tgl: `${y}-${pad(BLN[m[2].toLowerCase()])}-${pad(m[1])}`, sisa: line.slice(m[0].length) }
  }
  return null
}

// lines: teks per baris (urut atas → bawah). tahun: dipakai bila tanggal tanpa tahun (BCA).
export function barisDariTeks(lines, tahun) {
  const hasil = []
  let cur = null
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) continue
    const t = tanggalAwal(line, tahun)
    if (t) {
      const sisa = t.sisa.replace(/^\s*\d{2}:\d{2}(:\d{2})?/, '') // jam (BRI)
      if (/SALDO\s+AWAL|SALDO\s+AKHIR|OPENING\s+BALANCE|CLOSING\s+BALANCE|BEGINNING\s+BALANCE/i.test(sisa)) { cur = null; continue }
      const nom = [...sisa.matchAll(RE_NOMINAL)].map(m => ({ v: angkaNominal(m[1]), tanda: (m[2] || '').trim().toUpperCase(), idx: m.index }))
      if (!nom.length) { cur = null; continue }
      let kredit = 0, debit = 0
      const bertanda = nom.find(n => n.tanda)
      if (bertanda) { if (['DB', 'D'].includes(bertanda.tanda)) debit = bertanda.v; else kredit = bertanda.v }
      else if (nom.length >= 3) { debit = nom[nom.length - 3].v; kredit = nom[nom.length - 2].v }
      else kredit = nom[0].v
      const ket = sisa.slice(0, nom[0].idx).replace(/\s{2,}/g, ' ').trim()
      // Saldo: nominal terakhir tanpa tanda, bila ada ≥2 nominal (BRI tiap baris, BCA akhir hari)
      const akhir = nom[nom.length - 1]
      const saldo = nom.length >= 2 && !akhir.tanda ? akhir.v : null
      cur = { tgl: t.tgl, ket, kredit, debit, saldo }
      hasil.push(cur)
    } else if (cur && line.trim().length < 80 && !/halaman|page \d|^\s*(tanggal|transaction|keterangan|uraian|saldo|total)/i.test(line)) {
      cur.ket = (cur.ket + ' ' + line.replace(/\s{2,}/g, ' ').trim()).trim()
    }
  }
  return hasil
}

async function muatPdfJs() {
  if (window.pdfjsLib) return window.pdfjsLib
  await new Promise((ok, gagal) => { const s = document.createElement('script'); s.src = PDFJS + 'pdf.min.js'; s.onload = ok; s.onerror = gagal; document.head.appendChild(s) })
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js'
  return window.pdfjsLib
}

// Teks PDF → baris (kelompokkan potongan teks dengan posisi y yang sama)
export async function teksPdf(file, lib) {
  lib = lib || await muatPdfJs()
  const pdf = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise
  const lines = []
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p)
    const tc = await page.getTextContent()
    const grup = []
    tc.items.filter(i => i.str && i.str.trim()).forEach(i => {
      const y = i.transform[5], x = i.transform[4]
      let g = grup.find(g => Math.abs(g.y - y) < 3)
      if (!g) { g = { y, items: [] }; grup.push(g) }
      g.items.push({ x, s: i.str, w: i.width || 0 })
    })
    grup.sort((a, b) => b.y - a.y).forEach(g => {
      g.items.sort((a, b) => a.x - b.x)
      let teks = '', akhir = null
      g.items.forEach(it => { teks += (akhir == null ? '' : (it.x - akhir > 8 ? '   ' : (it.x - akhir > 1.5 ? ' ' : ''))) + it.s; akhir = it.x + it.w })
      lines.push(teks)
    })
  }
  return lines
}

// Tahun periode dari teks PDF (mis. "PERIODE : OKTOBER 2026"), untuk tanggal tanpa tahun
export function tahunDariTeks(lines, cadangan) {
  const t = lines.join(' ').match(/PERIODE[^0-9]{0,40}(20\d{2})/i) || lines.join(' ').match(/\b(20\d{2})\b/)
  return t ? t[1] : cadangan
}

export async function bacaPdf(file, tahunCadangan) {
  const lines = await teksPdf(file)
  return barisDariTeks(lines, tahunDariTeks(lines, tahunCadangan))
}
