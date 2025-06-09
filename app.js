/*
 * =============================================================================
 * Serveur pour l'Application de Gestion de Pneus de Garage avec MongoDB
 * =============================================================================
 *
 * Description :
 * Ce serveur utilise Node.js, Express, et Mongoose pour fournir une API REST
 * permettant de gérer les pneus d'un garage. Les données sont persistantes
 * grâce à une base de données MongoDB.
 *
 * NOUVELLE VERSION : Passage à puppeteer-core pour la compatibilité avec Render.
 *
 * Fonctionnalités :
 * - Connexion utilisateur.
 * - Gestion des Racks : Création (avec marque réservée optionnelle) et listage.
 * - Gestion des Pneus :
 * - Ajout d'une instance de pneu via son code EPREL.
 * - Scraping du site EPREL avec Puppeteer.
 * - Placement automatique qui respecte les réservations de marque.
 * - Recherche et suppression.
 *
 * Instructions pour démarrer et déployer sur Render :
 * 1. Dans le terminal, exécutez :
 * npm init -y
 * npm install express mongoose dotenv puppeteer-core cors
 * 2. Créez un fichier `.env` et ajoutez votre chaîne de connexion MongoDB :
 * MONGO_URI=mongodb://...
 * 3. Sur Render, ajoutez le Buildpack : https://github.com/jontewks/puppeteer-heroku-buildpack
 * 4. Lancez le serveur.
 *
 */

const express = require('express');
const mongoose = require('mongoose');
const puppeteer = require('puppeteer-core'); // MODIFIÉ: Utilisation de puppeteer-core
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000; // Utiliser le port de Render

// --- Middlewares ---
app.use(cors());
app.use(express.json());

// --- Connexion à MongoDB ---
mongoose.connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(() => {
    console.log('Connexion à MongoDB réussie !');
}).catch(err => {
    console.error('Erreur de connexion à MongoDB:', err);
    process.exit(1);
});

// --- Schémas Mongoose ---

const userSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true }
});

const rackSchema = new mongoose.Schema({
    name: { type: String, required: true },
    totalWidth: { type: Number, required: true },
    isDouble: { type: Boolean, default: false },
    reservedForBrand: { type: String, trim: true, uppercase: true, default: null },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
});

const tireSchema = new mongoose.Schema({
    eprelCode: { type: String, required: true },
    brand: { type: String, required: true },
    model: { type: String },
    width: { type: Number, required: true },
    aspectRatio: { type: Number, required: true },
    diameter: { type: Number, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    location: {
        rackId: { type: mongoose.Schema.Types.ObjectId, ref: 'Rack' },
        row: { type: String, enum: ['front', 'back'] }
    }
});

const User = mongoose.model('User', userSchema);
const Rack = mongoose.model('Rack', rackSchema);
const Tire = mongoose.model('Tire', tireSchema);

let eprelDataCache = {};

// --- Middleware d'Authentification ---
const authenticate = async (req, res, next) => {
    const token = req.headers.authorization;
    if (token === 'Bearer user1_token') {
        try {
            let user = await User.findOne({ email: 'garage@test.com' });
            if (!user) {
                user = new User({ email: 'garage@test.com', password: 'password123' });
                await user.save();
            }
            req.user = user;
            next();
        } catch (error) {
            res.status(500).json({ message: 'Erreur serveur lors de l\'authentification' });
        }
    } else {
        res.status(401).json({ message: 'Accès non autorisé.' });
    }
};

// --- Service de Scraping (MISE À JOUR POUR DÉPLOIEMENT) ---
async function getEprelData(eprelCode) {
    if (eprelDataCache[eprelCode]) return eprelDataCache[eprelCode];
    let browser = null;
    try {
        console.log(`Scraping des données pour EPREL ${eprelCode} avec Puppeteer...`);
        const url = `https://eprel.ec.europa.eu/screen/product/tyres/${eprelCode}`;
        
        const launchOptions = {
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-gpu'
            ],
            headless: true,
            // MODIFIÉ: Utilisation du chemin fourni par le buildpack de Render
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
        };

        browser = await puppeteer.launch(launchOptions);
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36');

        await page.goto(url, { waitUntil: 'networkidle0' });

        const scrapedData = await page.evaluate(() => {
            const boldSelector = '.ecl-u-type-bold.ecl-u-pl-l-xl.ecl-u-pr-2xs.ecl-u-type-align-right';
            const marqueSelector = '.ecl-u-type-l.ecl-u-type-color-grey-75.ecl-u-type-family-alt';
            const getText = (selector) => document.querySelector(selector)?.textContent.trim() || null;
            const allBoldElements = document.querySelectorAll(boldSelector);
            const allTexts = Array.from(allBoldElements, el => el.textContent.trim());
            const dimension = allTexts.find(t => /\d+\/\d+\s*R\s*\d+/.test(t)) || null;
            const nom = allTexts.find(t => t && !/\d+\/\d+\s*R\s*\d+/.test(t)) || null;
            const marque = getText(marqueSelector);
            return { dimension, nom, marque };
        });
        
        const { dimension: sizeString, nom: model, marque: brand } = scrapedData;
        if (!brand || !sizeString) {
            console.error(`Sélecteurs non trouvés pour EPREL ${eprelCode}. La structure de la page a peut-être changé.`);
            return null;
        }

        const sizeMatch = sizeString.match(/(\d+)\/(\d+)\s*R\s*(\d+)/);
        if (!sizeMatch) return null;
        
        const [, widthMm, aspectRatio, diameter] = sizeMatch;
        const tireInfo = {
            brand,
            model: model || 'N/A',
            width: parseFloat(widthMm) / 10,
            aspectRatio: parseInt(aspectRatio, 10),
            diameter: parseInt(diameter, 10),
        };

        eprelDataCache[eprelCode] = tireInfo;
        return tireInfo;
    } catch (error) {
        console.error(`Erreur majeure de scraping pour ${eprelCode}:`, error);
        return null;
    } finally {
        if (browser) await browser.close();
    }
}


