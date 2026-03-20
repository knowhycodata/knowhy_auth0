const API_URL = import.meta.env.VITE_API_URL || '';

/**
 * Backend API ile iletişim katmanı.
 * Auth0 access token'ı her istekle birlikte gönderilir.
 */

async function request(endpoint, options = {}) {
  const { method = 'GET', body, token, locale } = options;

  const headers = {
    'Content-Type': 'application/json',
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  if (locale) {
    headers['Accept-Language'] = locale;
  }

  const config = {
    method,
    headers,
  };

  if (body && method !== 'GET') {
    config.body = JSON.stringify(body);
  }

  const res = await fetch(`${API_URL}${endpoint}`, config);

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const error = new Error(data.error || `Request failed: ${res.status}`);
    error.status = res.status;
    error.data = data;
    throw error;
  }

  return res.json();
}

// ---- Auth ----
export const authApi = {
  getProfile: (token) => request('/api/auth/profile', { token }),
  updateLocale: (token, locale) => request('/api/auth/locale', { method: 'PUT', token, body: { locale } }),
  connectGmail: (token) => request('/api/auth/connect-gmail', { method: 'POST', token }),
  disconnectGmail: (token) => request('/api/auth/disconnect-gmail', { method: 'POST', token }),
  gmailCallback: (token) => request('/api/auth/gmail-callback', { method: 'POST', token }),
};

// ---- Chat ----
export const chatApi = {
  sendMessage: (token, {
    message,
    conversationId,
    locale,
    stepUpChallengeId,
    stepUpToken,
  }) =>
    request('/api/chat', {
      method: 'POST',
      token,
      body: { message, conversationId, locale, stepUpChallengeId, stepUpToken },
    }),

  getConversations: (token) => request('/api/chat/conversations', { token }),
};

// ---- Email ----
export const emailApi = {
  getStatus: (token) => request('/api/email/status', { token }),
  readEmails: (token, options = {}) => request('/api/email/read', { method: 'POST', token, body: options }),
  readDetail: (token, messageId) => request('/api/email/detail', { method: 'POST', token, body: { messageId } }),
  sendEmail: (token, data) => request('/api/email/send', { method: 'POST', token, body: data }),
  deleteEmail: (token, emailId, stepUpToken) =>
    request('/api/email/delete', { method: 'POST', token, body: { emailId, stepUpToken } }),
};

// ---- User ----
export const userApi = {
  getConversations: (token) => request('/api/user/conversations', { token }),
  getMessages: (token, conversationId) => request(`/api/user/conversations/${conversationId}/messages`, { token }),
  deleteConversation: (token, conversationId) =>
    request(`/api/user/conversations/${conversationId}`, { method: 'DELETE', token }),
  getEmailSummaries: (token) => request('/api/user/email-summaries', { token }),
};

// ---- Step-up Auth ----
export const stepUpApi = {
  initiate: (token, action, bindingMessage) =>
    request('/api/auth/stepup/initiate', { method: 'POST', token, body: { action, bindingMessage } }),

  poll: (token, authReqId) =>
    request('/api/auth/stepup/poll', { method: 'POST', token, body: { authReqId } }),
};

// ---- Health ----
export const healthApi = {
  check: () => request('/api/health'),
};
