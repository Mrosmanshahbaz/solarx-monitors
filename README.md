# SolarX by Osman

Aapke Luminey Elecra PV4000 (ShineMonitor/WatchPower) inverter ke liye
free, 24/7 monitoring + instant push notification system.

## Kya karta hai
- Har 5 minute mein GitHub ke apne servers par (koi phone/PC on rakhne ki zaroorat nahi)
  ShineMonitor cloud se aapke inverter ka latest status check karta hai.
- Jab bhi mode badle (Line <-> Battery) ya koi bhi tracked field change ho,
  turant aapke phone par ntfy ke zariye push notification bhejta hai.
- Ek chhoti si apni web-app ("SolarX by Osman") bhi hai jo aapke phone
  ki home screen par icon ki tarah install ho sakti hai aur live data dikhati hai.

## Setup (ek dafa karna hai)

### 1. GitHub account
Agar nahi hai to https://github.com par free account banayein.

### 2. Is folder ko GitHub repo bana lein
- Naya **private** repository banayein (naam kuch bhi, e.g. `solarx-monitor`)
- Is poore folder ko us repo mein upload/push kar dein

### 3. Secrets add karein
Repo mein: **Settings → Secrets and variables → Actions → New repository secret**
Yeh 6 secrets banayein:

| Secret name       | Value                                  |
|--------------------|-----------------------------------------|
| `SM_USER`          | Osmanshahbaz                            |
| `SM_PASS`          | (aapka WatchPower password)             |
| `SM_COMPANY_KEY`   | bnrl_frRFjEz8Mkn                        |
| `SM_PN`            | W0056475149179                          |
| `SM_SN`            | 96322505121932                          |
| `NTFY_TOPIC`       | (koi bhi unique naam, e.g. `osman-solar-8291`) |

Password kabhi bhi code mein nahi dikhega — sirf yahan secret mein chhupa rahega.

### 4. GitHub Pages on karein
**Settings → Pages → Source: "Deploy from a branch" → Branch: `main`, folder: `/docs`**
Kuch minute mein aapki app is link par live ho jayegi:
`https://<aapka-username>.github.io/solarx-monitor/`

### 5. ntfy app install karein (phone par)
Play Store se **ntfy** install karein, phir ussi topic name se subscribe
karein jo aapne Step 3 mein `NTFY_TOPIC` mein daala tha (e.g. `osman-solar-8291`).

### 6. App ko home screen par install karein
Phone browser mein PWA wala link kholein → "Add to Home Screen" — icon
ban jayega, ekdum apni app jaisa.

### 7. Pehli baar chala kar test karein
Repo ke **Actions** tab mein jayein → "SolarX Monitor" workflow → "Run workflow"
button se manually ek baar chalayein, taake fori confirm ho jaye sab sahi
kaam kar raha hai.

## Note
- GitHub Actions ka schedule "har 5 minute" hota hai lekin GitHub khud
  is mein kabhi kabhi 1-5 minute ki extra der laga deta hai — yeh unki
  taraf se hai, hamare control mein nahi.
- `mode_value` field automatically titles mein se "mode"/"operation" wala
  lafz dhoondh kar nikalta hai. Agar pehli baar chalne ke baad
  `docs/status.json` mein `mode_value: null` aaye, to poori `reading`
  list dekh kar bata dein ke sahi field ka naam kya hai — code mein
  1 line update karni hogi.
