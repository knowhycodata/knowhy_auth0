import { useState, useRef, useEffect } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { Send, Loader2, Mail, BookOpen, PenLine, Bot, User } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { chatApi, stepUpApi, userApi } from '../services/api';

const STEP_UP_RESUME_TTL_MS = 5 * 60 * 1000;
const STEP_UP_ALLOWED_ACTIONS = new Set(['send_email', 'delete_email', 'delete_latest_email']);
const STEP_UP_CHALLENGE_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STEP_UP_CIBA_FALLBACK_ENABLED = import.meta.env.VITE_STEPUP_CIBA_FALLBACK === 'true';

function sleep(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function normalizeStepUpRequest(stepUpRequest) {
  if (!stepUpRequest || stepUpRequest.required !== true) return null;

  const action = String(stepUpRequest.action || '').trim().toLowerCase();
  if (!STEP_UP_ALLOWED_ACTIONS.has(action)) return null;

  const challengeId = String(stepUpRequest.challengeId || '').trim();
  if (!STEP_UP_CHALLENGE_ID_REGEX.test(challengeId)) return null;

  const expiresAtRaw = Number(stepUpRequest.expiresAt);
  if (!Number.isFinite(expiresAtRaw) || expiresAtRaw <= 0) return null;

  const message = typeof stepUpRequest.message === 'string'
    ? stepUpRequest.message.slice(0, 600)
    : '';

  return {
    required: true,
    action,
    challengeId,
    expiresAt: Math.floor(expiresAtRaw),
    message,
  };
}

function extractStepUpRequestFromMetadata(metadata) {
  if (!metadata) return null;

  let parsed = metadata;
  if (typeof metadata === 'string') {
    try {
      parsed = JSON.parse(metadata);
    } catch {
      return null;
    }
  }

  if (!parsed || typeof parsed !== 'object') return null;
  return normalizeStepUpRequest(parsed.stepUpRequest);
}

function isStepUpRequestExpired(stepUpRequest) {
  if (!stepUpRequest?.expiresAt) return true;
  return Math.floor(Date.now() / 1000) >= Number(stepUpRequest.expiresAt);
}

function formatStepUpActionLabel(action, language) {
  const trMap = {
    send_email: 'E-posta gönderme',
    delete_email: 'E-posta silme',
    delete_latest_email: 'Son e-postayı silme',
  };
  const enMap = {
    send_email: 'Send email',
    delete_email: 'Delete email',
    delete_latest_email: 'Delete latest email',
  };

  return language === 'tr'
    ? trMap[action] || 'Hassas işlem'
    : enMap[action] || 'High-stakes action';
}

export default function ChatPage() {
  const { user, getAccessTokenSilently, getIdTokenClaims } = useAuth0();
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { conversationId: routeConversationId } = useParams();
  const audience = import.meta.env.VITE_AUTH0_AUDIENCE || 'https://knowhy-api.local';
  const tokenParams = {
    authorizationParams: {
      audience,
      scope: 'openid profile email offline_access',
    },
  };
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [conversationId, setConversationId] = useState(null);
  const [stepUpInProgressChallengeId, setStepUpInProgressChallengeId] = useState(null);
  const [completedStepUpChallengeId, setCompletedStepUpChallengeId] = useState(null);
  const [pendingRetryContext, setPendingRetryContext] = useState(null);
  const [readyForAutoRetry, setReadyForAutoRetry] = useState(false);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const bootstrapDoneRef = useRef('');
  const completedStepUpChallengeRef = useRef(null);
  const pendingRetryContextRef = useRef(null);
  const isNewConversationRoute = location.pathname === '/chat/new';

  const conversationStorageKey = user?.sub
    ? `knowhy:lastConversation:${user.sub}`
    : null;
  const stepUpResumeStorageKey = user?.sub
    ? `knowhy:stepup-resume:${user.sub}`
    : null;

  const syncPendingRetryContext = (nextContext) => {
    pendingRetryContextRef.current = nextContext;
    setPendingRetryContext(nextContext);
  };

  const clearPersistedStepUpResume = () => {
    if (!stepUpResumeStorageKey) return;
    sessionStorage.removeItem(stepUpResumeStorageKey);
  };

  const completeStepUpChallenge = (normalizedStepUpRequest) => {
    const successMsg = i18n.language === 'tr'
      ? `MFA doğrulaması tamamlandı (${normalizedStepUpRequest.action}). İşlem otomatik olarak devam ettirilecek.`
      : `MFA verification completed (${normalizedStepUpRequest.action}). The action will continue automatically.`;
    toast.success(successMsg);
    const challengeId = normalizedStepUpRequest.challengeId;
    completedStepUpChallengeRef.current = challengeId;
    setCompletedStepUpChallengeId(completedStepUpChallengeRef.current);
    persistStepUpResume(challengeId, pendingRetryContextRef.current);
    // NOT: setReadyForAutoRetry(true) burada ÇAĞIRILMIYOR.
    // triggerStepUpPopup içindeki setTimeout ile doğrudan retry tetikleniyor.
    // İkisini birden çağırmak çift sendMessage → sonsuz döngüye neden oluyordu.
  };

  const confirmStepUpChallenge = async (challengeId, stepUpJwt) => {
    const confirmToken = await getAccessTokenSilently(tokenParams);
    await stepUpApi.confirm(confirmToken, challengeId, stepUpJwt);
  };

  const confirmStepUpChallengeViaCiba = async (normalizedStepUpRequest) => {
    const token = await getAccessTokenSilently(tokenParams);
    const initiated = await stepUpApi.initiate(token, normalizedStepUpRequest.action);
    const intervalMs = Math.max(2, Number(initiated?.interval) || 5) * 1000;
    const timeoutMs = Math.max(30, Number(initiated?.expiresIn) || 60) * 1000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      await sleep(intervalMs);
      const pollResult = await stepUpApi.poll(token, initiated.authReqId);

      if (pollResult.status === 'pending') {
        continue;
      }

      if (pollResult.status === 'approved') {
        const cibaToken = String(
          pollResult.stepUpIdToken || pollResult.stepUpAccessToken || pollResult.stepUpToken || ''
        ).trim();

        if (!cibaToken) {
          throw new Error(
            i18n.language === 'tr'
              ? 'MFA onay tokenı alınamadı.'
              : 'MFA approval token could not be retrieved.'
          );
        }

        await confirmStepUpChallenge(normalizedStepUpRequest.challengeId, cibaToken);
        return;
      }

      if (pollResult.status === 'rejected') {
        throw new Error(
          i18n.language === 'tr'
            ? 'MFA isteği reddedildi.'
            : 'The MFA request was rejected.'
        );
      }

      if (pollResult.status === 'expired') {
        throw new Error(
          i18n.language === 'tr'
            ? 'MFA isteğinin süresi doldu.'
            : 'The MFA request expired.'
        );
      }
    }

    throw new Error(
      i18n.language === 'tr'
        ? 'MFA doğrulaması zamanında tamamlanmadı.'
        : 'MFA verification did not complete in time.'
    );
  };

  const persistStepUpResume = (challengeId, retryContext) => {
    if (!stepUpResumeStorageKey) return;
    if (!challengeId) {
      sessionStorage.removeItem(stepUpResumeStorageKey);
      return;
    }

    sessionStorage.setItem(stepUpResumeStorageKey, JSON.stringify({
      challengeId,
      retryContext: retryContext || null,
      savedAt: Date.now(),
    }));
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (!conversationStorageKey || !conversationId) return;
    localStorage.setItem(conversationStorageKey, conversationId);
  }, [conversationStorageKey, conversationId]);

  useEffect(() => {
    if (!conversationStorageKey) return;

    const routeSignature = `${conversationStorageKey}:${isNewConversationRoute ? 'new' : routeConversationId || 'default'}`;
    if (bootstrapDoneRef.current === routeSignature) return;

    const bootstrapConversation = async () => {
      try {
        if (isNewConversationRoute) {
          setConversationId(null);
          setMessages([]);
          syncPendingRetryContext(null);
          setReadyForAutoRetry(false);
          completedStepUpChallengeRef.current = null;
          setCompletedStepUpChallengeId(null);
          clearPersistedStepUpResume();
          return;
        }

        const token = await getAccessTokenSilently(tokenParams);
        if (routeConversationId) {
          const msgData = await userApi.getMessages(token, routeConversationId);
          const restoredMessages = (msgData?.messages || [])
            .map((m) => {
              const stepUpRequest = normalizeStepUpRequest(m?.stepUpRequest)
                || extractStepUpRequestFromMetadata(m?.metadata);

              return {
                role: m.role,
                content: m.content,
                ...(stepUpRequest && { stepUpRequest }),
              };
            })
            .filter((m) => (
              (typeof m.content === 'string' && m.content.length > 0)
              || !!m.stepUpRequest
            ));

          setConversationId(routeConversationId);
          setMessages(restoredMessages);
          return;
        }

        const convData = await userApi.getConversations(token);
        const conversations = convData?.conversations || [];
        if (conversations.length === 0) {
          setConversationId(null);
          setMessages([]);
          return;
        }

        const preferredConversationId = localStorage.getItem(conversationStorageKey);
        const activeConversation = conversations.find((c) => c.id === preferredConversationId)
          || conversations[0];

        const msgData = await userApi.getMessages(token, activeConversation.id);
        const restoredMessages = (msgData?.messages || [])
          .map((m) => {
            const stepUpRequest = normalizeStepUpRequest(m?.stepUpRequest)
              || extractStepUpRequestFromMetadata(m?.metadata);

            return {
              role: m.role,
              content: m.content,
              ...(stepUpRequest && { stepUpRequest }),
            };
          })
          .filter((m) => (
            (typeof m.content === 'string' && m.content.length > 0)
            || !!m.stepUpRequest
          ));

        setConversationId(activeConversation.id);
        setMessages(restoredMessages);
      } catch (error) {
        if (routeConversationId && error?.status === 404) {
          setConversationId(null);
          setMessages([]);
          navigate('/chat/new', { replace: true });
        }
      } finally {
        bootstrapDoneRef.current = routeSignature;
      }
    };

    bootstrapConversation();
  }, [
    conversationStorageKey,
    getAccessTokenSilently,
    isNewConversationRoute,
    navigate,
    routeConversationId,
  ]);

  useEffect(() => {
    if (!stepUpResumeStorageKey) return;

    const raw = sessionStorage.getItem(stepUpResumeStorageKey);
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw);
      const ageMs = Date.now() - Number(parsed?.savedAt || 0);
      const validAge = Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= STEP_UP_RESUME_TTL_MS;

      if (!validAge || !parsed?.challengeId) {
        clearPersistedStepUpResume();
        return;
      }

      completedStepUpChallengeRef.current = parsed.challengeId;
      setCompletedStepUpChallengeId(parsed.challengeId);

      if (parsed.retryContext?.message && parsed.retryContext?.conversationId) {
        syncPendingRetryContext(parsed.retryContext);
        setReadyForAutoRetry(true);
      }
    } catch {
      clearPersistedStepUpResume();
    }
  }, [stepUpResumeStorageKey]);

  useEffect(() => {
    if (!readyForAutoRetry || isLoading) return;
    const retryContext = pendingRetryContextRef.current;
    if (!retryContext) return;

    setReadyForAutoRetry(false);
    const retry = async () => {
      await sendMessage(retryContext.message, {
        appendUserMessage: false,
        isStepUpRetry: true,
        conversationIdOverride: retryContext.conversationId,
      });
      syncPendingRetryContext(null);
    };

    retry();
  }, [readyForAutoRetry, isLoading]);

  const triggerStepUpPopup = async (stepUpRequest) => {
    const normalizedStepUpRequest = normalizeStepUpRequest(stepUpRequest);
    if (!normalizedStepUpRequest) {
      const invalidMsg = i18n.language === 'tr'
        ? 'Geçersiz MFA isteği algılandı. Lütfen işlemi tekrar başlatın.'
        : 'Invalid MFA request detected. Please start the action again.';
      toast.error(invalidMsg);
      return;
    }

    if (isStepUpRequestExpired(normalizedStepUpRequest)) {
      const expiredMsg = i18n.language === 'tr'
        ? 'MFA isteğinin süresi doldu. Lütfen işlemi yeniden başlatın.'
        : 'The MFA request has expired. Please restart the action.';
      toast.error(expiredMsg);
      return;
    }

    setStepUpInProgressChallengeId(normalizedStepUpRequest.challengeId);

    try {
      // Mevcut ID token'ı al — Auth0'ya redirect/popup YAPMA.
      // Google'a yönlendirme Token Vault'taki Gmail scope'larını ezer.
      // Mevcut oturum token'ı yeterince taze ise backend kabul eder.
      const idTokenClaims = await getIdTokenClaims();
      const stepUpJwt = String(idTokenClaims?.__raw || '').trim();
      if (!stepUpJwt) {
        throw new Error('ID token not available');
      }

      await confirmStepUpChallenge(
        normalizedStepUpRequest.challengeId,
        stepUpJwt
      );

      completeStepUpChallenge(normalizedStepUpRequest);

      // Doğrudan retry tetikle
      const retryCtx = pendingRetryContextRef.current;
      if (retryCtx?.message && retryCtx?.conversationId) {
        setTimeout(() => {
          sendMessage(retryCtx.message, {
            appendUserMessage: false,
            isStepUpRetry: true,
            conversationIdOverride: retryCtx.conversationId,
          });
        }, 300);
      }
    } catch (error) {
      const errMsg = error?.message || error?.error || 'step-up failed';
      const reason = String(error?.data?.reason || error?.reason || '').trim();

      // Token çok eski veya geçersiz ise CIBA fallback dene
      const shouldFallbackToCiba = STEP_UP_CIBA_FALLBACK_ENABLED && (
        reason === 'auth_too_old'
        || reason === 'auth_timestamp_missing'
        || reason === 'mfa_claim_missing'
        || reason === 'stepup_token_invalid'
        || reason === 'token_invalid'
        || reason === 'token_expired'
        || error?.status === 403
      );

      if (shouldFallbackToCiba) {
        const fallbackMsg = i18n.language === 'tr'
          ? 'Oturum yenilenmesi gerekiyor. Cihaz onayı bekleniyor...'
          : 'Session refresh needed. Waiting for device approval...';
        toast(fallbackMsg);

        try {
          await confirmStepUpChallengeViaCiba(normalizedStepUpRequest);
          completeStepUpChallenge(normalizedStepUpRequest);

          const cibaRetryCtx = pendingRetryContextRef.current;
          if (cibaRetryCtx?.message && cibaRetryCtx?.conversationId) {
            setTimeout(() => {
              sendMessage(cibaRetryCtx.message, {
                appendUserMessage: false,
                isStepUpRetry: true,
                conversationIdOverride: cibaRetryCtx.conversationId,
              });
            }, 300);
          }
          return;
        } catch (fallbackError) {
          const fallbackErr = fallbackError?.message || 'CIBA failed';
          toast.error(i18n.language === 'tr'
            ? `MFA doğrulaması tamamlanamadı: ${fallbackErr}`
            : `MFA verification could not complete: ${fallbackErr}`);
          completedStepUpChallengeRef.current = null;
          setCompletedStepUpChallengeId(null);
          clearPersistedStepUpResume();
          return;
        }
      }

      toast.error(i18n.language === 'tr'
        ? `Güvenlik onayı tamamlanamadı: ${errMsg}`
        : `Security confirmation failed: ${errMsg}`);
      completedStepUpChallengeRef.current = null;
      setCompletedStepUpChallengeId(null);
      clearPersistedStepUpResume();
    } finally {
      setStepUpInProgressChallengeId(null);
    }
  };

  const sendMessage = async (content, options = {}) => {
    const {
      appendUserMessage = true,
      isStepUpRetry = false,
      conversationIdOverride = null,
    } = options;

    if (!content.trim() || isLoading) return;

    const userMessage = { role: 'user', content: content.trim() };
    if (appendUserMessage) {
      setMessages((prev) => [...prev, userMessage]);
    }
    setInput('');
    setIsLoading(true);

    try {
      const token = await getAccessTokenSilently(tokenParams);
      const challengeIdToSend = completedStepUpChallengeRef.current || completedStepUpChallengeId || null;
      const shouldResumePendingStepUp = !!challengeIdToSend && (
        isStepUpRetry
        || content.trim() === pendingRetryContextRef.current?.message
      );

      const data = await chatApi.sendMessage(token, {
        message: content.trim(),
        conversationId: conversationIdOverride || conversationId,
        locale: i18n.language,
        stepUpChallengeId: challengeIdToSend,
        stepUpResume: shouldResumePendingStepUp,
      });

      if (data.success) {
        const normalizedStepUpRequest = normalizeStepUpRequest(
          data.stepUpRequest || data.message?.stepUpRequest
        );
        const assistantContent = data.message?.content ?? normalizedStepUpRequest?.message ?? '';
        const assistantMessage = {
          role: data.message?.role || 'assistant',
          content: String(assistantContent),
          ...(normalizedStepUpRequest && { stepUpRequest: normalizedStepUpRequest }),
        };

        setConversationId(data.conversationId);
        setMessages((prev) => [...prev, assistantMessage]);
        window.dispatchEvent(new CustomEvent('knowhy:conversation-updated', {
          detail: { conversationId: data.conversationId },
        }));
        if (data.conversationId && location.pathname !== `/chat/${data.conversationId}`) {
          navigate(`/chat/${data.conversationId}`, { replace: true });
        }

        if (normalizedStepUpRequest) {
          if (challengeIdToSend) {
            completedStepUpChallengeRef.current = null;
            setCompletedStepUpChallengeId(null);
            clearPersistedStepUpResume();
          }
          if (!isStepUpRetry) {
            syncPendingRetryContext({
              message: content.trim(),
              conversationId: data.conversationId,
            });
          }

          if (isStepUpRetry) {
            const retryMsg = i18n.language === 'tr'
              ? 'MFA doğrulaması süre aşımına uğradı veya yeniden gerekli. Asistan mesajındaki "Onaylıyorum" butonunu kullanarak tekrar doğrulayın.'
              : 'MFA verification expired or is required again. Use the "I Approve" button below the assistant message.';
            toast.error(retryMsg);
            return;
          }

          const promptMsg = i18n.language === 'tr'
            ? 'Hassas işlem için asistan mesajı altında görünen "Onaylıyorum" butonunu kullanın.'
            : 'Use the "I Approve" button under the assistant message to continue.';
          toast(promptMsg);
          return;
        }

        if (challengeIdToSend && !normalizedStepUpRequest) {
          completedStepUpChallengeRef.current = null;
          setCompletedStepUpChallengeId(null);
          clearPersistedStepUpResume();
        }
      }
    } catch (error) {
      const rawErrMsg = error.data?.error || error.message || t('common.error');
      const errMsg = rawErrMsg === 'Failed to fetch'
        ? (i18n.language === 'tr'
          ? 'Sunucuya ulaşılamadı. Lütfen bağlantınızı kontrol edip tekrar deneyin.'
          : 'Server is unreachable. Please check your connection and try again.')
        : rawErrMsg;
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
              <MessageBubble
                key={idx}
                message={msg}
                language={i18n.language}
                completedStepUpChallengeId={completedStepUpChallengeId}
                stepUpInProgressChallengeId={stepUpInProgressChallengeId}
                onApproveStepUp={triggerStepUpPopup}
              />
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

function MessageBubble({
  message,
  language,
  completedStepUpChallengeId,
  stepUpInProgressChallengeId,
  onApproveStepUp,
}) {
  const isUser = message.role === 'user';
  const stepUpRequest = !isUser ? normalizeStepUpRequest(message?.stepUpRequest) : null;
  const stepUpExpired = isStepUpRequestExpired(stepUpRequest);
  const stepUpCompleted = !!stepUpRequest
    && stepUpRequest.challengeId === completedStepUpChallengeId;
  const stepUpLoading = !!stepUpRequest
    && stepUpRequest.challengeId === stepUpInProgressChallengeId;
  const actionLabel = formatStepUpActionLabel(stepUpRequest?.action, language);

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
        {!isUser && stepUpRequest && (
          <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
            <p className="text-xs text-amber-100/90">
              {language === 'tr'
                ? `Hassas işlem: ${actionLabel}. Devam etmek için aşağıdan onay verin.`
                : `Sensitive action: ${actionLabel}. Approve below to continue.`}
            </p>
            <button
              type="button"
              className={clsx(
                'btn-primary mt-2 text-xs',
                (stepUpExpired || stepUpCompleted) && 'opacity-70'
              )}
              onClick={() => onApproveStepUp(stepUpRequest)}
              disabled={stepUpExpired || stepUpLoading || stepUpCompleted}
            >
              {stepUpLoading
                ? (language === 'tr' ? 'MFA açılıyor...' : 'Opening MFA...')
                : stepUpCompleted
                  ? (language === 'tr' ? 'Onaylandı' : 'Approved')
                  : stepUpExpired
                    ? (language === 'tr' ? 'Süresi Doldu' : 'Expired')
                    : (language === 'tr' ? 'Onaylıyorum' : 'I Approve')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
