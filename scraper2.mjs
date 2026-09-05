import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import pkg from 'pg';
import dotenv from 'dotenv';
import readline from 'readline';
import axios from 'axios';
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

dotenv.config();
const s3 = new S3Client({
    region: "us-east-1",
    endpoint: process.env.B2_ENDPOINT,
    credentials: {
        accessKeyId: process.env.B2_KEY_ID,
        secretAccessKey: process.env.B2_APPLICATION_KEY,
    },
});

const BUCKET_NAME = process.env.B2_BUCKET_NAME;
const { Pool } = pkg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

puppeteer.use(StealthPlugin());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// AYRIM NOKTASI 2: Scraper 2'ye özel bağımsız kayıt dosyaları
const COOKIE_FILE = path.join(__dirname, "cookies_2.json");
const PENDING_FILE = path.join(__dirname, "pending_2.json");
const COMPLETED_FILE = path.join(__dirname, "completed_2.json");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function waitForKey(mesaj) {
    return new Promise(resolve => rl.question(mesaj, () => resolve()));
}

async function uploadToB2(fileBuffer, fileName, contentType) {
  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: fileName,
    Body: fileBuffer,
    ContentType: contentType,
  });

  await s3.send(command);
  return `https://${BUCKET_NAME}.${process.env.B2_ENDPOINT.replace('https://', '')}/${fileName}`;
}

async function loadCookies(page) {
    if (fs.existsSync(COOKIE_FILE)) {
        try {
            const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
            await page.setCookie(...cookies);
            console.log('🍪 Cookie\'ler yüklendi (Scraper 2).');
            return true;
        } catch (e) { console.log('⚠ Cookie yüklenemedi.'); }
    }
    return false;
}

async function saveCookies(page) {
    try {
        const cookies = await page.cookies();
        fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));
    } catch (e) { console.log('⚠ Cookie kaydedilemedi.'); }
}

function getCompletedMangas() {
    if (fs.existsSync(COMPLETED_FILE)) {
        try { return JSON.parse(fs.readFileSync(COMPLETED_FILE, 'utf8')); } catch { return []; }
    }
    return [];
}

function markAsCompleted(slug) {
    const completed = getCompletedMangas();
    if (!completed.includes(slug)) {
        completed.push(slug);
        fs.writeFileSync(COMPLETED_FILE, JSON.stringify(completed, null, 2), 'utf8');
    }
}

function loadPending(mangaSlug) {
    if (fs.existsSync(PENDING_FILE)) {
        try { 
            const data = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')); 
            return data[mangaSlug] || [];
        } catch { return []; }
    }
    return [];
}

