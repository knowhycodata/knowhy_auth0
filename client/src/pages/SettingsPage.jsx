import { useState, useEffect } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { useTranslation } from 'react-i18next';
import {
  Settings,
  Globe,
  Mail,
  Shield,
  CheckCircle2,
  XCircle,
  Loader2,
  Link2,
  Unlink,
} from 'lucide-react';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { authApi } from '../services/api';

export default function SettingsPage() {
  const { user, getAccessTokenSilently } = useAuth0();
  const { t, i18n } = useTranslation();
  const [gmailConnected, setGmailConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    fetchProfile();
  }, []);

  const fetchProfile = async () => {
    try {
      const token = await getAccessTokenSilently();
      const data = await authApi.getProfile(token);
      if (data.success) {
        setGmailConnected(data.user.gmailConnected);
      }
    } catch (error) {
      toast.error(t('common.error'));
    } finally {
      setLoading(false);
    }
  };

  const handleConnectGmail = async () => {
    setConnecting(true);
    try {
      const token = await getAccessTokenSilently();
      const data = await authApi.connectGmail(token);
      if (data.success && data.connectionUrl) {
        window.open(data.connectionUrl, '_blank', 'width=600,height=700');
      }
    } catch (error) {
      toast.error(t('common.error'));
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnectGmail = async () => {
    try {
      const token = await getAccessTokenSilently();
      await authApi.disconnectGmail(token);
      setGmailConnected(false);
      toast.success(t('gmail.notConnected'));
    } catch (error) {
      toast.error(t('common.error'));
    }
  };

  const handleLanguageChange = async (lng) => {
    i18n.changeLanguage(lng);
    try {
      const token = await getAccessTokenSilently();
      await authApi.updateLocale(token, lng);
    } catch {
      // Non-critical, UI already changed
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-2xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3 mb-8">
          <div className="p-2 bg-dark-800 rounded-lg">
            <Settings size={24} className="text-primary-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">{t('settings.title')}</h1>
            <p className="text-sm text-dark-400">{user?.email}</p>
          </div>
        </div>

        {/* Language */}
        <SettingsCard
          icon={<Globe size={20} className="text-primary-400" />}
          title={t('settings.language')}
        >
          <div className="flex gap-2">
            {[
              { code: 'en', label: 'English' },
              { code: 'tr', label: 'Türkçe' },
            ].map((lng) => (
              <button
                key={lng.code}
                onClick={() => handleLanguageChange(lng.code)}
                className={clsx(
                  'px-4 py-2 rounded-lg text-sm font-medium transition-all',
                  i18n.language === lng.code
                    ? 'bg-primary-600 text-white'
                    : 'bg-dark-700 text-dark-300 hover:bg-dark-600'
                )}
              >
                {lng.label}
              </button>
            ))}
          </div>
        </SettingsCard>

        {/* Gmail Connection */}
        <SettingsCard
          icon={<Mail size={20} className="text-primary-400" />}
          title={t('settings.gmailAccess')}
        >
          {loading ? (
            <Loader2 size={20} className="animate-spin text-dark-400" />
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {gmailConnected ? (
                    <CheckCircle2 size={18} className="text-green-500" />
                  ) : (
                    <XCircle size={18} className="text-dark-500" />
                  )}
                  <span className="text-sm text-dark-200">
                    {gmailConnected ? t('gmail.connected') : t('gmail.notConnected')}
                  </span>
                </div>
                <button
                  onClick={gmailConnected ? handleDisconnectGmail : handleConnectGmail}
                  disabled={connecting}
                  className={clsx(
                    'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all',
                    gmailConnected
                      ? 'bg-red-600/10 text-red-400 hover:bg-red-600/20 border border-red-600/20'
                      : 'btn-primary'
                  )}
                >
                  {connecting ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : gmailConnected ? (
                    <Unlink size={14} />
                  ) : (
                    <Link2 size={14} />
                  )}
                  {gmailConnected ? t('gmail.disconnect') : t('gmail.connect')}
                </button>
              </div>
              <p className="text-xs text-dark-500">
                {t('gmail.securityNote')}
              </p>
            </div>
          )}
        </SettingsCard>

        {/* Security */}
        <SettingsCard
          icon={<Shield size={20} className="text-green-500" />}
          title={t('settings.security')}
        >
          <div className="space-y-3">
            <SecurityItem label="Auth0 Token Vault" status="active" />
            <SecurityItem label="Blind Token Injection" status="active" />
            <SecurityItem label="Guardrail Agent" status="active" />
            <SecurityItem label="Step-up Auth (MFA)" status="active" />
            <SecurityItem label="Audit Logging" status="active" />
          </div>
          <p className="text-xs text-dark-500 mt-4">
            {t('settings.securityDescription')}
          </p>
        </SettingsCard>
      </div>
    </div>
  );
}

function SettingsCard({ icon, title, children }) {
  return (
    <div className="card space-y-4">
      <div className="flex items-center gap-3">
        {icon}
        <h3 className="text-base font-semibold text-white">{title}</h3>
      </div>
      {children}
    </div>
  );
}

function SecurityItem({ label, status }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-sm text-dark-300">{label}</span>
      <span
        className={clsx(
          'text-xs font-medium px-2 py-0.5 rounded-full',
          status === 'active'
            ? 'bg-green-500/10 text-green-400'
            : 'bg-dark-700 text-dark-400'
        )}
      >
        {status === 'active' ? 'Active' : 'Pending'}
      </span>
    </div>
  );
}
