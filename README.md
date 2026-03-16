# KnowHy - AI Email Assistant

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
knowhy_auht0/
├── client/              # React + Vite frontend
│   ├── src/
│   │   ├── components/  # UI bileşenleri
│   │   ├── pages/       # Sayfa bileşenleri
│   │   ├── i18n/        # Çoklu dil dosyaları
│   │   └── main.jsx     # Giriş noktası
│   └── package.json
├── server/              # Node.js + Express backend
│   ├── src/
│   │   ├── routes/      # API endpoint'leri
│   │   ├── middleware/   # Auth, error handling
│   │   ├── db/          # PostgreSQL bağlantısı
│   │   ├── services/    # İş mantığı (agents, email)
│   │   ├── locales/     # Backend i18n
│   │   └── index.js     # Sunucu giriş noktası
│   └── package.json
├── docs/                # Proje dokümantasyonu
├── docker-compose.yml   # Docker yapılandırması
└── .env.example         # Ortam değişkenleri şablonu
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
