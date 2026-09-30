# Suara Pendukung — Data Pendukung Pilkades (PWA)

Aplikasi PWA (bisa di-install di Android, iPhone, desktop) untuk mengelola data pendukung Pilkades.
**Hosting: Vercel (auto-deploy dari GitHub). Database: Google Sheets yang sama dengan aplikasi Apps Script lama.**

- **Admin**: tambah/ubah/hapus data, verifikasi TTD, cetak, pengaturan, kelola user, log.
- **User**: lihat dashboard, cari/filter data, lihat foto (read-only, dijaga di server).
- **Foto KTP**: kamera berbingkai KTP, putar/crop bebas, baca otomatis Nama & NIK (gratis).
- Login per orang (bcrypt + JWT cookie httpOnly). Foto tidak publik — hanya lewat `/api/photo` yang wajib login.

---

## 1. Gambaran: siapa mengerjakan apa

| Bagian | Dipakai untuk | Di mana |
|---|---|---|
| **Vercel + GitHub** | Menjalankan aplikasi. Push ke `main` → otomatis deploy | vercel.com, github.com |
| **Google Sheets** (spreadsheet lama Anda) | **Database**: Pendukung, Config, Log, Users | diakses lewat **Service Account** |
| **Google Drive akun Anda** | Menyimpan **foto** KTP & bukti TTD (folder `FOTO_KTP_PENDUKUNG_2026`, `FOTO_BUKTI_TTD_2026`) | lewat **Jembatan Apps Script** |
| **Apps Script (project lama)** | Hanya sebagai **jembatan foto + baca KTP**. Aplikasi Apps Script lama tetap bisa jalan berdampingan | script.google.com |

**Tidak perlu / tidak dipakai lagi:** Google Cloud Vision, billing Google Cloud, OAuth / OAuth Playground, Drive API di Cloud Console.
Satu-satunya hal di Google Cloud Console adalah **Service Account + Sheets API** (bagian 3A).

```
Browser (PWA) ──► Vercel (api/*.js) ──► Google Sheets API  (data; Service Account)
                                   └──► Web App Apps Script ──► Drive Anda (foto) + OCR Drive (baca KTP)
```

## 2. Struktur Proyek

```
public/       Frontend PWA: index.html, css/, js/ (app, ktpcam, pages, pwa), sw.js, ikon, vendor
api/          Serverless Vercel: auth.js (login), rpc.js (semua aksi), photo.js (proxy foto), health.js (diagnosis)
lib/          gauth (Sheets), gsheets (baca/tulis + cache), gdrive (klien jembatan foto), ocr, ktp (parser & validasi NIK),
              domain, store (CRUD), auth
apps-script/  PhotoGateway.gs — skrip untuk ditempel di project Apps Script Anda
mock/         Dev server lokal dengan Google di-mock (QA tanpa kredensial)
```

## 3. Setup (sekali)

