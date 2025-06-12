const puppeteer = require('puppeteer');
const fs = require('fs');
const { execSync } = require('child_process');

const getChromePath = () => {
  try {
    const path = puppeteer.executablePath();
    if (fs.existsSync(path)) return path;
    console.error('❌ Le chemin Chrome retourné n\'existe pas :', path);
    return null;
  } catch (err) {
    console.error('❌ Erreur lors de la récupération du chemin Chrome :', err.message);
    return null;
  }
};

const chromePath = getChromePath();
console.log('➡️ Chemin Chrome détecté :', chromePath);

if (chromePath) {
  try {
    execSync(`chmod +x ${chromePath}`);
    console.log('✅ Permission ajoutée avec succès.');
  } catch (err) {
    console.error('❌ Erreur lors de l\'ajout de la permission :', err.message);
  }
} else {
  console.error('❌ Chrome non trouvé, impossible d\'ajouter les permissions.');
}
