---
name: DistiBench SMTP setup
description: Email delivery config for password reset — Gmail SMTP with App Password.
---

# SMTP Configuration

Password reset emails are sent via nodemailer (`artifacts/api-server/src/lib/email.ts`).

## Current setup
- Provider: Gmail SMTP
- Account: distibench.notifications@gmail.com (dedicated app account, not personal)
- Secret: `SMTP_PASS` (Google App Password, stored in Replit Secrets)
- Env vars (shared): `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_USER`, `SMTP_FROM`, `SMTP_SECURE=false`

**Why:** User didn't have a custom domain and didn't want to link a personal email. Dedicated Gmail account with App Password is the simplest zero-cost option that works immediately.

## If email stops working
- Google App Passwords can be revoked. User regenerates at: Google Account → Security → 2-Step Verification → App passwords.
- Update `SMTP_PASS` secret in Replit Secrets.

## Future upgrade path
If a custom domain is available, switch to Resend SMTP relay: `smtp.resend.com:587`, user=`resend`, pass=Resend API key. No code changes needed.
