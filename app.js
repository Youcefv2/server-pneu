require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const puppeteer = require('puppeteer');
const fs = require('fs');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;


app.use(cors());
app.use(express.json());

mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => {
  console.log('Connexion à MongoDB réussie !');
}).catch(err => {
  console.error('Erreur de connexion à MongoDB:', err);
  process.exit(1);
});

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

async function getEprelData(eprelCode) {
  let browser;
  try {
    browser = await puppeteer.launch({
    args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--single-process',
    '--no-zygote'
    ],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    headless: true
    });

    const page = await browser.newPage();
    await page.goto(`https://eprel.ec.europa.eu/screen/product/tyres/${eprelCode}`, {
      waitUntil: 'networkidle0'
    });

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
    if (!brand || !sizeString) return null;

    const sizeMatch = sizeString.match(/(\d+)\/(\d+)\s*R\s*(\d+)/);
    if (!sizeMatch) return null;

    const [, widthMm, aspectRatio, diameter] = sizeMatch;
    return {
      brand,
      model: model || 'N/A',
      width: parseFloat(widthMm) / 10,
      aspectRatio: parseInt(aspectRatio, 10),
      diameter: parseInt(diameter, 10)
    };
  } catch (error) {
    console.error(`❌ Erreur de scraping pour ${eprelCode}:`, error.message);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}



// --- Routes de l'API ---

app.get("/", (req, res) =>{
  res.send("Range ton pneu api");
}); 
  


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

/**
 * POST /racks (MISE À JOUR)
 * Prend en compte la réservation de marque.
 */
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

/**
 * POST /tires (MISE À JOUR)
 * La logique de placement respecte les réservations de marque.
 */
app.post('/tires', authenticate, async (req, res) => {
    const { eprelCode } = req.body;
    if (!eprelCode) return res.status(400).json({ message: 'Le code EPREL est requis.' });

    try {
        const tireData = await getEprelData(eprelCode);
        if (!tireData) return res.status(404).json({ message: `Infos non trouvées pour EPREL ${eprelCode}.` });

        const userRacks = await Rack.find({ userId: req.user._id });
        const storedTires = await Tire.find({ userId: req.user._id, location: { $ne: null } });
        let foundLocation = null;

        const tireBrandUpper = tireData.brand.toUpperCase();
        
        // Filtrer les racks éligibles pour ce pneu
        const eligibleRacks = userRacks.filter(rack => 
            !rack.reservedForBrand || rack.reservedForBrand === tireBrandUpper
        );

        // Stratégie 1: Derrière un pneu identique dans un rack éligible
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
        
        // Stratégie 2: En première rangée d'un rack éligible
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
    console.log(`Serveur démarré sur http://localhost:${PORT}`);
    console.log('Connecté à la base de données MongoDB.');
});
