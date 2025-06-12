// set-chrome-permission.js
const { execSync } = require('child_process');
const puppeteer = require('puppeteer');

(async () => {
  try {
    const path = puppeteer.executablePath();
    if (!path) throw new Error("Chemin introuvable.");
    console.log('➡️ Chemin Chrome détecté :', path);
    execSync(`chmod +x "${path}"`);
    console.log('✅ Permission ajoutée avec succès.');
  } catch (err) {
    console.error('❌ Erreur chmod :', err.message);
    process.exit(1);
  }
})();
