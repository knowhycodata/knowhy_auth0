const axios = require('axios');
const logger = require('../utils/logger');

const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN;
// M2M (Machine-to-Machine) client - Management API erişimi için
const M2M_CLIENT_ID = process.env.AUTH0_CUSTOM_API_CLIENT_ID;
const M2M_CLIENT_SECRET = process.env.AUTH0_CUSTOM_API_CLIENT_SECRET;

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

    const identities = response.data.identities;
    if (!identities || identities.length === 0) {
      throw new Error('No identities found for user');
    }

    // Find the Google identity
    const googleIdentity = identities.find(
      (identity) => identity.provider === 'google-oauth2'
    );

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

    const googleIdentity = response.data.identities?.find(
      (identity) => identity.provider === 'google-oauth2'
    );

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

/**
 * Check if a user has a connected Google account in Token Vault.
 */
async function hasGoogleConnection(auth0UserId) {
  try {
    const m2mToken = await getM2MToken();

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

    const googleIdentity = response.data.identities?.find(
      (identity) => identity.provider === 'google-oauth2'
    );

    return !!googleIdentity?.access_token;
  } catch (error) {
    logger.error('Google connection check failed:', error.message);
    return false;
  }
}

module.exports = {
  getM2MToken,
  getFederatedToken,
  refreshFederatedToken,
  hasGoogleConnection,
};
