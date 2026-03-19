require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const hpp = require('hpp');
const i18next = require('i18next');
const i18nextMiddleware = require('i18next-http-middleware');
const i18nextBackend = require('i18next-fs-backend');
const path = require('path');

const logger = require('./utils/logger');
const { pool, initDatabase } = require('./db');
const authRoutes = require('./routes/auth');
const chatRoutes = require('./routes/chat');
const emailRoutes = require('./routes/email');
const userRoutes = require('./routes/user');
const healthRoutes = require('./routes/health');
const stepupRoutes = require('./routes/stepup');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { initCronJobs } = require('./services/cronJobs');

const app = express();
const PORT = Number(process.env.PORT || process.env.SERVER_PORT || 3001);
const DB_INIT_MAX_RETRIES = Number(process.env.DB_INIT_MAX_RETRIES || 30);
const DB_INIT_RETRY_DELAY_MS = Number(process.env.DB_INIT_RETRY_DELAY_MS || 3000);

function parseAllowedOrigins() {
  const origins = new Set();

  const addOrigins = (rawValue) => {
    String(rawValue || '')
      .split(/[,\s]+/)
      .map((origin) => origin.trim())
      .filter(Boolean)
      .forEach((origin) => origins.add(origin));
  };

  addOrigins(process.env.CLIENT_URLS);
  addOrigins(process.env.CLIENT_URL);

  if (process.env.NODE_ENV !== 'production') {
    origins.add('http://localhost:5173');
    origins.add('http://127.0.0.1:5173');
  }

  return Array.from(origins);
}

const allowedOrigins = parseAllowedOrigins();

async function waitForDatabaseReady() {
  for (let attempt = 1; attempt <= DB_INIT_MAX_RETRIES; attempt += 1) {
    try {
      await initDatabase();
      return;
    } catch (error) {
      const lastAttempt = attempt === DB_INIT_MAX_RETRIES;
      logger.warn('Database init attempt failed', {
        attempt,
        maxRetries: DB_INIT_MAX_RETRIES,
        error: error.message,
      });

      if (lastAttempt) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, DB_INIT_RETRY_DELAY_MS));
    }
  }
}

// i18n setup
i18next
  .use(i18nextBackend)
  .use(i18nextMiddleware.LanguageDetector)
  .init({
    fallbackLng: 'en',
    supportedLngs: ['tr', 'en'],
    backend: {
      loadPath: path.join(__dirname, 'locales/{{lng}}/{{ns}}.json'),
    },
    detection: {
      order: ['header', 'querystring', 'cookie'],
      lookupHeader: 'accept-language',
      lookupQuerystring: 'lng',
      lookupCookie: 'i18next',
    },
  });

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", process.env.AUTH0_DOMAIN ? `https://${process.env.AUTH0_DOMAIN}` : ''].filter(Boolean),
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(hpp());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/api/', limiter);

// Chat endpoint has stricter rate limiting
const chatLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 20,
  message: { error: 'Too many chat requests, please slow down.' },
});
app.use('/api/chat', chatLimiter);

// CORS
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    return callback(null, allowedOrigins.includes(origin));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept-Language'],
}));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Logging
app.use(morgan('combined', {
  stream: { write: (message) => logger.info(message.trim()) },
}));

// i18n middleware
app.use(i18nextMiddleware.handle(i18next));

// Session
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000,
  },
}));

// Routes
app.use('/api/health', healthRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/email', emailRoutes);
app.use('/api/user', userRoutes);
app.use('/api/auth/stepup', stepupRoutes);

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

// Start server
async function startServer() {
  try {
    await waitForDatabaseReady();
    logger.info('Database initialized successfully');

    // Initialize cron jobs (nightly email summarization)
    initCronJobs();

    app.listen(PORT, () => {
      logger.info(`🚀 Knowhy Backend running on port ${PORT}`);
      logger.info(`   Environment: ${process.env.NODE_ENV || 'development'}`);
      logger.info(`   Auth0 Domain: ${process.env.AUTH0_DOMAIN || 'not configured'}`);
      logger.info(`   Allowed CORS origins: ${allowedOrigins.length > 0 ? allowedOrigins.join(', ') : '(none)'}`);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

module.exports = app;
