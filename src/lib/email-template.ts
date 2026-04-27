// Inline styles only — most email clients strip <style> blocks and have
// no concept of external CSS. Keep the styling minimal and conservative.
const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/**
 * Wrap an inner HTML body with a tiny styled shell so callers don't have
 * to repeat layout/typography boilerplate on every email.
 *
 * The caller is expected to pass `bodyHtml` that's already been escaped
 * or generated from trusted input (templating engine, etc.). The `subject`
 * shows up in the document title and as a heading; we escape it here
 * because it commonly comes from user input.
 */
export function wrap(subject: string, bodyHtml: string): string {
  const safeSubject = escapeHtml(subject);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeSubject}</title>
  </head>
  <body style="margin:0; padding:0; background:#f4f4f7; font-family:${FONT_STACK}; color:#1a1a1a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;">
      <tr>
        <td align="center" style="padding:24px 12px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
                 style="max-width:560px; background:#ffffff; border-radius:8px; box-shadow:0 1px 3px rgba(0,0,0,0.06);">
            <tr>
              <td style="padding:28px 32px 8px 32px;">
                <h1 style="margin:0; font-size:18px; font-weight:600;">${safeSubject}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 32px 28px 32px; font-size:15px; line-height:1.55;">
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px 28px 32px; font-size:12px; color:#6b7280; border-top:1px solid #eef0f3;">
                You're receiving this because you subscribed to notifications.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
