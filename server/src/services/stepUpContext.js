const STEP_UP_WINDOW_SECONDS = Number(process.env.STEP_UP_WINDOW_SECONDS || 300);
const STEP_UP_REQUIRE_MFA_CLAIM = process.env.STEP_UP_REQUIRE_MFA_CLAIM === 'true';

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
  if (Number.isFinite(authTime) && authTime > 0) return authTime;

  const issuedAt = Number(claims.issuedAt);
  if (Number.isFinite(issuedAt) && issuedAt > 0) return issuedAt;

  return null;
}

function buildStepUpContextFromClaims(claims = {}) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const authTimestamp = resolveAuthTimestamp(claims);
  const authAgeSeconds = authTimestamp ? nowSeconds - authTimestamp : null;
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
    windowSeconds: STEP_UP_WINDOW_SECONDS,
    requireMfaClaim: STEP_UP_REQUIRE_MFA_CLAIM,
  };
}

module.exports = {
  buildStepUpContextFromClaims,
};