function savePending(mangaSlug, list) {
    let data = {};
    if (fs.existsSync(PENDING_FILE)) {
        try { data = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')); } catch {}
    }
    if (list.length === 0) {
        delete data[mangaSlug]; 
    } else {
        data[mangaSlug] = list;
    }
    fs.writeFileSync(PENDING_FILE, JSON.stringify(data, null, 2));
}

function removePending(mangaSlug, bolumNumarasi) {
    const list = loadPending(mangaSlug).filter(p => p.gercekNumara !== bolumNumarasi);
    savePending(mangaSlug, list);
}

async function isBotProtectionPage(page) {
    return await page.evaluate(() => {
        const title = document.title.toLowerCase();
        const html = document.documentElement.innerHTML.toLowerCase();
        return title.includes('just a moment') || title.includes('checking your browser') || title.includes('attention required') || html.includes('cf-turnstile') || html.includes('cloudflare-challenge') || document.querySelector('input[name="cf-turnstile-response"]') || document.querySelector('#cf-turnstile');
    });
}

async function waitForMangaContent(page, timeout = 15000) {
    try {
        await page.waitForSelector('img, .chapter-list, .manga-title', { timeout });
        return true;
    } catch { return false; }
}

function extractChapterNumber(url) {
    const patterns = [ /(?:bolum|chapter)[-_\/](\d+(?:\.\d+)?)/i, /[-_\/](\d+(?:\.\d+)?)(?:[-_\/]|\.html|$)/i, /bolum[-_]?(\d+(?:\.\d+)?)/i ];
    for (const p of patterns) {
        const m = url.match(p);
        if (m) return parseFloat(m[1]);
    }
    return null;
}

function cleanImageUrl(url) {
    if (!url) return null;
    return url.replace(/[?&](w|width|size|s|resize)=\d+/gi, '').replace(/\?+$/, '');
}

async function downloadAndUploadToB2(url, b2FileName, cookieString) {
    let attempt = 1;
    while (true) {
        try {
            const response = await axios({
                method: 'get',
                url: url,
                responseType: 'arraybuffer',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
                    'Referer': 'https://okutoon.com/',
                    'Cookie': cookieString
                },
                timeout: 30000,
                maxRedirects: 5
            });

            const fileBuffer = Buffer.from(response.data);
            const contentType = response.headers['content-type'] || 'image/jpeg';
            
            const fileUrl = await uploadToB2(fileBuffer, b2FileName, contentType);
            return fileUrl;
        } catch (err) {
            console.log(`⚠ Resim yüklenemedi (Deneme ${attempt}): ${err.message}. Tekrar deneniyor...`);
            attempt++;
            await new Promise(r => setTimeout(r, 5000 + Math.random() * 3000));
        }
    }
}

async function batchInsertPages(client, chapterId, pages) {
    if (!pages.length) return;
    const placeholders = pages.map((_, i) => `($1, $${i * 2 + 2}, $${i * 2 + 3})`).join(',');
    const values = [chapterId, ...pages.flatMap(p => [p.page_number, p.image_path])];
    await client.query(
        `INSERT INTO pages(chapter_id, page_number, image_path) VALUES ${placeholders} ON CONFLICT DO NOTHING`,
        values
    );
}

