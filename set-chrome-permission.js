const puppeteer = require('puppeteer');
const fs = require('fs');

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
