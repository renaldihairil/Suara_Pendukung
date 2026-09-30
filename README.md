# Data Pendukung Pilkades — PWA (Admin & User)

Transformasi aplikasi Google Apps Script menjadi **PWA yang bisa di-install** di Android, iPhone, dan desktop, di-hosting di **Vercel** (auto-deploy dari GitHub), dengan:

- **2 interface**: **Admin** (CRUD penuh, verifikasi, cetak, pengaturan, kelola user, log) dan **User** (read-only: lihat dashboard, cari/filter data, lihat foto).
- **Database tetap Google Sheets** + **foto tetap di Google Drive** — diakses via Service Account, **tanpa memindahkan data lama**.
- **Login per orang** (username + password, bcrypt, JWT cookie httpOnly). Password bersama lama dipensiunkan.
- **Foto KTP/TTD tidak lagi publik** — hanya lewat proxy `/api/photo` yang wajib login.

---

## 1. Struktur Proyek

```
public/          Frontend (PWA): index.html, css/, js/, manifest, sw.js, ikon, vendor
api/             Serverless functions Vercel:
                 auth.js   → login/logout/cek sesi (+ rate limit)
                 rpc.js    → semua action (list, add, update, delete, verify, config, users, log)
                 photo.js  → proxy foto Drive ter-autentikasi
                 health.js → cek koneksi spreadsheet
lib/             Logika inti: gauth, gsheets, gdrive, domain (parse NIK dll),
                 store (CRUD), auth (JWT, bcrypt, manajemen user)
legacy/          Kode Apps Script lama (arsip referensi, tidak ikut deploy)
mock/            Dev server lokal dengan Google di-mock (untuk QA tanpa kredensial)
```

## 2. Setup Google Cloud (sekali, ±15 menit)