async function topluMangaAktar(page, mangaSlug, mangaBaslik) {
    const anaSayfaUrl = `https://okutoon.com/${mangaSlug}`;
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📖 Hedef Manga: ${mangaBaslik}\n🔗 Ana Sayfa: ${anaSayfaUrl}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

    console.log('📄 Manga ana sayfası açılıyor...');
    await page.goto(anaSayfaUrl, { waitUntil: 'networkidle2', timeout: 90000 });
    
    const anaSayfaBekleme = 5000 + Math.floor(Math.random() * 3000);
    await new Promise(r => setTimeout(r, anaSayfaBekleme));

    if (await isBotProtectionPage(page)) {
        console.log('\n🤖 BOT KORUMASI ALGILANDI!');
        await waitForKey('\n✅ Doğrulamayı manuel tamamlayıp ENTER tuşuna basın...');
        await saveCookies(page);
    }

    if (!await waitForMangaContent(page, 30000)) {
        console.error('\n❌ Sayfa içeriği 30 saniye içinde yüklenemedi!');
        await waitForKey('Devam etmek için manuel olarak sayfayı kontrol et ve ENTER tuşuna bas...');
    }

    let mangaQuery = await pool.query("SELECT id FROM mangas WHERE slug = $1", [mangaSlug]);
    let mangaId;
    if (!mangaQuery.rowCount) {
        const insert = await pool.query(
            `INSERT INTO mangas(title, slug, author, description, genres, rating, featured, published) VALUES($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [mangaBaslik, mangaSlug, 'Bilinmiyor', 'Otomatik çekildi', '{}', 0, false, true]
        );
        mangaId = insert.rows[0].id;
    } else {
        mangaId = mangaQuery.rows[0].id;
        await pool.query("UPDATE mangas SET title = $1 WHERE id = $2", [mangaBaslik, mangaId]);
    }

    const hamLinkler = await page.evaluate(() => {
        const links = new Set();
        document.querySelectorAll('a').forEach(a => {
            if (a.href && (a.href.includes('bolum') || a.href.includes('chapter'))) links.add(a.href);
        });
        return Array.from(links);
    });

    if (hamLinkler.length === 0) {
        console.error('❌ Sayfada hiç bölüm bulunamadı!');
        return false; 
    }

    const bolumlerListesi = hamLinkler.map(url => ({ url, gercekNumara: extractChapterNumber(url) })).filter(b => b.gercekNumara !== null).sort((a, b) => a.gercekNumara - b.gercekNumara);
    const seen = new Set();
    const uniqueBolumler = bolumlerListesi.filter(b => {
        if (seen.has(b.gercekNumara)) return false;
        seen.add(b.gercekNumara); return true;
    });

    const kayitliBolumler = await pool.query("SELECT chapter_number FROM chapters WHERE manga_id = $1", [mangaId]);
    const kayitliSet = new Set(kayitliBolumler.rows.map(r => Number(r.chapter_number)));

    let pending = loadPending(mangaSlug);
    let islenecekListe = uniqueBolumler.filter(b => !kayitliSet.has(b.gercekNumara));

    if (pending.length > 0) {
        const pendingNumbers = new Set(pending.map(p => p.gercekNumara));
        islenecekListe = [...pending.filter(p => !kayitliSet.has(p.gercekNumara)), ...islenecekListe.filter(b => !pendingNumbers.has(b.gercekNumara))];
    }

    if (islenecekListe.length === 0) {
        console.log('🎉 Bu manganın tüm bölümleri güncel!');
        savePending(mangaSlug, []);
        return true;
    }

    const cookieString = (await page.cookies()).map(c => `${c.name}=${c.value}`).join('; ');
    let consecutiveBotHits = 0;
    const MAX_BOT_HITS = 3;
    const newPending = [];

    for (let idx = 0; idx < islenecekListe.length; idx++) {
        const bolum = islenecekListe[idx];
        const bolumNumarasi = bolum.gercekNumara;
        const bolumBaslik = `Bölüm ${bolumNumarasi}`;
        console.log(`[${idx + 1}/${islenecekListe.length}] 📖 ${bolumBaslik} indiriliyor...`);

        try {
            await page.goto(bolum.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
            
            const bolumBekleme = 7000 + Math.floor(Math.random() * 4000);
            await new Promise(r => setTimeout(r, bolumBekleme));

            if (await isBotProtectionPage(page)) {
                await waitForKey('🤖 Bot koruması! Doğrulamayı yapıp ENTER basın...');
                await saveCookies(page);
                consecutiveBotHits++;
                if (consecutiveBotHits >= MAX_BOT_HITS) {
                    newPending.push(...islenecekListe.slice(idx)); 
                    savePending(mangaSlug, newPending); 
                    return false;
                }
                idx--; continue;
            } else { consecutiveBotHits = 0; }

            const resimLinkleri = await page.evaluate(() => {
                return [...new Set(Array.from(document.querySelectorAll('img')).map(img => {
                    let src = img.src || img.getAttribute('data-src') || img.getAttribute('data-original') || img.getAttribute('data-lazy-src');
                    if (src && !src.startsWith('data:image') && src.match(/\.(webp|jpg|png|jpeg)/i) && !src.match(/(logo|avatar|icon|banner)/i)) {
                        return src.trim().startsWith('//') ? 'https:' + src.trim() : src.trim();
                    }
                }).filter(Boolean))];
            });

            const cleanLinks = resimLinkleri.map(cleanImageUrl).filter(Boolean);
            if (cleanLinks.length === 0) { newPending.push(bolum); continue; }

            const client = await pool.connect();
            let chapterId;
            try {
                await client.query("BEGIN");
                const chInsert = await client.query("INSERT INTO chapters(manga_id, title, chapter_number) VALUES($1, $2, $3) RETURNING id", [mangaId, bolumBaslik, bolumNumarasi]);
                chapterId = chInsert.rows[0].id;

                const batchSize = 5;
                const downloadedPages = [];
                let gercekSayfaNo = 1;

                for (let i = 0; i < cleanLinks.length; i += batchSize) {
                    const batch = cleanLinks.slice(i, i + batchSize);
                    const batchResults = await Promise.allSettled(batch.map(async (url) => {
                        const safeExt = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(path.extname(url.split('?')[0]).toLowerCase()) ? path.extname(url.split('?')[0]).toLowerCase() : '.webp';
                        
                        const b2FileName = `chapters/${mangaSlug}/bolum-${bolumNumarasi}/${crypto.randomBytes(16).toString("hex")}${safeExt}`;
                        
                        await downloadAndUploadToB2(url, b2FileName, cookieString);
                        return b2FileName; 
                    }));

                    for (const result of batchResults) {
                        if (result.status === 'fulfilled') downloadedPages.push({ page_number: gercekSayfaNo++, image_path: result.value });
                    }
                }
                await batchInsertPages(client, chapterId, downloadedPages);
                await client.query("COMMIT");
                console.log(`✅ ${bolumBaslik} tamamlandı! (${downloadedPages.length} sayfa buluta yüklendi)`);
                removePending(mangaSlug, bolumNumarasi);

            } catch (err) {
                await client.query("ROLLBACK");
                newPending.push(bolum);
            } finally { client.release(); }
        } catch (bolumErr) { newPending.push(bolum); }
    }
    
    if (newPending.length > 0) savePending(mangaSlug, newPending);
    else savePending(mangaSlug, []); 
    return true;
}

// SCRAPER 2 MANGALARI
const mangaListesi = [
    { slug: 'wind-breaker-haruka-sakura', baslik: 'Wind breaker haruka sakura' }, 
    { slug: 'supremely-talented-player', baslik: 'Supremely Talented Player' },
    { slug: 'reincarnator', baslik: 'Reincarnator' },
    { slug: 'spy-x-family', baslik: 'Spy x Family' },
    { slug: 'regressor-instruction-manual', baslik: 'Regressor Instruction Manual' },
    { slug: 'fff-class-trashero', baslik: 'FFF Class Trashero' },
    { slug: 'Star-Embracing-Swordmaster', baslik: 'Star Embracing Swordmaster' },
    { slug: 'the-world-s-strongest-are-obsessed-with-me', baslik: 'The World\'s Strongest Are Obsessed with Me' },
    { slug: 'solo-farming-in-the-tower', baslik: 'Solo Farming in the Tower' },
    { slug: 'reality-quest', baslik: 'Reality Quest' },
    { slug: 'solo-leveling', baslik: 'Solo Leveling' },
    { slug: 'magic-emperor', baslik: 'Magic Emperor' },
    { slug: 'leveling-with-the-gods', baslik: 'Leveling with the Gods' },
    { slug: 'solo-leveling-ragnarok', baslik: 'Solo Leveling Ragnarok' },
    { slug: 'return-of-the-crazy-demon', baslik: 'Return of the Crazy Demon' },
    { slug: 'rooftop-sword-master', baslik: 'Rooftop Sword Master' }
];

async function baslat() {
    console.log('\n🚀 Scraper 2 Başlatılıyor...\n');
    const userDataPath = path.join(__dirname, 'chrome_profil_2');
    const browser = await puppeteer.launch({ headless: false, userDataDir: userDataPath, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await loadCookies(page);

    const completedMangas = getCompletedMangas();
    for (const manga of mangaListesi) {
        if (completedMangas.includes(manga.slug)) {
            console.log(`⏩ [ATLANDI] "${manga.baslik}" önceden bitmiş.`); continue;
        }
        const success = await topluMangaAktar(page, manga.slug, manga.baslik);
        if (success) { markAsCompleted(manga.slug); console.log(`[✔] "${manga.baslik}" işlemleri tamam.\n`); } 
        else break;
    }
    console.log("\n🎉 Scraper 2 Bitti!");
    await browser.close(); await pool.end(); rl.close();
}
baslat();