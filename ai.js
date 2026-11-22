const Jimp = require('jimp');
const sightengine = require('sightengine')(
  process.env.SIGHTENGINE_API_USER,
  process.env.SIGHTENGINE_API_SECRET
);

/* ---------- Perceptual hash (dHash, 64-bit) ---------- */
async function computeDHash(buffer) {
  try {
    const img = await Jimp.read(buffer);
    img.resize(9, 8).grayscale();
    const bits = [];
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const l = img.getPixelIndex(x, y);
        const r = img.getPixelIndex(x + 1, y);
        bits.push(img.bitmap.data[l] < img.bitmap.data[r] ? 1 : 0);
      }
    }
    let hex = '';
    for (let i = 0; i < 64; i += 4) {
      hex += ((bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3]).toString(16);
    }
    return hex;
  } catch { return null; }
}

function hammingDistance(a, b) {
  if (!a || !b || a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

/* ---------- Sightengine: real AI-generated detection ---------- */
async function checkAIGenerated(buffer, mimeType) {
  const user = process.env.SIGHTENGINE_API_USER;
  const secret = process.env.SIGHTENGINE_API_SECRET;
  if (!user || !secret) {
    return { available: false, score: null, flagged: false, reason: 'Sightengine credentials not configured' };
  }
  const threshold = parseFloat(process.env.AI_FLAG_THRESHOLD || '0.5');
  try {
    const response = await sightengine
      .check(['genai'])
      .set_bytes(buffer, mimeType || 'image/jpeg');

    if (response?.status !== 'success') {
      return {
        available: false, score: null, flagged: false,
        reason: `Sightengine error: ${response?.error?.message || 'unknown error'}`
      };
    }

    /* genai model returns score under `type.ai_generated` — accept legacy `genai.ai_generated` too */
    const raw =
      response?.type?.ai_generated ??
      response?.genai?.ai_generated ??
      response?.ai_generated;
    const score = Number(raw);

    if (!Number.isFinite(score)) {
      return {
        available: false, score: null, flagged: false,
        reason: `Sightengine: score missing`
      };
    }

    const flagged = score > threshold;
    return {
      available: true,
      score,
      flagged,
      reason: `Sightengine genai: ${(score * 100).toFixed(1)}% AI-generated probability`
    };
  } catch (err) {
    return {
      available: false, score: null, flagged: false,
      reason: `Sightengine API error: ${err.message || String(err)}`
    };
  }
}

/* ---------- Full screening pipeline ---------- */
async function screenPhoto({ buffer, mimeType, category, existingHashes }) {
  const phash = await computeDHash(buffer);
  const threshold = parseInt(process.env.PHASH_THRESHOLD || '12', 10);
  const hits = (existingHashes || []).filter(
    h => h.phash && hammingDistance(phash, h.phash) < threshold
  );
  const duplicate = hits.length > 0;
  const nearest = hits.length
    ? Math.min(...hits.map(h => hammingDistance(phash, h.phash)))
    : null;

  const ai = await checkAIGenerated(buffer, mimeType);

  let flagCount = 0;
  const parts = [];

  if (duplicate) {
    flagCount++;
    parts.push(`⚠️ pHash duplicate (${nearest}/64 vs ${hits[0].reference_no})`);
  } else if (phash) {
    parts.push('✓ pHash unique');
  }

  if (ai.available) {
    if (ai.flagged) {
      flagCount++;
      parts.push(`⚠️ ${ai.reason} — likely AI-generated`);
    } else {
      parts.push(`✓ ${ai.reason} — likely real`);
    }
  } else {
    parts.push(`ⓘ AI check unavailable (${ai.reason})`);
  }

  return { phash, duplicate, flagCount, summary: parts.join(' • '), ai, nearest };
}

module.exports = { computeDHash, hammingDistance, checkAIGenerated, screenPhoto };