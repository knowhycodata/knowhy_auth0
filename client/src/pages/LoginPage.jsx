import { useAuth0 } from '@auth0/auth0-react';
import { useTranslation } from 'react-i18next';
import { Mail, Shield, Lock, Globe } from 'lucide-react';

export default function LoginPage() {
  const { loginWithRedirect } = useAuth0();
  const { t, i18n } = useTranslation();

  const toggleLanguage = () => {
    const newLng = i18n.language === 'tr' ? 'en' : 'tr';
    i18n.changeLanguage(newLng);
  };

  return (
    <div className="min-h-screen bg-dark-950 flex">
      {/* Left Panel - Branding */}
      <div className="hidden lg:flex lg:w-1/2 bg-gradient-to-br from-primary-900/40 via-dark-900 to-dark-950 flex-col justify-between p-12">
        <div>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-primary-600 rounded-xl flex items-center justify-center">
              <Mail className="w-5 h-5 text-white" />
            </div>
            <h1 className="text-2xl font-bold text-white">Knowhy</h1>
          </div>
        </div>

        <div className="space-y-8">
          <h2 className="text-4xl font-bold text-white leading-tight">
            {t('app.description')}
          </h2>

          <div className="space-y-4">
            <Feature
              icon={<Shield className="w-5 h-5 text-primary-400" />}
              title="Zero Trust Architecture"
              desc="Auth0 Token Vault ile token'larınız güvende"
            />
            <Feature
              icon={<Lock className="w-5 h-5 text-primary-400" />}
              title="Blind Token Injection"
              desc="AI modelleri hiçbir zaman token görmez"
            />
            <Feature
              icon={<Mail className="w-5 h-5 text-primary-400" />}
              title="Gmail Integration"
              desc="E-postalarınızı okuyun, özetleyin, yönetin"
            />
          </div>
        </div>

        <p className="text-dark-500 text-sm">
          Auth0 "Authorized to Act" Hackathon
        </p>
      </div>

      {/* Right Panel - Login */}
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="w-full max-w-md space-y-8">
          {/* Language Toggle */}
          <div className="flex justify-end">
            <button
              onClick={toggleLanguage}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm text-dark-400 hover:text-dark-200 hover:bg-dark-800 transition-colors"
            >
              <Globe size={14} />
              {i18n.language === 'tr' ? 'English' : 'Türkçe'}
            </button>
          </div>

          {/* Mobile Logo */}
          <div className="lg:hidden flex items-center gap-3 justify-center">
            <div className="w-10 h-10 bg-primary-600 rounded-xl flex items-center justify-center">
              <Mail className="w-5 h-5 text-white" />
            </div>
            <h1 className="text-2xl font-bold text-white">Knowhy</h1>
          </div>

          <div className="text-center">
            <h2 className="text-2xl font-bold text-white">{t('auth.loginTitle')}</h2>
            <p className="text-dark-400 mt-2">{t('auth.loginSubtitle')}</p>
          </div>

          <div className="space-y-4">
            <button
              onClick={() => loginWithRedirect()}
              className="btn-primary w-full flex items-center justify-center gap-2 py-3 text-base"
            >
              <Mail size={18} />
              {t('auth.login')}
            </button>

            <button
              onClick={() => loginWithRedirect({ authorizationParams: { screen_hint: 'signup' } })}
              className="btn-secondary w-full flex items-center justify-center gap-2 py-3 text-base"
            >
              {t('auth.signup')}
            </button>
          </div>

          <div className="text-center">
            <p className="text-dark-500 text-xs">
              {t('settings.securityDescription')}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function Feature({ icon, title, desc }) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 p-2 bg-dark-800 rounded-lg">{icon}</div>
      <div>
        <h3 className="text-white font-medium text-sm">{title}</h3>
        <p className="text-dark-400 text-sm">{desc}</p>
      </div>
    </div>
  );
}