// --- Routes de l'API ---

app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        if (email === 'garage@test.com' && password === 'password123') {
            let user = await User.findOne({ email });
            if (!user) {
                user = new User({ email, password });
                await user.save();
            }
            res.json({ message: 'Connexion réussie !', token: 'user1_token' });
        } else {
            res.status(401).json({ message: 'Email ou mot de passe incorrect.' });
        }
    } catch (error) {
        res.status(500).json({ message: 'Erreur serveur.' });
    }
});

app.post('/racks', authenticate, async (req, res) => {
    const { name, totalWidth, isDouble, reservedForBrand } = req.body;
    try {
        const newRack = new Rack({
            name,
            totalWidth,
            isDouble,
            reservedForBrand: reservedForBrand ? reservedForBrand.trim().toUpperCase() : null,
            userId: req.user._id
        });
        await newRack.save();
        res.status(201).json(newRack);
    } catch (error) {
        res.status(400).json({ message: 'Données invalides.', error: error.message });
    }
});

app.get('/racks', authenticate, async (req, res) => {
    try {
        const userRacks = await Rack.find({ userId: req.user._id });
        const userTires = await Tire.find({ userId: req.user._id, location: { $ne: null } });
        const populatedRacks = userRacks.map(rack => {
            const rackJson = rack.toObject();
            rackJson.frontRowTires = userTires.filter(t => t.location?.rackId?.equals(rack._id) && t.location?.row === 'front');
            rackJson.backRowTires = userTires.filter(t => t.location?.rackId?.equals(rack._id) && t.location?.row === 'back');
            return rackJson;
        });
        res.json(populatedRacks);
    } catch (error) {
        res.status(500).json({ message: 'Erreur serveur.' });
    }
});

app.post('/tires', authenticate, async (req, res) => {
    const { eprelCode } = req.body;
    if (!eprelCode) return res.status(400).json({ message: 'Le code EPREL est requis.' });

    try {
        const tireData = await getEprelData(eprelCode);
        if (!tireData) return res.status(404).json({ message: `Infos non trouvées pour EPREL ${eprelCode}. Le scraping a peut-être échoué.` });

        const userRacks = await Rack.find({ userId: req.user._id });
        const storedTires = await Tire.find({ userId: req.user._id, location: { $ne: null } });
        let foundLocation = null;
        const tireBrandUpper = tireData.brand.toUpperCase();
        const eligibleRacks = userRacks.filter(rack => !rack.reservedForBrand || rack.reservedForBrand === tireBrandUpper);

        for (const rack of eligibleRacks.filter(r => r.isDouble)) {
            const frontTiresOfSameType = storedTires.filter(t => t.location.rackId.equals(rack._id) && t.location.row === 'front' && t.eprelCode === eprelCode);
            const backTiresOfSameType = storedTires.filter(t => t.location.rackId.equals(rack._id) && t.location.row === 'back' && t.eprelCode === eprelCode);
            
            if (frontTiresOfSameType.length > backTiresOfSameType.length) {
                const occupiedWidthBack = storedTires.filter(t => t.location.rackId.equals(rack._id) && t.location.row === 'back').reduce((sum, t) => sum + t.width, 0);
                if (rack.totalWidth - occupiedWidthBack >= tireData.width) {
                    foundLocation = { rackId: rack._id, row: 'back' };
                    break;
                }
            }
        }
        
        if (!foundLocation) {
            for (const rack of eligibleRacks) {
                const occupiedWidthFront = storedTires.filter(t => t.location.rackId.equals(rack._id) && t.location.row === 'front').reduce((sum, t) => sum + t.width, 0);
                if (rack.totalWidth - occupiedWidthFront >= tireData.width) {
                    foundLocation = { rackId: rack._id, row: 'front' };
                    break;
                }
            }
        }

        if (!foundLocation) {
            return res.status(400).json({ message: 'Aucun emplacement disponible pour ce pneu.', tireData });
        }

        const newTire = new Tire({ ...tireData, eprelCode, userId: req.user._id, location: foundLocation });
        await newTire.save();
        res.status(201).json(newTire);

    } catch (error) {
        res.status(500).json({ message: 'Erreur serveur.', error: error.message });
    }
});

app.get('/tires/search', authenticate, async (req, res) => {
    const { query } = req.query;
    if (!query) return res.status(400).json({ message: 'Critère de recherche requis.' });
    try {
        const results = await Tire.find({ userId: req.user._id, $or: [ { model: new RegExp(query, 'i') }, { brand: new RegExp(query, 'i') }, { eprelCode: new RegExp(query, 'i') } ] });
        res.json(results);
    } catch (error) {
        res.status(500).json({ message: 'Erreur serveur.' });
    }
});

app.delete('/tires/:id', authenticate, async (req, res) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'ID de pneu invalide.' });
    try {
        const deletedTire = await Tire.findOneAndDelete({ _id: id, userId: req.user._id });
        if (!deletedTire) return res.status(404).json({ message: 'Instance de pneu non trouvée.' });
        res.status(200).json({ message: 'Le pneu a été supprimé.', deletedTire });
    } catch (error) {
        res.status(500).json({ message: 'Erreur serveur.' });
    }
});

// --- Démarrage du Serveur ---
app.listen(PORT, () => {
    console.log(`Serveur démarré sur le port ${PORT}`);
    console.log('Connecté à la base de données MongoDB.');
});
