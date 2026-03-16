import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth0 } from '@auth0/auth0-react';
import { useTranslation } from 'react-i18next';
import {
  MessageSquare,
  Settings,
  LogOut,
  Plus,
  Mail,
  Shield,
  ChevronLeft,
  ChevronRight,
  Globe,
} from 'lucide-react';
import clsx from 'clsx';

export default function Sidebar() {
  const { user, logout } = useAuth0();
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);

  const toggleLanguage = () => {
    const newLng = i18n.language === 'tr' ? 'en' : 'tr';
    i18n.changeLanguage(newLng);
  };

  const navItems = [
    { icon: MessageSquare, label: t('nav.chat'), path: '/' },
    { icon: Settings, label: t('nav.settings'), path: '/settings' },
  ];

  return (
    <aside
      className={clsx(
        'flex flex-col bg-dark-900 border-r border-dark-700 transition-all duration-300',
        collapsed ? 'w-16' : 'w-64'
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-dark-700">
        {!collapsed && (
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-primary-600 rounded-lg flex items-center justify-center">
              <Mail className="w-4 h-4 text-white" />
            </div>
            <div>
              <h1 className="text-sm font-bold text-white">KnowHy</h1>
              <p className="text-[10px] text-dark-400">{t('app.subtitle')}</p>
            </div>
          </div>
        )}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="p-1.5 rounded-md hover:bg-dark-700 text-dark-400 transition-colors"
        >
          {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </button>
      </div>

      {/* New Chat Button */}
      <div className="p-3">
        <button
          onClick={() => navigate('/')}
          className={clsx(
            'flex items-center gap-2 w-full btn-primary text-sm',
            collapsed && 'justify-center px-2'
          )}
        >
          <Plus size={16} />
          {!collapsed && <span>{t('chat.newChat')}</span>}
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 space-y-1">
        {navItems.map((item) => {
          const isActive = location.pathname === item.path;
          return (
            <button
              key={item.path}
              onClick={() => navigate(item.path)}
              className={clsx(
                'flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm transition-all duration-200',
                isActive
                  ? 'bg-primary-600/10 text-primary-400 border border-primary-600/20'
                  : 'text-dark-300 hover:bg-dark-800 hover:text-dark-100',
                collapsed && 'justify-center px-2'
              )}
            >
              <item.icon size={18} />
              {!collapsed && <span>{item.label}</span>}
            </button>
          );
        })}
      </nav>

      {/* Security Badge */}
      {!collapsed && (
        <div className="mx-3 mb-3 p-3 rounded-lg bg-dark-800/50 border border-dark-700">
          <div className="flex items-center gap-2 text-xs text-dark-400">
            <Shield size={14} className="text-green-500" />
            <span>Zero Trust · Token Vault</span>
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="border-t border-dark-700 p-3 space-y-2">
        {/* Language Toggle */}
        <button
          onClick={toggleLanguage}
          className={clsx(
            'flex items-center gap-2 w-full px-3 py-2 rounded-lg text-sm text-dark-300 hover:bg-dark-800 transition-colors',
            collapsed && 'justify-center px-2'
          )}
        >
          <Globe size={16} />
          {!collapsed && (
            <span>{i18n.language === 'tr' ? 'English' : 'Türkçe'}</span>
          )}
        </button>

        {/* User */}
        <div
          className={clsx(
            'flex items-center gap-3 px-3 py-2',
            collapsed && 'justify-center px-0'
          )}
        >
          {user?.picture && (
            <img
              src={user.picture}
              alt={user.name}
              className="w-8 h-8 rounded-full ring-2 ring-dark-600"
            />
          )}
          {!collapsed && (
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-dark-100 truncate">
                {user?.name}
              </p>
              <p className="text-xs text-dark-400 truncate">{user?.email}</p>
            </div>
          )}
        </div>

        {/* Logout */}
        <button
          onClick={() => logout({ logoutParams: { returnTo: window.location.origin } })}
          className={clsx(
            'flex items-center gap-2 w-full px-3 py-2 rounded-lg text-sm text-red-400 hover:bg-red-500/10 transition-colors',
            collapsed && 'justify-center px-2'
          )}
        >
          <LogOut size={16} />
          {!collapsed && <span>{t('nav.logout')}</span>}
        </button>
      </div>
    </aside>
  );
}
