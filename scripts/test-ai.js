require('dotenv').config();
const { checkAIGenerated } = require('../ai');

const SAMPLES = [
  {
    name: 'Real photograph (Wikimedia)',
    url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/640px-PNG_transparency_demonstration_1.png'
  },
  {
    name: 'AI-generated sample (Sightengine demo)',
    url: 'https://sightengine.com/assets/img/examples/midjourney.png'
  }
];

(async () => {
  if (!process.env.SIGHTENGINE_API_USER || !process.env.SIGHTENGINE_API_SECRET) {
    console.error('❌ Set SIGHTENGINE_API_USER and SIGHTENGINE_API_SECRET in .env first.');
    process.exit(1);
  }
  console.log(`Testing with api_user = ${process.env.SIGHTENGINE_API_USER}\n`);
  for (const s of SAMPLES) {
    process.stdout.write(`→ ${s.name} … `);
    try {
      const r = await fetch(s.url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buffer = Buffer.from(await r.arrayBuffer());
      const mime = r.headers.get('content-type') || 'image/png';
      const result = await checkAIGenerated(buffer, mime);
      if (!result.available) console.log(`❌ ${result.reason}`);
      else console.log(`✓ score=${(result.score * 100).toFixed(1)}%  flagged=${result.flagged}`);
    } catch (e) {
      console.log(`❌ ${e.message}`);
    }
  }
})();