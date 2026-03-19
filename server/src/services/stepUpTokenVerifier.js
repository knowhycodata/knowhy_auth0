const { createRemoteJWKSet, jwtVerify } = require('jose');
const logger = require('../utils/logger');

const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN;
const AUTH0_AUDIENCE = process.env.AUTH0_AUDIENCE;
const AUTH0_CLIENT_ID = process.env.AUTH0_CLIENT_ID;
const STEP_UP_ALLOWED_AUDIENCES = process.env.STEP_UP_ALLOWED_AUDIENCES;
const STEP_UP_WINDOW_SECONDS = Number(process.env.STEP_UP_WINDOW_SECONDS || 300);
const STEP_UP_REQUIRE_MFA_CLAIM = process.env.STEP_UP_REQUIRE_MFA_CLAIM !== 'false';
const STEP_UP_CLOCK_SKEW_SECONDS = Number(process.env.STEP_UP_CLOCK_SKEW_SECONDS || 10);

const jwksCache = new Map();

function normalizeAllowedAudiences(raw) {
  return String(raw || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function resolveAllowedAudiences({ auth0Domain, allowedAudiences } = {}) {
  const fromOverride = Array.isArray(allowedAudiences)
    ? allowedAudiences.map((s) => String(s || '').trim()).filter(Boolean)
    : normalizeAllowedAudiences(allowedAudiences);
  if (fromOverride.length > 0) return fromOverride;

  const fromEnv = normalizeAllowedAudiences(STEP_UP_ALLOWED_AUDIENCES);
  if (fromEnv.length > 0) return fromEnv;

  const defaults = [
    AUTH0_CLIENT_ID,
    AUTH0_AUDIENCE,
    auth0Domain ? `https://${auth0Domain}/api/v2/` : null,
  ]
    .map((s) => String(s || '').trim())
    .filter(Boolean);

  return Array.from(new Set(defaults));
}

function getJWKS(auth0Domain) {
  const domain = String(auth0Domain || '').trim();
  if (!domain) return null;

  if (!jwksCache.has(domain)) {
    jwksCache.set(
      domain,
      createRemoteJWKSet(new URL(`https://${domain}/.well-known/jwks.json`))
    );
  }

  return jwksCache.get(domain);
}

function normalizeAmr(amr) {
  if (!Array.isArray(amr)) return [];
  return amr.map((v) => String(v || '').toLowerCase());
}

function hasMfaEvidence(claims = {}) {
  const amr = normalizeAmr(claims.amr);
  const acr = String(claims.acr || '').toLowerCase();

  if (amr.some((v) => v === 'mfa' || v === 'otp' || v.startsWith('webauthn'))) {
    return true;
  }

  return acr.includes('multi-factor') || acr.includes('mfa');
}

function resolveAuthTimestamp(claims = {}) {
  const authTime = Number(claims.auth_time);
  const issuedAt = Number(claims.iat);
  const candidates = [];

  if (Number.isFinite(authTime) && authTime > 0) {
    candidates.push(authTime);
  }
  if (Number.isFinite(issuedAt) && issuedAt > 0) {
    candidates.push(issuedAt);
  }

  if (candidates.length === 0) return null;
  return Math.max(...candidates);
}

function getNowEpochSeconds(nowEpochSeconds) {
  if (typeof nowEpochSeconds === 'function') {
    const value = Number(nowEpochSeconds());
    if (Number.isFinite(value)) return Math.floor(value);
  }

  const value = Number(nowEpochSeconds);
  if (Number.isFinite(value) && value > 0) return Math.floor(value);

  return Math.floor(Date.now() / 1000);
}

function buildVerifierConfig(options = {}) {
  const auth0Domain = String(options.auth0Domain || AUTH0_DOMAIN || '').trim();
  const allowedAudiences = resolveAllowedAudiences({
    auth0Domain,
    allowedAudiences: options.allowedAudiences,
  });
  const stepUpWindowSeconds = Number.isFinite(Number(options.stepUpWindowSeconds))
    ? Number(options.stepUpWindowSeconds)
    : STEP_UP_WINDOW_SECONDS;
  const requireMfaClaim = typeof options.requireMfaClaim === 'boolean'
    ? options.requireMfaClaim
    : STEP_UP_REQUIRE_MFA_CLAIM;
  const clockSkewSeconds = Number.isFinite(Number(options.clockSkewSeconds))
    ? Number(options.clockSkewSeconds)
    : STEP_UP_CLOCK_SKEW_SECONDS;

  return {
    auth0Domain,
    issuer: auth0Domain ? `https://${auth0Domain}/` : '',
    allowedAudiences,
    stepUpWindowSeconds,
    requireMfaClaim,
    clockSkewSeconds,
  };
}

function evaluateStepUpClaims(payload, expectedUserSub, config = {}, nowEpochSeconds) {
  const tokenSub = String(payload?.sub || '').trim();
  const mfaDetected = hasMfaEvidence(payload);
  const authTimestamp = resolveAuthTimestamp(payload);
  const now = getNowEpochSeconds(nowEpochSeconds);

  if (!tokenSub) {
    return { valid: false, reason: 'sub_missing', authAgeSeconds: null, mfaDetected, claims: payload || null };
  }

  if (expectedUserSub && tokenSub !== expectedUserSub) {
    return { valid: false, reason: 'sub_mismatch', authAgeSeconds: null, mfaDetected, claims: payload || null };
  }

  if (!authTimestamp) {
    return { valid: false, reason: 'auth_timestamp_missing', authAgeSeconds: null, mfaDetected, claims: payload || null };
  }

  const authAgeSeconds = now - authTimestamp;
  if (authAgeSeconds < -config.clockSkewSeconds) {
    return { valid: false, reason: 'auth_time_in_future', authAgeSeconds, mfaDetected, claims: payload || null };
  }

  if (authAgeSeconds > config.stepUpWindowSeconds) {
    return { valid: false, reason: 'auth_too_old', authAgeSeconds, mfaDetected, claims: payload || null };
  }

  if (config.requireMfaClaim && !mfaDetected) {
    return { valid: false, reason: 'mfa_claim_missing', authAgeSeconds, mfaDetected, claims: payload || null };
  }

  return {
    valid: true,
    reason: 'verified',
    authAgeSeconds,
    mfaDetected,
    claims: {
      sub: tokenSub,
      iss: payload.iss || null,
      aud: payload.aud || null,
      auth_time: Number(payload.auth_time) || null,
      iat: Number(payload.iat) || null,
      acr: payload.acr || null,
      amr: Array.isArray(payload.amr) ? payload.amr : [],
    },
  };
}

function mapVerifyErrorReason(error) {
  if (!error) return 'token_invalid';

  if (error.code === 'ERR_JWT_EXPIRED') {
    return 'token_expired';
  }

  if (error.code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' || error.code === 'ERR_JWKS_NO_MATCHING_KEY') {
    return 'signature_invalid';
  }

  if (error.code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') {
    if (error.claim === 'iss') return 'issuer_invalid';
    if (error.claim === 'aud') return 'audience_invalid';
    if (error.claim === 'nbf') return 'token_not_yet_valid';
    if (error.claim === 'exp') return 'token_expired';
    return 'claim_invalid';
  }

  return 'token_invalid';
}

async function verifyStepUpToken(stepUpToken, options = {}) {
  const rawToken = String(stepUpToken || '').trim();
  const expectedUserSub = String(options.expectedUserSub || '').trim();
  const config = buildVerifierConfig(options);

  if (!rawToken) {
    return { valid: false, reason: 'token_missing', authAgeSeconds: null, mfaDetected: false, claims: null };
  }

  if (!config.auth0Domain || !config.issuer) {
    return { valid: false, reason: 'auth0_domain_missing', authAgeSeconds: null, mfaDetected: false, claims: null };
  }

  if (!Array.isArray(config.allowedAudiences) || config.allowedAudiences.length === 0) {
    return { valid: false, reason: 'audience_not_configured', authAgeSeconds: null, mfaDetected: false, claims: null };
  }

  try {
    const jwks = options.jwks || getJWKS(config.auth0Domain);
    if (!jwks) {
      return { valid: false, reason: 'jwks_not_available', authAgeSeconds: null, mfaDetected: false, claims: null };
    }

    const { payload } = await jwtVerify(rawToken, jwks, {
      issuer: config.issuer,
      audience: config.allowedAudiences,
      clockTolerance: config.clockSkewSeconds,
    });

    return evaluateStepUpClaims(payload, expectedUserSub, config, options.nowEpochSeconds);
  } catch (error) {
    const reason = mapVerifyErrorReason(error);
    logger.warn('Step-up token verification failed', {
      reason,
      code: error.code,
      claim: error.claim,
      message: error.message,
      expectedUserSub,
    });

    return {
      valid: false,
      reason,
      authAgeSeconds: null,
      mfaDetected: false,
      claims: null,
    };
  }
}

module.exports = {
  normalizeAllowedAudiences,
  resolveAllowedAudiences,
  hasMfaEvidence,
  resolveAuthTimestamp,
  evaluateStepUpClaims,
  buildVerifierConfig,
  verifyStepUpToken,
};
