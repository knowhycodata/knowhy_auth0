const axios = require('axios');
const logger = require('../utils/logger');

const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN;
const AUTH0_CLIENT_ID = process.env.AUTH0_CLIENT_ID;
const AUTH0_CLIENT_SECRET = process.env.AUTH0_CLIENT_SECRET;

/**
 * STEP-UP AUTHENTICATION (CIBA Flow)
 * 
 * Hassas işlemler (e-posta gönderme/silme) için kullanıcıdan
 * ek kimlik doğrulaması (MFA) ister.
 * 
 * Auth0 Client-Initiated Backchannel Authentication (CIBA) kullanılır.
 * Kullanıcının mobil cihazına push notification gönderilir.
 */

/**
 * CIBA üzerinden asenkron yetkilendirme isteği başlat.
 * @param {string} userSub - Kullanıcının Auth0 sub claim'i
 * @param {string} bindingMessage - Kullanıcıya gösterilecek onay mesajı
 * @param {string} scope - İstenen scope (örn: "openid email")
 * @returns {{ authReqId: string, expiresIn: number, interval: number }}
 */
async function initiateStepUp(userSub, bindingMessage, scope = 'openid') {
  try {
    const response = await axios.post(
      `https://${AUTH0_DOMAIN}/bc-authorize`,
      new URLSearchParams({
        client_id: AUTH0_CLIENT_ID,
        client_secret: AUTH0_CLIENT_SECRET,
        login_hint: JSON.stringify({ format: 'iss_sub', iss: `https://${AUTH0_DOMAIN}/`, sub: userSub }),
        scope: scope,
        binding_message: bindingMessage,
        audience: `https://${AUTH0_DOMAIN}/api/v2/`,
      }).toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    const result = {
      authReqId: response.data.auth_req_id,
      expiresIn: response.data.expires_in,
      interval: response.data.interval || 5,
    };

    logger.info('Step-up auth initiated via CIBA', {
      userSub,
      authReqId: result.authReqId,
      expiresIn: result.expiresIn,
    });

    return result;
  } catch (error) {
    logger.error('CIBA initiation failed:', {
      error: error.response?.data || error.message,
      status: error.response?.status,
    });

    if (error.response?.status === 400) {
      throw new Error('Step-up authentication not available. Please ensure Auth0 Guardian is configured.');
    }

    throw new Error('Failed to initiate step-up authentication');
  }
}

/**
 * CIBA yetkilendirme durumunu kontrol et (poll).
 * @param {string} authReqId - CIBA auth request ID
 * @returns {{ status: 'pending'|'approved'|'rejected'|'expired', accessToken?: string }}
 */
async function checkStepUpStatus(authReqId) {
  try {
    const response = await axios.post(
      `https://${AUTH0_DOMAIN}/oauth/token`,
      {
        client_id: AUTH0_CLIENT_ID,
        client_secret: AUTH0_CLIENT_SECRET,
        auth_req_id: authReqId,
        grant_type: 'urn:openid:params:grant-type:ciba',
      },
      {
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );

    // Onay geldi
    logger.info('Step-up auth approved', { authReqId });
    return {
      status: 'approved',
      accessToken: response.data.access_token,
      expiresIn: response.data.expires_in,
    };
  } catch (error) {
    const errData = error.response?.data;

    if (errData?.error === 'authorization_pending') {
      return { status: 'pending' };
    }
    if (errData?.error === 'slow_down') {
      return { status: 'pending', slowDown: true };
    }
    if (errData?.error === 'access_denied') {
      logger.info('Step-up auth rejected by user', { authReqId });
      return { status: 'rejected' };
    }
    if (errData?.error === 'expired_token') {
      logger.info('Step-up auth expired', { authReqId });
      return { status: 'expired' };
    }

    logger.error('Step-up status check failed:', {
      authReqId,
      error: errData || error.message,
    });
    throw new Error('Failed to check step-up authentication status');
  }
}

/**
 * Step-up auth isteği başlat ve sonucu bekle (polling ile).
 * Frontend'den polling yapılacak, bu fonksiyon tek bir poll denemesi yapar.
 */
async function pollStepUp(authReqId) {
  return checkStepUpStatus(authReqId);
}

module.exports = {
  initiateStepUp,
  checkStepUpStatus,
  pollStepUp,
};
