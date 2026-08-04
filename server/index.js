require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const path = require('path');

const diagramsRouter = require('./routes/diagrams');
const filesRouter = require('./routes/files');
const capabilitiesRouter = require('./routes/capabilities');
const tasksRouter = require('./routes/tasks');
const actorsRouter = require('./routes/actors');
const serversRouter = require('./routes/servers');
const authRouter = require('./routes/auth');
const adminRouter = require('./routes/admin');
const statesRouter = require('./routes/states');
const dashboardRouter = require('./routes/dashboard');
const reportsRouter   = require('./routes/reports');
const databasesRouter = require('./routes/databases');
const customFactoriesRouter = require('./routes/customFactories');
const componentsRouter = require('./routes/components');
const componentSummariesRouter = require('./routes/componentSummaries');
const canonicalRouter = require('./routes/canonical');
const systemComponentsRouter = require('./routes/systemComponents');
const referenceDataRouter = require('./routes/referenceData');
const Session = require('./models/Session');
const User = require('./models/User');
const Diagram = require('./models/Diagram');
const Task = require('./models/Task');
const Actor = require('./models/Actor');
const Capability = require('./models/Capability');
const { BusinessFlow, Product, Channel, Domain, Subdomain, LineOfBusiness } = require('./models/ReferenceData');
const Component = require('./models/Component');
const Model = require('./models/Model');
const { DEFAULT_NEIGHBORHOOD_NAME } = require('./utils/neighborhoodScope');

const app = express();
const PORT = process.env.PORT || 3001;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27018/bpmn_iq';

// Middleware
app.use(cors({ origin: 'http://localhost:5173', credentials: true }));
app.use(express.json({ limit: '10mb' }));

// Simple cookie parser (no external package needed)
app.use((req, _res, next) => {
  req.cookies = {};
  const header = req.headers.cookie;
  if (header) {
    header.split(';').forEach((c) => {
      const [key, ...v] = c.split('=');
      req.cookies[key.trim()] = decodeURIComponent(v.join('=').trim());
    });
  }
  next();
});

// Health check (before auth guard so wait-on can reach it)
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// Auth routes (no session guard)
app.use('/api/auth', authRouter);

// Public API routes (no session guard needed)
const publicApiPaths = [
  '/custom-factories/search',
  '/custom-factories/leaf-component',
  '/custom-factories/hierarchies/tree',
  // Allow canonical reads and adapter pages without session for smoke tests and public consumption
  '/canonical',
  '/custom-factories/canonical',
];

// Session guard — protect all other /api routes
app.use('/api', async (req, res, next) => {
  try {
    // Skip session check for public endpoints
    if (publicApiPaths.some(path => req.path.startsWith(path))) {
      console.log(`[AUTH] Allowing public access to: ${req.path}`);
      return next();
    }
    
    const token = req.cookies?.bpmn_iq_sid;
    if (!token) return res.status(401).json({ error: 'Session expired. Please log in again.' });
    const sess = await Session.findOne({ token, expiresAt: { $gt: new Date() } }).lean();
    if (!sess) {
      res.clearCookie('bpmn_iq_sid');
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }
    // Resolve user role
    const userDoc = await User.findOne({ userId: sess.userId }).lean();
    req.currentUser = { userId: sess.userId, displayName: sess.displayName, role: userDoc?.role || null };
    next();
  } catch (err) {
    console.error('Session middleware error:', err?.stack || err);
    return res.status(500).json({ error: 'Failed to validate session.' });
  }
});

