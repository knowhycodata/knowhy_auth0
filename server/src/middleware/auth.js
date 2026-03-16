const { createRemoteJWKSet, jwtVerify } = require('jose');
const logger = require('../utils/logger');
const { query } = require('../db');

const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN;
const AUTH0_AUDIENCE = process.env.AUTH0_AUDIENCE;

let JWKS = null;

function getJWKS() {
  if (!JWKS && AUTH0_DOMAIN) {
    JWKS = createRemoteJWKSet(
      new URL(`https://${AUTH0_DOMAIN}/.well-known/jwks.json`)
    );
  }
  return JWKS;
}

async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: req.t ? req.t('errors.unauthorized') : 'Authorization required',
      });
    }

    const token = authHeader.substring(7);
    const jwks = getJWKS();

    if (!jwks) {
      logger.error('JWKS not initialized - AUTH0_DOMAIN may be missing');
      return res.status(500).json({
        success: false,
        error: 'Authentication service not configured',
      });
    }

    const { payload } = await jwtVerify(token, jwks, {
      issuer: `https://${AUTH0_DOMAIN}/`,
      audience: AUTH0_AUDIENCE,
    });

    req.user = {
      sub: payload.sub,
      email: payload.email,
      permissions: typeof payload.scope === 'string' ? payload.scope.split(' ') : [],
      rawToken: token,
    };

    // Upsert user in database
    const userResult = await query(
      `INSERT INTO users (auth0_id, email, name, picture)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (auth0_id) DO UPDATE SET
         email = EXCLUDED.email,
         name = COALESCE(EXCLUDED.name, users.name),
         picture = COALESCE(EXCLUDED.picture, users.picture),
         updated_at = NOW()
       RETURNING id, auth0_id, email, name, picture, locale, gmail_connected`,
      [payload.sub, payload.email, payload.name || null, payload.picture || null]
    );

    req.dbUser = userResult.rows[0];

    next();
  } catch (error) {
    logger.warn('Authentication failed:', { error: error.message });
    return res.status(401).json({
      success: false,
      error: req.t ? req.t('errors.invalidToken') : 'Invalid or expired token',
    });
  }
}

async function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return requireAuth(req, res, next);
  }
  next();
}

module.exports = { requireAuth, optionalAuth };