### A. Service Account untuk Google Sheets
1. [console.cloud.google.com](https://console.cloud.google.com) → buat/pilih project → **APIs & Services → Library** → aktifkan **Google Sheets API** (hanya ini).
2. **Credentials → Create credentials → Service account** (nama bebas) → klik akun itu → **Keys → Add key → JSON** → file JSON terunduh.
3. Buka spreadsheet → **Share** → tambahkan email service account (`...@...iam.gserviceaccount.com`) sebagai **Editor**.
4. Catat **Spreadsheet ID** dari URL: `docs.google.com/spreadsheets/d/`**`INI_ID`**`/edit`.

### B. Vercel
1. [vercel.com](https://vercel.com) → **Add New → Project** → pilih repo GitHub ini → Framework **Other** → Deploy.
2. **Settings → Environment Variables** (lihat tabel bagian 4) → **Redeploy**.
3. Region fungsi sudah diatur ke **Singapura (sin1)** lewat `vercel.json` — tidak perlu diubah manual.
4. Buka `https://<app>.vercel.app/api/health` → harus `{"ok":true,"spreadsheet":true,...}`.
5. Login dengan `ADMIN_USERNAME`/`ADMIN_PASSWORD` (akun admin dibuat otomatis) → **Akun → Ganti Password**.

### C. Jembatan Apps Script (untuk foto & baca KTP)
Di project Apps Script lama (yang terikat ke spreadsheet yang sama):

1. **Tambah file**: klik **+** di samping *File* → **Skrip** → namai `PhotoGateway` → tempel seluruh isi [`apps-script/PhotoGateway.gs`](apps-script/PhotoGateway.gs).
2. **Isi kunci**: ganti `GANTI_DENGAN_KUNCI_ACAK_MIN_24_KARAKTER` di baris `PGW_KEY` dengan teks acak buatan Anda (≥ 24 karakter). Jangan dibagikan.
3. **Gabungkan `doPost`**: di `Code.gs` ada `doPost` lama. Ubah menjadi:
   ```js
   function doPost(e) {
     const pg = pgw_tryHandle_(e);   // permintaan jembatan foto (punya field "op")
     if (pg) return pg;
     return handleRequest(e);        // permintaan aplikasi lama
   }
   ```
4. **Tambah layanan Drive** (untuk OCR): sidebar **Layanan (+)** → **Drive API** → **Tambahkan**.
5. **Tulis izin eksplisit di `appsscript.json`** — lihat bagian 5 (langkah ini yang paling sering terlewat).
6. **Beri izin**: di dropdown fungsi pilih **`pgwAuthorize`** → **Jalankan** → **Tinjau izin** → akun Anda → *Advanced → Go to … (unsafe)* → **Izinkan**. (Dialog izin harus memuat 4 izin; bila tidak muncul, ulangi langkah 5.)
7. **Deploy**: **Terapkan → Kelola deployment** → pensil pada Web App → **Versi: Versi baru** → **Terapkan**.
   Pastikan *Jalankan sebagai: Saya* dan *Yang memiliki akses: **Siapa saja***. Salin **URL Web App** (berakhiran `/exec`).
8. **Vercel** → Environment Variables: `APPSCRIPT_PHOTO_URL` = URL tadi, `APPSCRIPT_PHOTO_KEY` = isi `PGW_KEY` → **Redeploy**.
9. Buka `/api/health`: bagian `foto` harus `"ok":true`, `versi` sama dengan nomor terbaru skrip (mis. `6`; bila `lama…` berarti deployment masih memakai kode lama) dan `izin` tidak ada yang `false` untuk `drive`.
10. **Diagnosis OCR tanpa foto**: di editor Apps Script jalankan fungsi `pgwDiag` lalu buka **Log eksekusi** — menampilkan langkah mana yang bekerja/gagal (buat Doc → export Drive → DocumentApp).

## 4. Variabel Environment (Vercel)

| Nama | Type | Wajib | Isi |
|---|---|---|---|
| `GOOGLE_CREDENTIALS` | Secret | ya | Seluruh isi JSON service account, satu baris |
| `SPREADSHEET_ID` | Config | ya | ID spreadsheet |
| `JWT_SECRET` | Secret | ya | Teks acak panjang (`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Config / Secret | ya | Admin pertama (dibuat otomatis saat login pertama) |
| `APPSCRIPT_PHOTO_URL` | Config | untuk foto | URL Web App Apps Script (`.../exec`) |
| `APPSCRIPT_PHOTO_KEY` | Secret | untuk foto | Sama dengan `PGW_KEY` di skrip |
| `OCRSPACE_API_KEY` | Secret | opsional | Cadangan baca KTP gratis dari ocr.space |

Pilih environment **Production** saja. Variabel baru aktif setelah **Redeploy**.

## 5. Izin Apps Script (`appsscript.json`)

Jembatan memerlukan izin **Spreadsheet**, **Drive**, **Google Dokumen** (OCR), dan **email akun**. Bila `appsscript.json` tidak mencantumkan izin secara eksplisit, Google menebak sendiri dan kadang tidak menampilkan dialog untuk izin baru (gejala: *"You do not have permission to call …"*, atau `/api/health` → `foto.izin` ada yang `false`). Cara paling pasti: **tulis izinnya secara eksplisit**. Ganti seluruh isi `appsscript.json` dengan (sesuaikan `timeZone` bila beda):

```json
{
  "timeZone": "Asia/Singapore",
  "dependencies": {
    "enabledAdvancedServices": [
      { "userSymbol": "Drive", "version": "v3", "serviceId": "drive" }
    ]
  },
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8",
  "oauthScopes": [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/userinfo.email"
  ],
  "webapp": { "executeAs": "USER_DEPLOYING", "access": "ANYONE_ANONYMOUS" }
}
```

Lalu: **Simpan** → jalankan **`pgwAuthorize`** (dialog izin kini memuat keempat izin → *Izinkan*) → **Terapkan → Kelola deployment → pensil → Versi baru → Terapkan** → cek `/api/health`.
(Aplikasi Apps Script lama hanya memakai Spreadsheet & Drive, jadi tidak terpengaruh.)

## 6. Fitur

- **User & role**: Admin → *Kelola User* (tambah, ubah, aktif/nonaktif, reset password). Role *User* hanya membaca; aksi tulis ditolak di server. Minimal 1 admin aktif selalu dijaga.
- **PWA**: Android (Chrome) → tombol *Install App*; iPhone (Safari) → Share → *Add to Home Screen*; desktop → ikon install di address bar. Tampilan dasar tersedia offline, data/foto butuh internet.
- **Hari H Pemilihan**: Admin atur di *Atur → Hari H Pemilihan* (tanggal, jam, lokasi, zona WITA) → banner hitung mundur di Dashboard.
- **Foto KTP**: *Kamera* dengan bingkai rasio KTP (hanya isi bingkai yang tersimpan; indikator gelap/silau/buram, senter, zoom) atau *Galeri*; editor putar 90°, miringkan −45°…+45°, zoom, crop rasio KTP/bebas.
- **Baca otomatis Nama & NIK**: OCR bawaan Google Drive lewat jembatan (gratis), cadangan OCR.space. Hasil hanya **mengisi form**; NIK divalidasi (kode wilayah, tanggal lahir, silang-cek dengan tanggal lahir di KTP); NIK yang tidak 16 digit ditolak, bukan ditebak. Foto tak jelas → isi manual.
- **Edit data** memakai kamera berbingkai KTP dan editor putar/crop yang sama dengan halaman Input (termasuk putar/crop foto yang sudah tersimpan).
- **Bila foto gagal diunggah**, data **tetap tersimpan** dengan peringatan; foto bisa diunggah ulang lewat *Edit*. Saat edit, foto lama dibuang hanya setelah foto baru sukses.

## 7. Kinerja

- **Paket ringan `@googleapis/sheets`** (±3 MB, dimuat ±60 ms) menggantikan `googleapis` penuh (±112 MB, dimuat ±1 dtk) → *cold start* fungsi jauh lebih cepat.
- **Login**: satu bacaan sheet Users (ter-cache); pembuatan sheet/admin awal hanya bila Users kosong; catat last-login & log dilakukan bersamaan.
- **Satu permintaan setelah login** (`getBootstrap`): config + dashboard + daftar + versi + badge duplikat + aktivitas terbaru dalam satu panggilan (dulu 5–6 permintaan terpisah).
- **Realtime antar perangkat**: tiap perangkat mengecek `/api/rev` setiap 4 dtk (sidik jari seluruh isi sheet — tambah, hapus, edit, verifikasi, cetak, pengaturan, juga perubahan dari aplikasi Apps Script lama). `/api/rev` di-cache CDN Vercel ±2 dtk sehingga Google Sheets dibaca paling banyak ±1x per 2 dtk berapa pun jumlah perangkat. Bila berubah, data terbaru diambil dalam satu permintaan dan halaman yang sedang dibuka (daftar, dashboard, detail kampung, modal detail) langsung diperbarui — umumnya ±2–6 dtk setelah admin menyimpan. Pengecekan berhenti saat aplikasi di latar belakang dan langsung berjalan saat dibuka kembali.
- **Cache baca sheet** (`lib/gsheets.js`, TTL 5–10 dtk). Bacaan sebelum **menulis** selalu *fresh*. 
- **Region fungsi Singapura** (`"regions": ["sin1"]` di `vercel.json`) — terdekat ke Indonesia.
- **Foto cepat**: URL foto bertanda tangan (HMAC, berganti mingguan, berlaku ≤ 14 hari) → di-cache **CDN Vercel** dan **perangkat** (service worker, dihapus saat logout) + cache memori di server. Foto data di layar dan foto yang disentuh di-*prefetch* sehingga detail tampil instan. URL foto tanpa tanda tangan tetap wajib login.
- **Unduh PDF A4** memakai foto yang sama dari cache (bukan RPC terpisah), unduhan massal 5 foto sekaligus.
- Pustaka PDF/crop `defer`; font tidak memblokir render; service worker men-cache *app shell*.
- Server selalu membalas JSON; bila Vercel memotong/gagal, layar login menampilkan pesan jelas (bukan teks error mentah).
- Kuota Google Sheets 60 baca/menit: bila terlampaui muncul *"Server sedang sibuk"* dan pulih sendiri ±1 menit.

## 8. Diagnosis cepat: `/api/health`

| Yang terlihat | Artinya / tindakan |
|---|---|
| `spreadsheet:false` | `GOOGLE_CREDENTIALS`/`SPREADSHEET_ID` salah, atau spreadsheet belum dibagikan ke service account |
| `foto.catatan: APPSCRIPT_PHOTO_... belum diisi` | Isi dua variabel jembatan di Vercel lalu Redeploy |
| `foto.catatan: ... tidak membalas JSON` | Deploy Web App belum *Siapa saja* / belum versi terbaru / URL bukan `/exec` |
| `foto.catatan: Kunci salah` | `APPSCRIPT_PHOTO_KEY` ≠ `PGW_KEY` di skrip |
| `foto.izin.dokumen/email:false` | Izin kurang → bagian 5 |
| `foto.izin.driveApi:false` | Tambahkan layanan **Drive API** (langkah C4) lalu deploy versi baru |

## 9. Git → Deploy, QA Lokal, Catatan Teknis

```bash
git add -A && git commit -m "..." && git push origin main     # Vercel otomatis deploy
npm install && npm run dev                                     # http://localhost:4173 — admin / admin123 (Google di-mock)
```

- Respons API identik dengan Apps Script lama (`{ok, message, ...}`); `google.script.run` digantikan shim fetch (`public/js/api-shim.js`).
- Sheet `Users` dibuat otomatis; `Pendukung`, `Config`, `Log` lama dipakai apa adanya (dapat dipakai bersamaan dengan aplikasi Apps Script lama).
- Cek duplikat NIK di server pada setiap tambah/ubah; *Scan Duplikat* sebagai jaring pengaman.
- Keamanan: cookie `HttpOnly; SameSite=Lax` 7 hari; rate limit login; security headers via `vercel.json`; `PGW_KEY` hanya di skrip dan di env Vercel (Secret).
