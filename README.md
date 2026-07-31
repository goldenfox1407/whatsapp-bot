# PureMed WhatsApp Bot — Baileys Edition

Bot WhatsApp léger pour PureMed, propulsé par **Baileys** (sans Chrome/Puppeteer).

## ⚡ Avantages vs l'ancien bot (Replit + whatsapp-web.js)

| Ancien (Replit) | Nouveau (Baileys) |
|-----------------|-------------------|
| ~500 Mo RAM (Chrome) | ~50 Mo RAM |
| Images non transmises | ✅ Téléchargement natif |
| Mise en veille Replit | Keep-alive intégré |
| Chemin Chrome fixe | Aucun binaire externe |

## 🚀 Déploiement sur Render (Gratuit)

### 1. Créer un dépôt GitHub
```bash
cd whatsapp-bot
git init
git add .
git commit -m "Initial commit — Baileys WhatsApp bot"
git remote add origin https://github.com/VOTRE_USER/puremed-whatsapp-bot.git
git push -u origin main
```

### 2. Créer le service sur Render
1. Aller sur [render.com](https://render.com) → **New Web Service**
2. Connecter le dépôt GitHub
3. Paramètres :
   - **Name:** `puremed-whatsapp-bot`
   - **Runtime:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** `Free`

### 3. Variables d'environnement (sur Render)
| Variable | Valeur |
|----------|--------|
| `LARAVEL_WEBHOOK_URL` | `https://gestion.puremed.ma/api/whatsapp/webhook` |
| `PORT` | `10000` (imposé par Render) |
| `LOG_LEVEL` | `info` |

### 4. Scanner le QR code
- Accéder à `https://puremed-whatsapp-bot.onrender.com/api/whatsapp`
- Scanner le QR code avec WhatsApp

### 5. Keep-Alive (anti mise en veille)
Le bot s'auto-ping toutes les 10 minutes. En plus, créer un cron sur [cron-job.org](https://cron-job.org) :
- **URL :** `https://puremed-whatsapp-bot.onrender.com/api/health`
- **Fréquence :** Toutes les 10 minutes

## 📡 API Endpoints

| Méthode | Route | Description |
|---------|-------|-------------|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/whatsapp` | Interface de gestion (QR + statut) |
| `GET` | `/api/whatsapp/status` | Statut de connexion |
| `GET` | `/api/whatsapp/qr` | QR code en JSON |
| `POST` | `/api/whatsapp/send` | Envoyer un message |
| `POST` | `/api/whatsapp/reinit` | Redémarrer le client |
| `POST` | `/api/whatsapp/logout` | Se déconnecter |

### Envoyer un message
```bash
curl -X POST https://puremed-whatsapp-bot.onrender.com/api/whatsapp/send \
  -H "Content-Type: application/json" \
  -d '{"number": "212660581249", "message": "Bonjour!"}'
```

## 🔧 Développement local
```bash
npm install
npm run dev
# Ouvrir http://localhost:3001/api/whatsapp
```
