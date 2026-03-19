# Knowhy - AI Email Assistant

> Auth0 "Authorized to Act" Hackathon Project

Yapay zeka destekli, güvenli e-posta asistanı. Auth0 Token Vault ile Zero Trust mimarisi üzerine inşa edilmiştir.

## Özellikler

- **Auth0 Login & Token Vault** - Güvenli kimlik doğrulama, Google token'ları Auth0 Token Vault'ta saklanır
- **Blind Token Injection** - LLM hiçbir zaman token görmez
- **Agent-to-Agent (Guardrail)** - Worker + Guardrail çift ajan güvenlik mimarisi
- **Step-up Authentication** - E-posta gönderme/silme için MFA onayı
- **Asenkron Otomasyon** - Gece otomatik e-posta özetleme
- **Çoklu Dil** - Türkçe / İngilizce (i18n)
- **Dockerize** - Tek komutla ayağa kalkma

## Tech Stack

| Katman | Teknoloji |
|--------|-----------|
| Frontend | React, Vite, TailwindCSS |
| Backend | Node.js, Express |
| Database | PostgreSQL |
| AI | OpenRouter API |
| Auth | Auth0 (Token Vault, CIBA, MFA) |
| DevOps | Docker, Google Cloud Run |

## Hızlı Başlangıç

```bash
# 1. Bağımlılıkları yükle
npm run install:all

# 2. .env dosyasını oluştur
cp .env.example .env
# .env dosyasını düzenle ve değerleri doldur

# 3. Docker ile başlat (PostgreSQL dahil)
docker-compose up --build

# VEYA local geliştirme
npm run dev
```

## Render Deployment

Render uzerine yayinlamak icin hazir blueprint dosyasi:

- `render.yaml` (backend + static frontend + postgres)

Adim adim kurulum:

- `docs/deploy/render.md`

## Proje Yapısı

```
Knowhy_auht0/
├── .env                    # Tüm env değişkenleri (tek dosya, git'e eklenmez)
├── .env.example            # Ortam değişkenleri şablonu
├── docker-compose.yml      # Docker (Postgres + Backend + Frontend)
├── client/                 # React + Vite + TailwindCSS frontend
│   ├── src/
│   │   ├── components/     # Layout, Sidebar, LoadingScreen
│   │   ├── pages/          # LoginPage, ChatPage, SettingsPage
│   │   ├── services/       # api.js (merkezi backend iletişim)
│   │   ├── i18n/           # Çoklu dil (TR/EN)
│   │   └── main.jsx
│   ├── vite.config.js      # envDir: kök .env'yi okur
│   └── Dockerfile          # Multi-stage (build + nginx)
├── server/                 # Node.js + Express backend
│   ├── src/
│   │   ├── services/
│   │   │   ├── tokenVault.js      # Auth0 Token Vault (M2M)
│   │   │   ├── gmail.js           # Gmail API (Blind Token Injection)
│   │   │   ├── openrouter.js      # OpenRouter LLM çağrıları
│   │   │   ├── workerAgent.js     # İşçi Ajan (kullanıcı isteği → tool call)
│   │   │   ├── guardrailAgent.js  # Güvenlik Ajanı (içerik denetimi)
│   │   │   ├── toolExecutor.js    # Tool call → Gmail API (uzaktan kol)
│   │   │   ├── tools.js           # LLM tool tanımları
│   │   │   ├── stepUpAuth.js      # CIBA Step-up Auth (MFA)
│   │   │   └── cronJobs.js        # Gece e-posta özetleme
│   │   ├── routes/         # auth, chat, email, stepup, user, health
│   │   ├── middleware/     # JWT auth, error handler, audit log
│   │   ├── db/             # PostgreSQL init + query helpers
│   │   └── index.js
│   └── Dockerfile
└── docs/
    ├── history/            # Revizyon notları (001, 002, 003...)
    └── test/               # Test scriptleri
```

## Mimari

```
[Kullanıcı] → [React UI] → [Express API] → [Worker Agent]
                                  ↓               ↓
                            [Auth0 Token Vault] [Guardrail Agent]
                                  ↓               ↓
                            [Gmail API]      [Onay/Red]
```

**Blind Token Injection**: LLM sadece `{"action": "read_email"}` gibi JSON tool call gönderir. Backend token'ı Token Vault'tan çeker, Gmail API'ye istek yapar ve LLM'e sadece sonucu döner.

## Yarışma İçin Algoritma Akışları

Bu bölüm, `Authorized to Act: Auth0 for AI Agents` değerlendirme kriterlerine göre proje akışını teknik olarak özetler.

### Akış 1: Sohbetten Tool Çalıştırmaya Uçtan Uca Pipeline

