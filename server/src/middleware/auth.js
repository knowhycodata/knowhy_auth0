const { createRemoteJWKSet, jwtVerify } = require('jose');
const axios = require('axios');
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

function buildFallbackEmail(sub) {
  const safe = String(sub || 'unknown')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase()
    .slice(-32);
  return `user-${safe || 'unknown'}@knowhy.local`;
}

async function getUserInfo(token) {
  try {
    const response = await axios.get(`https://${AUTH0_DOMAIN}/userinfo`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 5000,
    });
    return response.data || {};
  } catch (error) {
    logger.warn('Failed to fetch /userinfo fallback:', {
      error: error.message,
      status: error.response?.status,
    });
    return {};
  }
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

    let payload;
    try {
      ({ payload } = await jwtVerify(token, jwks, {
        issuer: `https://${AUTH0_DOMAIN}/`,
        audience: AUTH0_AUDIENCE,
      }));
    } catch (error) {
      logger.warn('JWT verification failed:', {
        error: error.message,
        code: error.code,
        reason: error.reason,
        audience: AUTH0_AUDIENCE,
        domain: AUTH0_DOMAIN,
      });
      return res.status(401).json({
        success: false,
        error: req.t ? req.t('errors.invalidToken') : 'Invalid or expired token',
        debug: process.env.NODE_ENV === 'development' ? {
          message: error.message,
          code: error.code,
          expectedAudience: AUTH0_AUDIENCE,
        } : undefined,
      });
    }

    const userInfo = (!payload.email || !payload.name || !payload.picture)
      ? await getUserInfo(token)
      : {};

    const email = payload.email || userInfo.email || buildFallbackEmail(payload.sub);
    const name = payload.name || userInfo.name || null;
    const picture = payload.picture || userInfo.picture || null;

    req.user = {
      sub: payload.sub,
      email,
      permissions: typeof payload.scope === 'string' ? payload.scope.split(' ') : [],
      rawToken: token,
      stepUpClaims: {
        amr: Array.isArray(payload.amr) ? payload.amr : [],
        acr: typeof payload.acr === 'string' ? payload.acr : null,
        authTime: Number.isFinite(Number(payload.auth_time)) ? Number(payload.auth_time) : null,
        issuedAt: Number.isFinite(Number(payload.iat)) ? Number(payload.iat) : null,
      },
    };

    // Upsert user in database
    let userResult;
    try {
      userResult = await query(
        `INSERT INTO users (auth0_id, email, name, picture)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (auth0_id) DO UPDATE SET
           email = EXCLUDED.email,
           name = COALESCE(EXCLUDED.name, users.name),
           picture = COALESCE(EXCLUDED.picture, users.picture),
           updated_at = NOW()
         RETURNING id, auth0_id, email, name, picture, locale, gmail_connected`,
        [payload.sub, email, name, picture]
      );
    } catch (dbError) {
      logger.error('User upsert failed after valid token verification:', {
        error: dbError.message,
        code: dbError.code,
        auth0Sub: payload.sub,
      });
      return res.status(500).json({
        success: false,
        error: req.t ? req.t('errors.internal') : 'Internal server error',
      });
    }

    req.dbUser = userResult.rows[0];

    next();
  } catch (error) {
    logger.error('Unexpected authentication middleware failure:', {
      error: error.message,
      code: error.code,
      reason: error.reason,
      audience: AUTH0_AUDIENCE,
      domain: AUTH0_DOMAIN,
    });
    return res.status(500).json({
      success: false,
      error: req.t ? req.t('errors.internal') : 'Internal server error',
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
