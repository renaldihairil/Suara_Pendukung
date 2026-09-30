'use strict';
/* Generate pasangan kunci VAPID untuk Web Push.
 * Jalankan:  npm run vapid
 * Lalu salin ke Vercel → Settings → Environment Variables. */
const webpush = require('web-push');
const k = webpush.generateVAPIDKeys();
console.log('\nTambahkan ke Environment Variables (Vercel) atau .env lokal:\n');
console.log('VAPID_PUBLIC_KEY=' + k.publicKey);
console.log('VAPID_PRIVATE_KEY=' + k.privateKey);
console.log('VAPID_SUBJECT=mailto:emailanda@contoh.com\n');
console.log('JANGAN commit VAPID_PRIVATE_KEY. Setelah diisi, redeploy aplikasi.\n');