1. Buka [console.cloud.google.com](https://console.cloud.google.com) → buat project (mis. `pendukung-pilkades`).
2. **APIs & Services → Library** → aktifkan **Google Sheets API** dan **Google Drive API**.
3. **APIs & Services → Credentials → Create Credentials → Service account**.
   - Nama bebas (mis. `pendukung-bot`), role tidak perlu khusus → selesai.
4. Klik service account itu → tab **Keys → Add key → Create new key → JSON** → file JSON terunduh.
5. **Bagikan spreadsheet** Anda: klik **Share** di spreadsheet → tambahkan email service account
   (`pendukung-bot@<project>.iam.gserviceaccount.com`) sebagai **Editor**.
6. **Bagikan 2 folder Drive**: `FOTO_KTP_PENDUKUNG_2026` dan `FOTO_BUKTI_TTD_2026`
   (klik kanan folder → Share → email service account sebagai **Editor**).
   > Jika folder belum ada, aplikasi akan membuatnya otomatis — pastikan folder induk/akun bisa dibuat.
7. Catat **Spreadsheet ID** dari URL: `docs.google.com/spreadsheets/d/`**`INI_ID`**`/edit`.

## 3. Deploy ke Vercel

1. **Push repo ini ke GitHub** (lihat bagian 6).
2. Di [vercel.com](https://vercel.com) → **Add New → Project** → pilih repo → **Import**.
   - Framework Preset: **Other** (biarkan default, tidak perlu build command).
3. **Environment Variables** — tambahkan (copy dari `.env.example`):

   | Nama | Isi |
   |---|---|
   | `GOOGLE_CREDENTIALS` | Seluruh isi file JSON service account **dalam satu baris** |
   | `SPREADSHEET_ID` | ID spreadsheet dari langkah 2.7 |
   | `JWT_SECRET` | Kunci acak panjang — buat dengan `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
   | `ADMIN_USERNAME` | Username admin pertama (mis. `admin`) |
   | `ADMIN_PASSWORD` | Password admin pertama (kuat! akun ini dibuat otomatis saat login pertama) |

4. **Deploy** → setelah selesai, buka `https://<app>.vercel.app/api/health` → harus `{"ok":true,...}`.
5. Login dengan `ADMIN_USERNAME`/`ADMIN_PASSWORD` → akun admin otomatis dibuat di sheet **Users**.
   **Segera ganti password** lewat halaman **Akun → Ganti Password**.

## 4. Manajemen User & Role

- Admin: **👥 Kelola User** → tambah user (username, nama, role, password), edit, aktif/nonaktifkan, reset password.
- Role **User**: hanya lihat Dashboard + Data (cari, filter, detail, foto). Semua aksi tulis **ditolak di server** (bukan hanya disembunyikan).
- Role **Admin**: akses penuh + lihat **📋 Log Aktivitas** (login, add, update, delete, verify, cetak, perubahan config, percobaan aksi yang ditolak).
- Minimal 1 admin aktif selalu dijaga (tidak bisa dinonaktifkan/diturunkan semua).

## 5. PWA — Install di Perangkat

- **Android (Chrome)**: buka app → muncul tombol **⬇️ Install App** (atau menu ⋮ → *Install app*).
- **Desktop (Chrome/Edge)**: ikon install di address bar, atau tombol install di app.
- **iPhone (Safari)**: Share → **Add to Home Screen**.
- App shell tampil saat offline (halaman offline ramah); data/foto tetap butuh internet.

## 5b. Hari H Pemilihan

Admin menetapkan jadwal di **Atur → Hari H Pemilihan** (nama acara, tanggal, jam & lokasi opsional). Seluruh tim melihat **banner hitung mundur** ("12 hari lagi") di Dashboard; warnanya berubah oranye saat H-7 dan hijau di hari-H. Jadwal disimpan di sheet `Config` (tanpa sheet tambahan) dan memakai zona **WITA**. Tidak ada notifikasi/pengingat otomatis.

### Kuota Google Sheets API
Google membatasi **60 permintaan baca per menit** per proyek. Aplikasi sudah dihemat: sheet dibaca berkelompok (`batchGet`), versi data di-cache 15 dtk, cek perubahan data tiap 30 dtk, dan pengecekan struktur sheet hanya sekali per 10 menit. Bila kuota tetap terlampaui, aplikasi menampilkan pesan *"Server sedang sibuk"* dan pulih sendiri dalam ±1 menit (Cloud Console → *APIs & Services → Sheets API → Quotas* bila ingin menaikkan batas).

## 5c. Foto KTP: kamera berbingkai, putar/crop, baca otomatis Nama & NIK

- **Kamera** (Input → Kamera): kamera langsung dengan bingkai rasio KTP (85,6 × 53,98 mm); yang tersimpan hanya isi bingkai. Ada indikator kualitas (gelap/silau/buram), senter & zoom bila didukung perangkat. Bila izin kamera ditolak, otomatis memakai kamera bawaan HP.
- **Galeri / Putar / Crop**: editor dengan putar 90°, miringkan bebas −45°…+45°, zoom, crop rasio KTP atau bebas. Tombol **Putar / Crop** di bawah foto membuka ulang editor dari foto asli.
- **Baca otomatis Nama & NIK**: setelah foto final, server membaca KTP memakai **Google Cloud Vision** (OCR) lalu `lib/ktp.js` menguraikan & memvalidasi NIK (kode wilayah, tanggal lahir, silang-cek dengan tanggal lahir di KTP). Hasil hanya **mengisi form** — tetap diperiksa manual sebelum Simpan. Bila tak yakin/foto kurang jelas, pengguna diminta isi manual.
- **Mengaktifkan OCR (sekali)**: di Google Cloud Console project yang sama dengan Service Account → *APIs & Services → Library* → aktifkan **Cloud Vision API** (perlu billing aktif; gratis 1.000 gambar/bulan pertama). Tidak ada variabel env baru. Bila belum aktif, aplikasi tetap berjalan dan menampilkan "isi manual".
- **Tanpa billing Google? Pakai OCR.space (gratis, tanpa kartu)**: daftar API key gratis di ocr.space, lalu di Vercel → Settings → Environment Variables tambahkan `OCRSPACE_API_KEY` (Redeploy). Bila Google Vision belum bisa dipakai (billing/API belum aktif), aplikasi otomatis memakai OCR.space; `OCR_PROVIDER=ocrspace` memaksa OCR.space saja. Akurasi OCR.space di bawah Google Vision, tetapi validasi NIK tetap menolak hasil yang tidak wajar.
- Foto KTP gagal diunggah ke Google Drive **tidak lagi membatalkan simpan data** (data tersimpan + peringatan; foto bisa diunggah ulang lewat Edit). Saat edit, foto lama dibuang hanya setelah foto baru sukses.
- Privasi: foto KTP dikirim ke Google Vision hanya untuk dibaca; aplikasi tidak menyimpan hasil OCR.

## 6. Alur Kerja Git → Deploy

```bash
git add -A
git commit -m "PWA: admin & user, sheets backend, pwa"
git push origin main          # Vercel otomatis deploy
```

## 7. QA Lokal Tanpa Kredensial Google

```bash
npm install
npm run dev        # http://localhost:4173 — login: admin / admin123
```

Server ini menjalankan **handler API asli** dengan Google Sheets/Drive di-mock di memori — cocok untuk uji UI/alur tanpa menyentuh data produksi.

## 8. Catatan Teknis Penting

- **Respons API identik dengan Apps Script lama** (`{ok, message, ...}`), frontend lama hampir tanpa perubahan logika; `google.script.run` digantikan shim fetch (`public/js/api-shim.js`).
- **Sheet baru `Users`** dibuat otomatis: `ID | Username | PasswordHash | Nama | Role | Aktif | CreatedAt | LastLogin`. Data `Pendukung`, `Config`, `Log` lama tetap dipakai apa adanya (Log kini berkolom `Username` — baris lama tetap aman dibaca).
- **Race condition**: cek duplikat NIK tetap server-side pada setiap add/update; fitur Scan Duplikat menjadi jaring pengaman.
- **Batas ukuran**: payload RPC maks ±15 MB (foto sudah dikompresi + crop di client).
- **Keamanan**: cookie `HttpOnly; SameSite=Lax` 7 hari; rate limit login (10 gagal → blokir 10 menit); security headers via `vercel.json`; foto `Cache-Control: no-store`.
