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

## Güvenlik

- Token'lar **asla** veritabanında saklanmaz
- LLM **asla** token görmez (Blind Token Injection)
- Hassas işlemler (gönder/sil) **MFA** gerektirir
- Guardrail Agent tüm çıktıları denetler
- Rate limiting ve input sanitization aktif
- Audit logging tüm işlemleri kayıt altına alır

## Lisans

MIT
