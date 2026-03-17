import { useState, useRef, useEffect } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { useTranslation } from 'react-i18next';
import { Send, Loader2, Mail, BookOpen, PenLine, Bot, User } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { chatApi } from '../services/api';

export default function ChatPage() {
  const { user, getAccessTokenSilently } = useAuth0();
  const { t, i18n } = useTranslation();
  const tokenParams = {
    authorizationParams: {
      audience: import.meta.env.VITE_AUTH0_AUDIENCE || 'https://knowhy-api.local',
      scope: 'openid profile email offline_access',
    },
  };
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [conversationId, setConversationId] = useState(null);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = async (content) => {
    if (!content.trim() || isLoading) return;

    const userMessage = { role: 'user', content: content.trim() };
    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    try {
      const token = await getAccessTokenSilently(tokenParams);
      const data = await chatApi.sendMessage(token, {
        message: content.trim(),
        conversationId,
        locale: i18n.language,
      });

      if (data.success) {
        setConversationId(data.conversationId);
        setMessages((prev) => [...prev, data.message]);
      }
    } catch (error) {
      const errMsg = error.data?.error || error.message || t('common.error');
      toast.error(errMsg);
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `Error: ${errMsg}` },
      ]);
    } finally {
      setIsLoading(false);
      inputRef.current?.focus();
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    sendMessage(input);
  };

  const suggestions = [
    { icon: Mail, text: t('chat.suggestions.readEmails'), action: t('chat.suggestions.readEmails') },
    { icon: BookOpen, text: t('chat.suggestions.summarize'), action: t('chat.suggestions.summarize') },
    { icon: PenLine, text: t('chat.suggestions.draft'), action: t('chat.suggestions.draft') },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto px-4 py-6">
        {messages.length === 0 ? (
          <WelcomeScreen
            name={user?.given_name || user?.name || 'User'}
            suggestions={suggestions}
            onSuggestionClick={(action) => sendMessage(action)}
            t={t}
          />
        ) : (
          <div className="max-w-3xl mx-auto space-y-6">
            {messages.map((msg, idx) => (
              <MessageBubble key={idx} message={msg} />
            ))}
            {isLoading && (
              <div className="flex items-start gap-3 animate-fade-in">
                <div className="w-8 h-8 bg-primary-600/20 rounded-lg flex items-center justify-center flex-shrink-0">
                  <Bot size={16} className="text-primary-400" />
                </div>
                <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-dark-800 border border-dark-700">
                  <Loader2 size={14} className="animate-spin text-primary-400" />
                  <span className="text-sm text-dark-400">{t('chat.thinking')}</span>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input Area */}
      <div className="border-t border-dark-700 bg-dark-900/50 backdrop-blur-sm p-4">
        <form onSubmit={handleSubmit} className="max-w-3xl mx-auto flex gap-3">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t('chat.placeholder')}
            className="input-field flex-1"
            disabled={isLoading}
            maxLength={5000}
          />
          <button
            type="submit"
            disabled={!input.trim() || isLoading}
            className="btn-primary px-4"
          >
            {isLoading ? (
              <Loader2 size={18} className="animate-spin" />
            ) : (
              <Send size={18} />
            )}
          </button>
        </form>
      </div>
    </div>
  );
}

function WelcomeScreen({ name, suggestions, onSuggestionClick, t }) {
  return (
    <div className="flex flex-col items-center justify-center h-full max-w-2xl mx-auto animate-fade-in">
      <div className="w-16 h-16 bg-primary-600/20 rounded-2xl flex items-center justify-center mb-6">
        <Bot size={32} className="text-primary-400" />
      </div>
      <h2 className="text-2xl font-bold text-white mb-2">
        {t('chat.welcomeTitle', { name })}
      </h2>
      <p className="text-dark-400 text-center mb-8 max-w-md">
        {t('chat.welcomeMessage')}
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 w-full max-w-lg">
        {suggestions.map((s, idx) => (
          <button
            key={idx}
            onClick={() => onSuggestionClick(s.action)}
            className="card hover:bg-dark-700/50 transition-all duration-200 text-left group cursor-pointer"
          >
            <s.icon
              size={20}
              className="text-primary-400 mb-2 group-hover:scale-110 transition-transform"
            />
            <p className="text-sm text-dark-200">{s.text}</p>
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageBubble({ message }) {
  const isUser = message.role === 'user';

  return (
    <div
      className={clsx(
        'flex items-start gap-3 animate-slide-up',
        isUser && 'flex-row-reverse'
      )}
    >
      <div
        className={clsx(
          'w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0',
          isUser ? 'bg-dark-700' : 'bg-primary-600/20'
        )}
      >
        {isUser ? (
          <User size={16} className="text-dark-300" />
        ) : (
          <Bot size={16} className="text-primary-400" />
        )}
      </div>
      <div
        className={clsx(
          'max-w-[75%] px-4 py-3 rounded-xl text-sm',
          isUser
            ? 'bg-primary-600 text-white rounded-tr-sm'
            : 'bg-dark-800 border border-dark-700 text-dark-100 rounded-tl-sm'
        )}
      >
        <ReactMarkdown className="prose prose-invert prose-sm max-w-none">
          {message.content}
        </ReactMarkdown>
      </div>
    </div>
  );
}
