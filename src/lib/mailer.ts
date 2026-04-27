import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config.js';

// Lazy module-level transporter so the SMTP socket isn't opened at import
// time — keeps tests fast and avoids accidental connection attempts in code
// paths that never actually send mail (e.g. running just the websocket
// worker).
let transporter: Transporter | null = null;

export function getMailer(): Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      // STARTTLS on 587, implicit TLS on 465. Mailtrap's sandbox runs on
      // 2525 with optional TLS — `secure: false` lets it negotiate.
      secure: config.SMTP_PORT === 465,
      auth: {
        user: config.SMTP_USER,
        pass: config.SMTP_PASS,
      },
    });
  }
  return transporter;
}

/**
 * Test-only escape hatch. Production code never calls this.
 *
 * Vitest module mocks (`vi.mock('.../mailer.js')`) are the cleaner path
 * for hermetic unit tests, but this lets an integration test that needs a
 * real-ish in-process transport (e.g. Ethereal stream) inject one.
 */
export function __setMailerForTesting(t: Transporter | null): void {
  transporter = t;
}
