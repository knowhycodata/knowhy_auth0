import { useCallback, useEffect, useState } from 'react';
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
  History,
  Loader2,
} from 'lucide-react';
import clsx from 'clsx';
import { chatApi } from '../services/api';

export default function Sidebar() {
  const { user, logout, getAccessTokenSilently, isAuthenticated } = useAuth0();
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [conversations, setConversations] = useState([]);
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const [avatarLoadFailed, setAvatarLoadFailed] = useState(false);
  const audience = import.meta.env.VITE_AUTH0_AUDIENCE || 'https://knowhy-api.local';
  const tokenParams = {
    authorizationParams: {
      audience,
      scope: 'openid profile email offline_access',
    },
  };

  const toggleLanguage = () => {
    const newLng = i18n.language === 'tr' ? 'en' : 'tr';
    i18n.changeLanguage(newLng);
  };

  const navItems = [
    { icon: MessageSquare, label: t('nav.chat'), path: '/' },
    { icon: Settings, label: t('nav.settings'), path: '/settings' },
  ];

  const activeConversationId = location.pathname.startsWith('/chat/')
    ? location.pathname.replace('/chat/', '')
    : null;

  const refreshConversations = useCallback(async () => {
    if (!isAuthenticated) {
      setConversations([]);
      setIsHistoryLoading(false);
      setHistoryError(false);
      return;
    }

    setIsHistoryLoading(true);
    setHistoryError(false);

    try {
      const token = await getAccessTokenSilently(tokenParams);
      const data = await chatApi.getConversations(token);
      setConversations(data?.conversations || []);
    } catch (error) {
      setHistoryError(true);
    } finally {
      setIsHistoryLoading(false);
    }
  }, [getAccessTokenSilently, isAuthenticated]);

  useEffect(() => {
    setAvatarLoadFailed(false);
  }, [user?.picture]);

  useEffect(() => {
    refreshConversations();
  }, [refreshConversations, location.pathname]);

  useEffect(() => {
    const onConversationUpdated = () => {
      refreshConversations();
    };

    window.addEventListener('knowhy:conversation-updated', onConversationUpdated);
    return () => {
      window.removeEventListener('knowhy:conversation-updated', onConversationUpdated);
    };
  }, [refreshConversations]);

  const getConversationTitle = (conversation) => {
    const title = typeof conversation?.title === 'string' ? conversation.title.trim() : '';
    if (title.length > 0) return title;

    const lastMessage = typeof conversation?.last_message === 'string'
      ? conversation.last_message.trim()
      : '';
    if (lastMessage.length > 0) {
      return lastMessage.slice(0, 48);
    }

    return t('chat.newChat');
  };

  const userInitial = String(user?.name || user?.email || '?')
    .trim()
    .charAt(0)
    .toUpperCase() || '?';

  return (
    <aside
      className={clsx(
        'flex flex-col bg-dark-900 border-r border-dark-700 transition-[width] duration-300',
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
              <h1 className="text-sm font-bold text-white">Knowhy</h1>
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
          onClick={() => navigate('/chat/new')}
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
          const isActive = item.path === '/'
            ? location.pathname === '/' || location.pathname.startsWith('/chat/')
            : location.pathname === item.path;
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

        {!collapsed && (
          <div className="mt-4 border-t border-dark-700 pt-3">
            <div className="flex items-center gap-2 px-2 mb-2 text-[11px] uppercase tracking-wide text-dark-400">
              <History size={14} />
              <span>{t('nav.history')}</span>
            </div>

            {isHistoryLoading && (
              <div className="flex items-center gap-2 px-2 py-2 text-xs text-dark-400">
                <Loader2 size={14} className="animate-spin" />
                <span>{t('common.loading')}</span>
              </div>
            )}

            {!isHistoryLoading && historyError && (
              <p className="px-2 py-2 text-xs text-red-400">
                {t('chat.historyLoadError')}
              </p>
            )}

            {!isHistoryLoading && !historyError && conversations.length === 0 && (
              <p className="px-2 py-2 text-xs text-dark-500">
                {t('chat.noHistory')}
              </p>
            )}

            {!isHistoryLoading && !historyError && conversations.length > 0 && (
              <div className="space-y-1 max-h-64 overflow-y-auto pr-1">
                {conversations.map((conversation) => {
                  const isConversationActive = activeConversationId === conversation.id;
                  const title = getConversationTitle(conversation);

                  return (
                    <button
                      key={conversation.id}
                      onClick={() => navigate(`/chat/${conversation.id}`)}
                      className={clsx(
                        'w-full text-left px-2.5 py-2 rounded-lg transition-colors',
                        isConversationActive
                          ? 'bg-primary-600/10 border border-primary-600/20'
                          : 'hover:bg-dark-800'
                      )}
                      title={title}
                    >
                      <p className={clsx(
                        'text-xs truncate',
                        isConversationActive ? 'text-primary-300' : 'text-dark-200'
                      )}
                      >
                        {title}
                      </p>
                      {conversation.last_message && (
                        <p className="text-[11px] text-dark-500 truncate mt-0.5">
                          {conversation.last_message}
                        </p>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
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
            collapsed && 'justify-center px-2'
          )}
        >
          <div className="w-8 h-8 rounded-full ring-2 ring-dark-600 overflow-hidden bg-dark-700 flex items-center justify-center flex-shrink-0">
            {user?.picture && !avatarLoadFailed ? (
              <img
                src={user.picture}
                alt={user?.name || 'User avatar'}
                onError={() => setAvatarLoadFailed(true)}
                className="w-full h-full object-cover"
              />
            ) : (
              <span className="text-xs font-semibold text-dark-200">
                {userInitial}
              </span>
            )}
          </div>
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
