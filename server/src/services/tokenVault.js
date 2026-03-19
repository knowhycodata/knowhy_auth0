const axios = require('axios');
const logger = require('../utils/logger');

const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN;
// M2M (Machine-to-Machine) client - Management API erişimi için
const M2M_CLIENT_ID = process.env.AUTH0_CUSTOM_API_CLIENT_ID;
const M2M_CLIENT_SECRET = process.env.AUTH0_CUSTOM_API_CLIENT_SECRET;
const REQUIRED_GMAIL_SCOPES = String(
  process.env.GMAIL_REQUIRED_SCOPES
  || 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.modify'
)
  .split(/[ ,]+/)
  .map((s) => s.trim())
  .filter(Boolean);

// Cache for M2M token
let m2mTokenCache = {
  token: null,
  expiresAt: 0,
};

/**
 * Get a Machine-to-Machine (M2M) access token from Auth0.
 * This is used to call Auth0 Management API and Token Vault endpoints.
 */
async function getM2MToken() {
  if (m2mTokenCache.token && Date.now() < m2mTokenCache.expiresAt - 60000) {
    return m2mTokenCache.token;
  }

  try {
    const response = await axios.post(`https://${AUTH0_DOMAIN}/oauth/token`, {
      grant_type: 'client_credentials',
      client_id: M2M_CLIENT_ID,
      client_secret: M2M_CLIENT_SECRET,
      audience: `https://${AUTH0_DOMAIN}/api/v2/`,
    });

    m2mTokenCache = {
      token: response.data.access_token,
      expiresAt: Date.now() + (response.data.expires_in * 1000),
    };

    logger.debug('M2M token obtained successfully');
    return m2mTokenCache.token;
  } catch (error) {
    logger.error('Failed to get M2M token:', error.response?.data || error.message);
    throw new Error('Failed to authenticate with Auth0');
  }
}

async function getUserIdentities(auth0UserId, m2mToken) {
  const response = await axios.get(
    `https://${AUTH0_DOMAIN}/api/v2/users/${encodeURIComponent(auth0UserId)}`,
    {
      headers: {
        Authorization: `Bearer ${m2mToken}`,
      },
      params: {
        fields: 'identities',
        include_fields: true,
      },
    }
  );

  return Array.isArray(response.data?.identities) ? response.data.identities : [];
}

function findGoogleIdentity(identities = []) {
  return identities.find((identity) => identity.provider === 'google-oauth2') || null;
}

/**
 * Get the user's federated (Google) access token from Auth0 Token Vault.
 * CRITICAL: This token is NEVER exposed to the LLM or frontend.
 * It stays within the backend "remote arm" only.
 *
 * @param {string} auth0UserId - The user's Auth0 ID (e.g., "google-oauth2|123...")
 * @returns {string} The Google access token
 */
async function getFederatedToken(auth0UserId) {
  try {
    const m2mToken = await getM2MToken();

    // Get user's identity with the access token from Token Vault
    const identities = await getUserIdentities(auth0UserId, m2mToken);
    if (!identities || identities.length === 0) {
      throw new Error('No identities found for user');
    }

    // Find the Google identity
    const googleIdentity = findGoogleIdentity(identities);

    if (!googleIdentity) {
      throw new Error('Google identity not found. User needs to connect Gmail first.');
    }

    if (!googleIdentity.access_token) {
      throw new Error('Google access token not available. Token Vault may not be configured.');
    }

    logger.info('Federated Google token retrieved from Token Vault', {
      userId: auth0UserId,
      provider: 'google-oauth2',
    });

    return googleIdentity.access_token;
  } catch (error) {
    if (error.response?.status === 401) {
      // Clear cached M2M token and retry once
      m2mTokenCache = { token: null, expiresAt: 0 };
      logger.warn('M2M token expired, retrying...');
      return getFederatedToken(auth0UserId);
    }

    logger.error('Failed to get federated token:', {
      userId: auth0UserId,
      error: error.response?.data || error.message,
    });
    throw error;
  }
}

/**
 * Refresh the user's federated token if needed.
 * Auth0 Token Vault handles refresh token rotation automatically.
 */
async function refreshFederatedToken(auth0UserId) {
  try {
    const m2mToken = await getM2MToken();

    // Auth0 Token Vault supports token refresh via the Management API
    // When upstream_params includes access_type=offline, Auth0 stores the refresh token
    // and automatically refreshes the access token when needed
    const identities = await getUserIdentities(auth0UserId, m2mToken);
    const googleIdentity = findGoogleIdentity(identities);

    if (googleIdentity?.refresh_token) {
      logger.info('Token refresh available for user', { userId: auth0UserId });
      return true;
    }

    return false;
  } catch (error) {
    logger.error('Token refresh check failed:', error.message);
    return false;
  }
}

function hasRequiredScopes(scopeString = '', requiredScopes = REQUIRED_GMAIL_SCOPES) {
  const granted = new Set(
    String(scopeString || '')
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean)
  );

  return requiredScopes.every((scope) => granted.has(scope));
}

async function getGoogleTokenScopeString(accessToken) {
  const response = await axios.get('https://oauth2.googleapis.com/tokeninfo', {
    params: { access_token: accessToken },
    timeout: 5000,
  });
  return String(response.data?.scope || '');
}

async function isGoogleTokenUsable(accessToken) {
  if (!accessToken) return false;
  try {
    const scopeString = await getGoogleTokenScopeString(accessToken);
    return hasRequiredScopes(scopeString);
  } catch (scopeError) {
    const status = scopeError?.response?.status;
    if (status === 400 || status === 401) {
      return false;
    }

    // Geçici dış servis hatalarında güvenli tarafta kalıp bağlantıyı var kabul edelim.
    logger.warn('Google token usability check transient error', {
      status,
      error: scopeError.response?.data || scopeError.message,
    });
    return true;
  }
}

