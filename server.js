const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure uploads directory exists
if (!fs.existsSync('/uploads')) fs.mkdirSync('/uploads');

// Multer config for file uploads
const storage = multer.diskStorage({
  destination: '/uploads/',
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  },
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB

app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('/uploads'));

// ── Trips ──────────────────────────────────────────────────────────────────

app.get('/api/trips', (req, res) => {
  const trips = db.prepare(`
    SELECT t.*,
           COUNT(DISTINCT l.id) AS landmark_count,
           COUNT(DISTINCT p.id) AS photo_count
    FROM trips t
    LEFT JOIN landmarks l ON l.trip_id = t.id
    LEFT JOIN photos p ON p.trip_id = t.id
    GROUP BY t.id
    ORDER BY t.start_date DESC
  `).all();
  res.json(trips);
});

app.post('/api/trips', upload.single('cover_photo'), (req, res) => {
  const { title, destination, start_date, end_date, description, weather } = req.body;
  const cover_photo = req.file ? req.file.filename : null;
  const result = db.prepare(`
    INSERT INTO trips (title, destination, start_date, end_date, description, weather, cover_photo)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run([title, destination, start_date, end_date, description || '', weather || '', cover_photo]);
  res.json({ id: result.lastInsertRowid });
});

app.get('/api/trips/:id', (req, res) => {
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get([req.params.id]);
  if (!trip) return res.status(404).json({ error: 'Not found' });
  const landmarks = db.prepare('SELECT * FROM landmarks WHERE trip_id = ? ORDER BY date_visited ASC, id ASC').all([req.params.id]);
  const photos = db.prepare('SELECT * FROM photos WHERE trip_id = ? ORDER BY uploaded_at ASC').all([req.params.id]);
  res.json({ ...trip, landmarks, photos });
});

app.put('/api/trips/:id', upload.single('cover_photo'), (req, res) => {
  const { title, destination, start_date, end_date, description, weather, remove_cover } = req.body;
  const existing = db.prepare('SELECT * FROM trips WHERE id = ?').get([req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  let cover_photo = existing.cover_photo;

  if (remove_cover === 'true' && cover_photo) {
    try { fs.unlinkSync(`/uploads/${cover_photo}`); } catch {}
    cover_photo = null;
  }

  if (req.file) {
    if (cover_photo) {
      try { fs.unlinkSync(`/uploads/${cover_photo}`); } catch {}
    }
    cover_photo = req.file.filename;
  }

  db.prepare(`
    UPDATE trips SET title=?, destination=?, start_date=?, end_date=?, description=?, weather=?, cover_photo=?
    WHERE id=?
  `).run([title, destination, start_date, end_date, description || '', weather || '', cover_photo, req.params.id]);

  res.json({ success: true });
});

app.delete('/api/trips/:id', (req, res) => {
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get([req.params.id]);
  if (!trip) return res.status(404).json({ error: 'Not found' });

  if (trip.cover_photo) {
    try { fs.unlinkSync(`/uploads/${trip.cover_photo}`); } catch {}
  }

  const photos = db.prepare('SELECT * FROM photos WHERE trip_id = ?').all([req.params.id]);
  photos.forEach(p => { try { fs.unlinkSync(`/uploads/${p.filename}`); } catch {} });

  db.prepare('DELETE FROM photos WHERE trip_id = ?').run([req.params.id]);
  db.prepare('DELETE FROM landmarks WHERE trip_id = ?').run([req.params.id]);
  db.prepare('DELETE FROM trips WHERE id = ?').run([req.params.id]);

  res.json({ success: true });
});

// ── Landmarks ──────────────────────────────────────────────────────────────

app.post('/api/trips/:id/landmarks', (req, res) => {
  const { name, date_visited, description, category } = req.body;
  const result = db.prepare(`
    INSERT INTO landmarks (trip_id, name, date_visited, description, category)
    VALUES (?, ?, ?, ?, ?)
  `).run([req.params.id, name, date_visited || '', description || '', category || 'landmark']);
  const landmark = db.prepare('SELECT * FROM landmarks WHERE id = ?').get([result.lastInsertRowid]);
  res.json(landmark);
});

app.put('/api/landmarks/:id', (req, res) => {
  const { name, date_visited, description, category } = req.body;
  db.prepare(`
    UPDATE landmarks SET name=?, date_visited=?, description=?, category=? WHERE id=?
  `).run([name, date_visited || '', description || '', category || 'landmark', req.params.id]);
  res.json({ success: true });
});

app.delete('/api/landmarks/:id', (req, res) => {
  db.prepare('DELETE FROM landmarks WHERE id = ?').run([req.params.id]);
  res.json({ success: true });
});

// ── Photos ─────────────────────────────────────────────────────────────────

app.post('/api/trips/:id/photos', upload.array('photos', 50), (req, res) => {
  const stmt = db.prepare(`INSERT INTO photos (trip_id, filename, caption) VALUES (?, ?, ?)`);
  const results = req.files.map(f => {
    const result = stmt.run([req.params.id, f.filename, '']);
    return { id: result.lastInsertRowid, filename: f.filename, caption: '' };
  });
  res.json(results);
});

app.put('/api/photos/:id', (req, res) => {
  const { caption } = req.body;
  db.prepare('UPDATE photos SET caption=? WHERE id=?').run([caption, req.params.id]);
  res.json({ success: true });
});

app.delete('/api/photos/:id', (req, res) => {
  const photo = db.prepare('SELECT * FROM photos WHERE id = ?').get([req.params.id]);
  if (!photo) return res.status(404).json({ error: 'Not found' });
  try { fs.unlinkSync(`/uploads/${photo.filename}`); } catch {}
  db.prepare('DELETE FROM photos WHERE id = ?').run([req.params.id]);
  res.json({ success: true });
});

// ── Geocoding proxy (Nominatim/OSM, cached in-memory) ──────────────────────

const geocodeCache = new Map();

app.get('/api/geocode', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'missing q' });
  if (geocodeCache.has(q)) return res.json(geocodeCache.get(q));
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`,
      { headers: { 'User-Agent': 'TheVirginPuff/1.0 (family travel journal)' } }
    );
    const data = await r.json();
    if (data[0]) {
      const result = { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
      geocodeCache.set(q, result);
      return res.json(result);
    }
    res.status(404).json({ error: 'not found' });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── Landmark image proxy (fetches Wikipedia, no browser CORS issues) ───────

app.get('/api/landmark/:page', async (req, res) => {
  try {
    const r = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(req.params.page)}`
    );
    const d = await r.json();
    const src = d.thumbnail?.source;
    if (!src) return res.status(404).json({ error: 'no image' });
    // Request a larger thumbnail from Wikimedia CDN
    const url = src.replace(/\/\d+px-/, '/800px-');
    res.json({ url });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n✈  The Virgin Puff is running at http://localhost:${PORT}\n`);
});
