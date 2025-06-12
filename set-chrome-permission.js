const { execSync } = require('child_process');
const puppeteer = require('puppeteer');

(async () => {
  try {
    const path = puppeteer.executablePath();
    console.log('➡️ Chemin Chrome détecté :', path);
    execSync(`chmod +x ${path}`);
    console.log('✅ Permissions exécutables ajoutées à Chrome');
  } catch (err) {
    console.error('❌ Échec de chmod Chrome :', err.message);
    process.exit(1);
  }
})();
