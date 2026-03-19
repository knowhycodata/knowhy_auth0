const { randomUUID } = require('crypto');

const STEP_UP_WINDOW_SECONDS = Number(process.env.STEP_UP_WINDOW_SECONDS || 300);
const STEP_UP_REQUIRE_MFA_CLAIM = process.env.STEP_UP_REQUIRE_MFA_CLAIM === 'true';
const STEP_UP_CHALLENGE_TTL_SECONDS = Number(process.env.STEP_UP_CHALLENGE_TTL_SECONDS || 300);
const STEP_UP_CLOCK_SKEW_SECONDS = Number(process.env.STEP_UP_CLOCK_SKEW_SECONDS || 10);

// Basit in-memory challenge store (hackathon/demo için yeterli).
const stepUpChallenges = new Map();

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function cleanupExpiredChallenges() {
  const now = nowSeconds();
  for (const [challengeId, entry] of stepUpChallenges.entries()) {
    if (!entry || entry.expiresAt < now) {
      stepUpChallenges.delete(challengeId);
    }
  }
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
  const authTime = Number(claims.authTime);
  const issuedAt = Number(claims.issuedAt);
  const candidates = [];

  if (Number.isFinite(authTime) && authTime > 0) {
    candidates.push(authTime);
  }
  if (Number.isFinite(issuedAt) && issuedAt > 0) {
    candidates.push(issuedAt);
  }

  if (candidates.length > 0) {
    return Math.max(...candidates);
  }

  return null;
}

function createStepUpChallenge({ userId, action, pendingArgs = null }) {
  cleanupExpiredChallenges();

  const createdAt = nowSeconds();
  const challengeId = randomUUID();
  const entry = {
    challengeId,
    userId,
    action,
    pendingArgs,
    createdAt,
    expiresAt: createdAt + STEP_UP_CHALLENGE_TTL_SECONDS,
  };

  stepUpChallenges.set(challengeId, entry);
  return entry;
}

function consumeStepUpChallenge({ challengeId, userId, action, authTimestamp }) {
  cleanupExpiredChallenges();

  if (!challengeId) {
    return { approved: false, reason: 'challenge_missing' };
  }

  const entry = stepUpChallenges.get(challengeId);
  if (!entry) {
    return { approved: false, reason: 'challenge_not_found' };
  }

  if (entry.userId !== userId) {
    return { approved: false, reason: 'challenge_user_mismatch' };
  }

  if (entry.action && entry.action !== action) {
    return { approved: false, reason: 'challenge_action_mismatch' };
  }

  if (!(typeof authTimestamp === 'number' && authTimestamp > 0)) {
    return { approved: false, reason: 'auth_timestamp_missing' };
  }

  // Popup sonrası gelen token, challenge üretiminden sonra doğrulanmış olmalı.
  if (authTimestamp + STEP_UP_CLOCK_SKEW_SECONDS < entry.createdAt) {
    return { approved: false, reason: 'auth_not_fresh_after_challenge' };
  }

  stepUpChallenges.delete(challengeId);
  return { approved: true, reason: 'challenge_verified', entry };
}

function buildStepUpContextFromClaims(claims = {}, challengeId = null) {
  const now = nowSeconds();
  const authTimestamp = resolveAuthTimestamp(claims);
  const authAgeSeconds = authTimestamp ? now - authTimestamp : null;
  const hasRecentAuth = authAgeSeconds !== null
    && authAgeSeconds >= 0
    && authAgeSeconds <= STEP_UP_WINDOW_SECONDS;
  const mfaDetected = hasMfaEvidence(claims);

  const approved = hasRecentAuth && (mfaDetected || !STEP_UP_REQUIRE_MFA_CLAIM);

  let reason = 'approved';
  if (!hasRecentAuth) {
    reason = 'recent_auth_required';
  } else if (STEP_UP_REQUIRE_MFA_CLAIM && !mfaDetected) {
    reason = 'mfa_claim_missing';
  }

  return {
    approved,
    reason,
    hasRecentAuth,
    mfaDetected,
    authAgeSeconds,
    authTimestamp,
    authTime: Number(claims.authTime) || null,
    issuedAt: Number(claims.issuedAt) || null,
    challengeId: challengeId || null,
    windowSeconds: STEP_UP_WINDOW_SECONDS,
    requireMfaClaim: STEP_UP_REQUIRE_MFA_CLAIM,
  };
}

module.exports = {
  buildStepUpContextFromClaims,
  createStepUpChallenge,
  consumeStepUpChallenge,
};
