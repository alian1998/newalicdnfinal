const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const crypto = require('crypto');
const sharp = require('sharp');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());

// Envs
const PORT = process.env.PORT || 3000;
const MAIN_BACKEND_URL = process.env.MAIN_BACKEND_URL || 'https://your-main-backend.com';
const CDN_DOMAIN = process.env.CDN_DOMAIN || 'https://cdn.yourdomain.com';
const CDN_SECRET_KEY = process.env.CDN_SECRET_KEY || 'my_super_secret_key';

// Directory & Database Paths
const STORAGE_DIR = path.join(__dirname, 'storage', 'images');
const DB_DIR = path.join(__dirname, 'storage', 'db');

if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(path.join(DB_DIR, 'cdn.db'));

// Database Schema Initializer
db.exec(`
  CREATE TABLE IF NOT EXISTS image_map (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_url TEXT UNIQUE,
    hash_id TEXT UNIQUE,
    cdn_url TEXT,
    status TEXT DEFAULT 'active',
    last_seen_at DATETIME
  );
  CREATE TABLE IF NOT EXISTS meta_info (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Authentication Middleware
const authCheck = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== CDN_SECRET_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// Sync Function Logic
async function syncBackendImages() {
  console.log('[CDN Sync] Checking for backend updates...');
  try {
    const versionRow = db.prepare("SELECT value FROM meta_info WHERE key = 'last_version'").get();
    const lastVersion = versionRow ? versionRow.value : '';

    const checkRes = await axios.get(`${MAIN_BACKEND_URL}/api/v1/image-export/check?since=${lastVersion}`);
    if (!checkRes.data || !checkRes.data.hasChanges) {
      console.log('[CDN Sync] No changes detected.');
      return;
    }

    const manifestRes = await axios.get(`${MAIN_BACKEND_URL}/api/v1/image-export/manifest`);
    const sourceImages = manifestRes.data.images || [];

    const upsertStmt = db.prepare(`
      INSERT INTO image_map (source_url, hash_id, cdn_url, status, last_seen_at)
      VALUES (?, ?, ?, 'active', CURRENT_TIMESTAMP)
      ON CONFLICT(source_url) DO UPDATE SET
        status = 'active',
        last_seen_at = CURRENT_TIMESTAMP
    `);

    for (const sourceUrl of sourceImages) {
      const hash = crypto.createHash('md5').update(sourceUrl).digest('hex');
      const filename = `${hash}.webp`;
      const filePath = path.join(STORAGE_DIR, filename);

      if (!fs.existsSync(filePath)) {
        try {
          const response = await axios.get(sourceUrl, { responseType: 'arraybuffer' });
          await sharp(response.data).webp({ quality: 80 }).toFile(filePath);
        } catch (err) {
          console.error(`[CDN Sync] Failed to download image: ${sourceUrl}`);
          continue;
        }
      }

      const cdnUrl = `${CDN_DOMAIN}/images/${filename}`;
      upsertStmt.run(sourceUrl, hash, cdnUrl);
    }

    // Handle Removed Images
    if (sourceImages.length > 0) {
      const placeholders = sourceImages.map(() => '?').join(',');
      db.prepare(`
        UPDATE image_map 
        SET status = 'deleted' 
        WHERE source_url NOT IN (${placeholders})
      `).run(...sourceImages);
    }

    // Save current version
    if (checkRes.data.currentVersion) {
      db.prepare(`
        INSERT INTO meta_info (key, value) VALUES ('last_version', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(String(checkRes.data.currentVersion));
    }

    console.log('[CDN Sync] Sync completed successfully.');
  } catch (error) {
    console.error('[CDN Sync Error]:', error.message);
  }
}

// Cron Job: Every 15 minutes
cron.schedule('*/15 * * * *', () => {
  syncBackendImages();
});

// API Endpoints
app.get('/api/cdn-image-map', authCheck, (req, res) => {
  const sourceUrl = req.query.source;
  if (!sourceUrl) return res.status(400).json({ error: 'Source URL is required' });

  const record = db.prepare("SELECT cdn_url, status FROM image_map WHERE source_url = ?").get(sourceUrl);
  if (record && record.status === 'active') {
    return res.json({ found: true, cdnUrl: record.cdn_url });
  }
  return res.json({ found: false, cdnUrl: null });
});

app.post('/api/cdn-image-map/bulk', authCheck, (req, res) => {
  const { sourceUrls } = req.body;
  if (!Array.isArray(sourceUrls)) return res.status(400).json({ error: 'sourceUrls must be an array' });

  const result = {};
  const stmt = db.prepare("SELECT cdn_url, status FROM image_map WHERE source_url = ?");

  for (const url of sourceUrls) {
    const record = stmt.get(url);
    if (record && record.status === 'active') {
      result[url] = record.cdn_url;
    } else {
      result[url] = null;
    }
  }

  return res.json({ found: true, data: result });
});

// Serve Static Files
app.use('/images', express.static(STORAGE_DIR, {
  maxAge: '30d',
  immutable: true
}));

app.listen(PORT, () => {
  console.log(`CDN Server running on port ${PORT}`);
  syncBackendImages();
});