// Routes
app.use('/api/diagrams', diagramsRouter);
app.use('/api/files', filesRouter);
app.use('/api/capabilities', capabilitiesRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/actors', actorsRouter);
app.use('/api/servers', serversRouter);
app.use('/api/admin', adminRouter);
app.use('/api/states', statesRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/reports',   reportsRouter);
app.use('/api/databases', databasesRouter);
app.use('/api/custom-factories', customFactoriesRouter);
app.use('/api/components', componentsRouter);
app.use('/api/component-summaries', componentSummariesRouter);
app.use('/api/canonical', canonicalRouter);
app.use('/api/system-components', systemComponentsRouter);
app.use('/api/reference', referenceDataRouter);
const materializeRouter = require('./routes/materialize');
app.use('/api/materialize', materializeRouter);

// Connect to MongoDB then start server
async function backfillNeighborhoods() {
  const collections = [Diagram, Task, Actor, Capability, BusinessFlow, Product, Channel, Domain, Subdomain, LineOfBusiness, Component];
  const missingNeighborhoodFilter = {
    $or: [{ neighborhoodName: { $exists: false } }, { neighborhoodName: null }, { neighborhoodName: '' }],
  };

  const missingCounts = await Promise.all(collections.map((Model) => Model.countDocuments(missingNeighborhoodFilter)));
  const requiresDefaultNeighborhood = missingCounts.some((count) => count > 0);
  const hasDefaultNeighborhood = Boolean(await Model.exists({ name: DEFAULT_NEIGHBORHOOD_NAME }));

  if (requiresDefaultNeighborhood && hasDefaultNeighborhood) {
    await Promise.all(collections.map((Model) => Model.updateMany(
      missingNeighborhoodFilter,
      { $set: { neighborhoodName: DEFAULT_NEIGHBORHOOD_NAME } }
    )));
  }

}

async function migrateLegacyModelCollection() {
  const db = mongoose.connection.db;
  const collectionEntries = await db.listCollections({}, { nameOnly: true }).toArray();
  const collectionNames = new Set(collectionEntries.map((entry) => entry.name));

  if (!collectionNames.has('factoryneighborhoods')) return;

  if (!collectionNames.has('models')) {
    await db.collection('factoryneighborhoods').rename('models');
    return;
  }

  const legacyDocs = await db.collection('factoryneighborhoods').find({}).toArray();
  if (legacyDocs.length) {
    const toUpsertUpdate = (doc) => {
      const { _id, __v, ...rest } = doc || {};
      return rest;
    };

    await db.collection('models').bulkWrite(
      legacyDocs.map((doc) => ({
        updateOne: {
          filter: { name: doc.name },
          update: { $set: toUpsertUpdate(doc) },
          upsert: true,
        },
      })),
      { ordered: false }
    );
  }

  await db.collection('factoryneighborhoods').drop().catch(() => null);
}

async function migrateLegacyComponentCollection() {
  const db = mongoose.connection.db;
  const collectionEntries = await db.listCollections({}, { nameOnly: true }).toArray();
  const collectionNames = new Set(collectionEntries.map((entry) => entry.name));
  const legacyCollectionNames = ['parts', 'customfactories'];

  if (!collectionNames.has('components')) {
    if (collectionNames.has('parts')) {
      await db.collection('parts').rename('components');
      collectionNames.delete('parts');
      collectionNames.add('components');
    } else if (collectionNames.has('customfactories')) {
      await db.collection('customfactories').rename('components');
      collectionNames.delete('customfactories');
      collectionNames.add('components');
    }
  }

  if (!collectionNames.has('components')) return;

  for (const legacyName of legacyCollectionNames) {
    if (!collectionNames.has(legacyName)) continue;

    const legacyDocs = await db.collection(legacyName).find({}).toArray();
    if (legacyDocs.length) {
      const toUpsertUpdate = (doc) => {
        const { _id, __v, ...rest } = doc || {};
        return rest;
      };

      await db.collection('components').bulkWrite(
        legacyDocs.map((doc) => ({
          updateOne: {
            filter: { neighborhoodName: doc.neighborhoodName, name: doc.name },
            update: { $set: toUpsertUpdate(doc) },
            upsert: true,
          },
        })),
        { ordered: false }
      );
    }

    await db.collection(legacyName).drop().catch(() => null);
  }
}

async function syncNeighborhoodIndexes() {
  const models = [Diagram, Task, Actor, Capability, BusinessFlow, Product, Channel, Domain, Subdomain, LineOfBusiness, Component, Model];
  await Promise.all(models.map((Model) => Model.syncIndexes()));
}

mongoose
  .connect(MONGO_URI)
  .then(async () => {
    console.log(`Connected to MongoDB at ${MONGO_URI}`);
    await migrateLegacyModelCollection();
    await migrateLegacyComponentCollection();
    // Backfill modelName from existing neighborhoodName where missing
    try {
      await Component.updateMany(
        { $or: [{ modelName: { $exists: false } }, { modelName: null }, { modelName: '' }] },
        [{ $set: { modelName: '$neighborhoodName' } }]
      );
    } catch (err) {
      // If the server's MongoDB version doesn't support update pipeline, fallback to simple update per-document
      try {
        const docs = await Component.find({ $or: [{ modelName: { $exists: false } }, { modelName: null }, { modelName: '' }] }, { _id: 1, neighborhoodName: 1 }).lean();
        if (docs.length) {
          const bulkOps = docs.map((d) => ({ updateOne: { filter: { _id: d._id }, update: { $set: { modelName: d.neighborhoodName || '' } } } }));
          if (bulkOps.length) await Component.bulkWrite(bulkOps, { ordered: false });
        }
      } catch (e) {
        console.warn('Failed to backfill modelName on components:', e?.message || e);
      }
    }
    await backfillNeighborhoods();
    await syncNeighborhoodIndexes();
    app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('MongoDB connection error:', err.message);
    process.exit(1);
  });