/**
 * Check if a user has a connected Google account in Token Vault.
 */
async function hasGoogleConnection(auth0UserId) {
  try {
    const m2mToken = await getM2MToken();

    const identities = await getUserIdentities(auth0UserId, m2mToken);
    const googleIdentity = findGoogleIdentity(identities);

    if (!googleIdentity?.access_token) {
      return false;
    }

    try {
      const scopeString = await getGoogleTokenScopeString(googleIdentity.access_token);
      const scopeOk = hasRequiredScopes(scopeString);
      if (!scopeOk) {
        logger.warn('Google connection exists but required Gmail scopes are missing', {
          userId: auth0UserId,
          requiredScopes: REQUIRED_GMAIL_SCOPES,
          grantedScopes: scopeString,
        });
      }
      return scopeOk;
    } catch (scopeError) {
      const status = scopeError?.response?.status;
      // Invalid/expired token => bağlantı geçersiz kabul edilir.
      if (status === 400 || status === 401) {
        logger.warn('Google token scope validation failed with invalid token', {
          userId: auth0UserId,
          status,
          error: scopeError.response?.data || scopeError.message,
        });
        return false;
      }

      // Dış servis geçici sorunu varsa bağlantıyı var kabul edip akışı kilitlemeyelim.
      logger.warn('Google token scope validation skipped due transient error', {
        userId: auth0UserId,
        status,
        error: scopeError.response?.data || scopeError.message,
      });
      return true;
    }
  } catch (error) {
    logger.error('Google connection check failed:', error.message);
    return false;
  }
}

async function disconnectGoogleConnection(auth0UserId, hasRetried = false) {
  try {
    const m2mToken = await getM2MToken();
    const identities = await getUserIdentities(auth0UserId, m2mToken);
    const googleIdentity = findGoogleIdentity(identities);

    if (!googleIdentity) {
      return { disconnected: true, reason: 'already_disconnected' };
    }

    // Best-effort revoke on Google side.
    if (googleIdentity.access_token) {
      try {
        await axios.post(
          'https://oauth2.googleapis.com/revoke',
          new URLSearchParams({ token: googleIdentity.access_token }).toString(),
          {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 5000,
            validateStatus: () => true,
          }
        );
      } catch (revokeError) {
        logger.warn('Google token revoke failed (continuing with unlink)', {
          userId: auth0UserId,
          error: revokeError.message,
        });
      }
    }

    const identityUserId = String(googleIdentity.user_id || '').trim();
    if (!identityUserId) {
      logger.warn('Google identity user_id missing; cannot unlink identity', { userId: auth0UserId });
      const tokenUsable = await isGoogleTokenUsable(googleIdentity.access_token);
      return {
        disconnected: !tokenUsable,
        reason: tokenUsable
          ? 'google_identity_user_id_missing'
          : 'token_revoked_without_identity_user_id',
      };
    }

    try {
      await axios.delete(
        `https://${AUTH0_DOMAIN}/api/v2/users/${encodeURIComponent(auth0UserId)}/identities/google-oauth2/${encodeURIComponent(identityUserId)}`,
        {
          headers: {
            Authorization: `Bearer ${m2mToken}`,
          },
        }
      );
    } catch (unlinkError) {
      const unlinkStatus = unlinkError?.response?.status;
      const unlinkCode = String(unlinkError?.response?.data?.errorCode || '');
      const isMainIdentityConstraint = unlinkStatus === 400 && unlinkCode === 'delete_main_user_identity';

      if (isMainIdentityConstraint) {
        const tokenUsable = await isGoogleTokenUsable(googleIdentity.access_token);
        if (!tokenUsable) {
          logger.info('Main identity cannot be unlinked; token already unusable, treating as disconnected', {
            userId: auth0UserId,
          });
          return { disconnected: true, reason: 'main_identity_token_revoked' };
        }

        logger.warn('Main identity cannot be unlinked and token is still usable', {
          userId: auth0UserId,
          status: unlinkStatus,
          errorCode: unlinkCode,
        });
        return { disconnected: false, reason: 'main_identity_cannot_be_unlinked', status: unlinkStatus };
      }

      throw unlinkError;
    }

    const refreshedIdentities = await getUserIdentities(auth0UserId, m2mToken);
    const stillConnected = !!findGoogleIdentity(refreshedIdentities);
    if (stillConnected) {
      logger.warn('Google identity still present after unlink attempt', { userId: auth0UserId });
      return { disconnected: false, reason: 'identity_still_present' };
    }

    return { disconnected: true, reason: 'unlinked' };
  } catch (error) {
    if (!hasRetried && error.response?.status === 401) {
      m2mTokenCache = { token: null, expiresAt: 0 };
      logger.warn('M2M token expired during disconnect, retrying once');
      return disconnectGoogleConnection(auth0UserId, true);
    }

    if (error.response?.status === 404) {
      return { disconnected: true, reason: 'already_disconnected' };
    }

    logger.error('Failed to disconnect Google connection:', {
      userId: auth0UserId,
      error: error.response?.data || error.message,
      status: error.response?.status,
    });
    return { disconnected: false, reason: 'disconnect_failed', status: error.response?.status };
  }
}

module.exports = {
  getM2MToken,
  getFederatedToken,
  refreshFederatedToken,
  hasGoogleConnection,
  disconnectGoogleConnection,
};
