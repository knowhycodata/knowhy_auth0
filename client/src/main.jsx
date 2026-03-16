import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Auth0Provider } from '@auth0/auth0-react';
import App from './App';
import { I18nProvider } from './i18n';
import './index.css';

const domain = import.meta.env.VITE_AUTH0_DOMAIN || 'dev-hdi3zfepybw0hr5z.us.auth0.com';
const clientId = import.meta.env.VITE_AUTH0_CLIENT_ID || '8VYRhkRHMjm8M62L0z6ugemrs6uvFV6q';
const audience = import.meta.env.VITE_AUTH0_AUDIENCE || `https://${domain}/api/v2/`;

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <Auth0Provider
        domain={domain}
        clientId={clientId}
        authorizationParams={{
          redirect_uri: window.location.origin,
          audience: audience,
          scope: 'openid profile email offline_access',
        }}
        cacheLocation="localstorage"
        useRefreshTokens={true}
      >
        <I18nProvider>
          <App />
        </I18nProvider>
      </Auth0Provider>
    </BrowserRouter>
  </React.StrictMode>
);