```text
INPUT: userMessage, accessToken, locale, optional(stepUpChallengeId)

1) requireAuth middleware:
   - JWT signature + issuer + audience doğrulanır
   - user + stepUpClaims (amr/acr/auth_time/iat) çıkarılır
   - users tablosuna upsert yapılır

2) /api/chat:
   - Mesaj sanitize edilir, conversation/messages tablosuna yazılır
   - hasGoogleConnection() ile Token Vault bağlantısı canlı doğrulanır
   - buildStepUpContextFromClaims() ile step-up bağlamı hazırlanır

3) workerAgent.processMessage():
   - System prompt locale'e göre kurulur
   - MAX_TOOL_ROUNDS (5) içinde model çağrılır
   - Tool call yoksa final cevap döner
   - Tool call varsa:
     a) high-stakes ise guardrail inspectToolCall()
     b) executeTool() çağrılır
     c) sonuç conversation context'e tool sonucu olarak eklenir
     d) requiresStepUp ise challenge bilgisi ile kullanıcıya dönülür

4) Çıkış:
   - assistant cevabı DB'ye metadata (toolResults, guardrailFlags, stepUpRequest) ile yazılır
   - frontend'e güvenli cevap dönülür
```

### Akış 2: Blind Token Injection (Zero Token Exposure)

```text
INPUT: auth0UserId

1) toolExecutor -> gmailService
2) gmailService.getGmailHeaders():
   - tokenVault.getFederatedToken(auth0UserId)
3) tokenVault.getFederatedToken():
   - Auth0 M2M token alır/cache eder
   - Management API'den user identities okur
   - google-oauth2 identity access_token alınır
4) Gmail API çağrısı backend içinde Authorization: Bearer <token> ile yapılır
5) LLM/frontend'e sadece iş sonucu döner (token ASLA dönmez)
```

### Akış 3: High-Stakes İşlem + Step-up MFA

Yüksek riskli tool'lar: `send_email`, `delete_email`, `delete_latest_email`.

```text
1) Worker high-stakes tool çağırmak ister
2) Guardrail onayı alınır (tool argüman güvenliği)
3) executeTool():
   - consumeStepUpChallenge() + policy kontrolü (recent auth + MFA claim)
   - doğrulama yoksa createStepUpChallenge() üretir
   - requiresStepUp=true ile challengeId/expiresAt döner
4) Frontend:
   - MFA modal açar
   - loginWithPopup(acr_values=multi-factor) ile step-up tamamlar
   - aynı kullanıcı mesajını stepUpChallengeId ile otomatik retry eder
5) Backend:
   - buildStepUpContextFromClaims + consumeStepUpChallenge
   - challenge taze ise high-stakes tool çalışır
```

### Akış 4: Guardrail Karar Algoritması (Defense-in-Depth)

```text
1) High-stakes tool call -> Guardrail JSON kararı beklenir
2) approved=false ise işlem bloklanır + audit log yazılır
3) Guardrail servis hatası olursa:
   - high-risk aksiyon: fail-closed (reddet)
   - low-risk aksiyon: fail-open (kullanıcı deneyimi için izin ver)
4) Böylece güvenlik ve kullanılabilirlik dengesi sağlanır
```

### Akış 5: Asenkron Gece Özetleme (Continuous Agent Pattern)

```text
1) node-cron her gün 03:00 (Europe/Istanbul) tetiklenir
2) gmail_connected=TRUE kullanıcılar çekilir
3) Her kullanıcı için Gmail'den son 24 saat e-postaları okunur
4) LLM ile kısa özet üretilir
5) email_summaries tablosuna upsert edilir
```

### Yarışma Jüri Kriteri Eşlemesi

| Kriter | Projedeki Karşılığı |
|--------|----------------------|
| Security Model | Blind Token Injection, Guardrail Agent, Step-up MFA, JWT doğrulama, audit log |
| User Control | Gmail bağlantı/koparma, scope tabanlı izin kontrolü, high-stakes için açık MFA onayı |
| Technical Execution | Worker + Guardrail + Tool mimarisi, Token Vault entegrasyonu, fallback ve hata dayanıklılığı |
| Design | Çok dilli (TR/EN) arayüz, step-up modal akışı, konuşma geçmişi ve yeniden deneme UX'i |
| Potential Impact | Kullanıcı adına güvenli e-posta yönetimi; genellenebilir "agent authorization" deseni |
| Insight Value | Challenge bazlı step-up tüketimi, high-risk fail-closed yaklaşımı, token-scope doğrulama pratikleri |

## Güvenlik

- Token'lar **asla** veritabanında saklanmaz
- LLM **asla** token görmez (Blind Token Injection)
- Hassas işlemler (gönder/sil) **MFA** gerektirir
- Guardrail Agent tüm çıktıları denetler
- Rate limiting ve input sanitization aktif
- Audit logging tüm işlemleri kayıt altına alır

## Yarışma Teslim Checklist'i

- `README` içinde proje özellikleri + güvenlik modeli + algoritma akışları (bu bölüm) mevcut
- Public repository linki paylaşılabilir (kod + kurulum adımları mevcut)
- Yayında çalışan uygulama linki (Cloud Run / Render / Railway) eklenebilir
- ~3 dakikalık demo video: Token Vault kullanımı + step-up MFA + gerçek akış gösterimi
- İsteğe bağlı blog yazısı: Token Vault kazanımları, mimari kararlar, öğrenimler (250+ kelime)

## Lisans

MIT
