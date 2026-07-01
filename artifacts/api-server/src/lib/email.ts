import nodemailer from "nodemailer";
import { logger } from "./logger";

function createTransport() {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT ?? "587", 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const secure = process.env.SMTP_SECURE === "true";

  if (!host || !user || !pass) {
    return null;
  }

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });
}

export async function sendPasswordResetEmail(opts: {
  to: string;
  resetUrl: string;
}): Promise<void> {
  const from = process.env.SMTP_FROM ?? process.env.SMTP_USER ?? "noreply@distibench";
  const transport = createTransport();

  const text = [
    "You requested a password reset for your DistiBench account.",
    "",
    "Click the link below to set a new password. The link expires in 1 hour.",
    "",
    opts.resetUrl,
    "",
    "If you did not request this, you can safely ignore this email.",
  ].join("\n");

  const html = `
<p>You requested a password reset for your DistiBench account.</p>
<p>Click the link below to set a new password. The link expires in 1 hour.</p>
<p><a href="${opts.resetUrl}">${opts.resetUrl}</a></p>
<p>If you did not request this, you can safely ignore this email.</p>
`.trim();

  if (!transport) {
    logger.warn(
      { to: opts.to, resetUrl: opts.resetUrl },
      "SMTP not configured — reset link logged here for dev use only",
    );
    return;
  }

  await transport.sendMail({
    from,
    to: opts.to,
    subject: "DistiBench — Password Reset",
    text,
    html,
  });

  logger.info({ to: opts.to }, "Password reset email sent");
}
