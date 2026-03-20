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

  // Doğrudan MFA kanıtları (TOTP, WebAuthn, push vb.)
  if (amr.some((v) => v === 'mfa' || v === 'otp' || v.startsWith('webauthn'))) {
    return true;
  }

  // ACR claim'inde MFA referansı
  if (acr.includes('multi-factor') || acr.includes('mfa')) {
    return true;
  }

  // Sosyal login (Google vb.) ile yeniden doğrulama: prompt=login + max_age=0
  // gönderildiğinde Auth0 amr'ye 'fed' (federated) veya sosyal provider adını ekler.
  // Bu da taze bir re-authentication kanıtıdır (step-up olarak kabul edilir).
  if (amr.some((v) => v === 'fed' || v === 'social' || v === 'google-oauth2' || v === 'pwd')) {
    return true;
  }

  return false;
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

function cloneChallengeEntry(entry) {
  if (!entry) return null;

  return {
    ...entry,
    pendingArgs: entry.pendingArgs && typeof entry.pendingArgs === 'object'
      ? { ...entry.pendingArgs }
      : entry.pendingArgs ?? null,
  };
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
    verifiedAt: null,
    verifiedAuthTimestamp: null,
    verifiedMfaDetected: false,
  };

  stepUpChallenges.set(challengeId, entry);
  return cloneChallengeEntry(entry);
}

function getStepUpChallenge(challengeId, userId = null) {
  cleanupExpiredChallenges();

  if (!challengeId) return null;

  const entry = stepUpChallenges.get(challengeId);
  if (!entry) return null;
  if (userId && entry.userId !== userId) return null;

  return cloneChallengeEntry(entry);
}

function markStepUpChallengeVerified({
  challengeId,
  userId,
  authTimestamp,
  mfaDetected = false,
  skipTimestampCheck = false,
}) {
  cleanupExpiredChallenges();

  if (!challengeId) {
    return { approved: false, reason: 'challenge_missing', entry: null };
  }

  const entry = stepUpChallenges.get(challengeId);
  if (!entry) {
    return { approved: false, reason: 'challenge_not_found', entry: null };
  }

  if (entry.userId !== userId) {
    return { approved: false, reason: 'challenge_user_mismatch', entry: null };
  }

  // skipTimestampCheck: Inline confirm (mevcut ID token) kullanıldığında
  // authTimestamp kontrolü atlanır. Token zaten JWT olarak doğrulanmış,
  // challenge'ın kullanıcıya ait olduğu teyit edilmiş.
  if (!skipTimestampCheck) {
    if (!(typeof authTimestamp === 'number' && authTimestamp > 0)) {
      return { approved: false, reason: 'auth_timestamp_missing', entry: null };
    }

    if (authTimestamp + STEP_UP_CLOCK_SKEW_SECONDS < entry.createdAt) {
      return { approved: false, reason: 'auth_not_fresh_after_challenge', entry: null };
    }
  }

  if (STEP_UP_REQUIRE_MFA_CLAIM && !mfaDetected) {
    return { approved: false, reason: 'mfa_claim_missing', entry: null };
  }

  const effectiveAuthTimestamp = (typeof authTimestamp === 'number' && authTimestamp > 0)
    ? authTimestamp
    : nowSeconds();

  entry.verifiedAt = nowSeconds();
  entry.verifiedAuthTimestamp = effectiveAuthTimestamp;
  entry.verifiedMfaDetected = !!mfaDetected;

  stepUpChallenges.set(challengeId, entry);
  return {
    approved: true,
    reason: skipTimestampCheck ? 'challenge_verified_inline' : 'challenge_verified',
    entry: cloneChallengeEntry(entry),
  };
}

function consumeStepUpChallenge({
  challengeId,
  userId,
  action,
  authTimestamp,
  mfaDetected = null,
}) {
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

  const effectiveAuthTimestamp = typeof authTimestamp === 'number' && authTimestamp > 0
    ? authTimestamp
    : entry.verifiedAuthTimestamp;
  const effectiveMfaDetected = typeof mfaDetected === 'boolean'
    ? mfaDetected
    : !!entry.verifiedMfaDetected;

  if (!(typeof effectiveAuthTimestamp === 'number' && effectiveAuthTimestamp > 0)) {
    return { approved: false, reason: 'auth_timestamp_missing' };
  }

  // Popup sonrası gelen token, challenge üretiminden sonra doğrulanmış olmalı.
  if (effectiveAuthTimestamp + STEP_UP_CLOCK_SKEW_SECONDS < entry.createdAt) {
    return { approved: false, reason: 'auth_not_fresh_after_challenge' };
  }

  if (STEP_UP_REQUIRE_MFA_CLAIM && !effectiveMfaDetected) {
    return { approved: false, reason: 'mfa_claim_missing' };
  }

  stepUpChallenges.delete(challengeId);
  return {
    approved: true,
    reason: 'challenge_verified',
    entry: cloneChallengeEntry(entry),
  };
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
  getStepUpChallenge,
  markStepUpChallengeVerified,
  consumeStepUpChallenge,
};
