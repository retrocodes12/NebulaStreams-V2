const fs = require('fs');
const path = require('path');

const providersDir = './providers';
const manifestFile = './manifest.json';

// 1. Baca Manifest yang sudah ada
let manifest = {};
try {
    const data = fs.readFileSync(manifestFile, 'utf8');
    manifest = JSON.parse(data);
} catch (err) {
    console.error("Gagal membaca manifest.json:", err);
    process.exit(1);
}

// 2. Baca semua file di folder providers
const files = fs.readdirSync(providersDir).filter(file => file.endsWith('.js'));

let changesMade = false;

files.forEach(file => {
    const filename = `providers/${file}`;
    const id = file.replace('.js', '');
    // Buat nama yang cantik (contoh: kisskh.js -> Kisskh)
    const name = id.charAt(0).toUpperCase() + id.slice(1);

    // Cek apakah file ini sudah ada di manifest
    const exists = manifest.scrapers.some(scraper => scraper.filename === filename);

    if (!exists) {
        console.log(`Menambahkan scraper baru: ${file}`);
        
        // Template default untuk scraper baru
        const newEntry = {
            id: id,
            name: name,
            description: `Auto-generated description for ${name}`,
            version: "1.0.0",
            author: "Michat88",
            supportedTypes: ["movie", "tv"],
            filename: filename,
            enabled: true,
            formats: ["mp4", "m3u8"],
            logo: "https://via.placeholder.com/150", // Logo sementara
            contentLanguage: ["en"]
        };

        manifest.scrapers.push(newEntry);
        changesMade = true;
    }
});

// 3. Simpan kembali jika ada perubahan
if (changesMade) {
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
    console.log("Manifest.json berhasil diperbarui!");
} else {
    console.log("Tidak ada scraper baru untuk ditambahkan.");
}
