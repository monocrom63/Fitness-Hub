export type FiudiaEmailContent = {
  title: string;
  paragraphs: string[];
  action?: { label: string; url: string };
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

export function renderFiudiaEmail(content: FiudiaEmailContent) {
  const paragraphs = content.paragraphs.filter(Boolean);
  const text = [
    content.title,
    "",
    ...paragraphs,
    ...(content.action ? ["", `${content.action.label}: ${content.action.url}`] : []),
    "",
    "Dein Fiudia-Team",
  ].join("\n");
  const body = paragraphs.map(paragraph => `<p style="margin:0 0 16px;color:#344054;font:16px/1.6 Arial,sans-serif;">${escapeHtml(paragraph)}</p>`).join("");
  const action = content.action
    ? `<p style="margin:24px 0;"><a href="${escapeHtml(content.action.url)}" style="display:inline-block;border-radius:8px;background:#6046c7;color:#fff;padding:13px 20px;font:600 15px Arial,sans-serif;text-decoration:none;">${escapeHtml(content.action.label)}</a></p><p style="margin:0 0 16px;color:#667085;font:14px/1.5 Arial,sans-serif;">Falls der Button nicht funktioniert, kopiere diesen Link:<br><a href="${escapeHtml(content.action.url)}" style="color:#6046c7;overflow-wrap:anywhere;">${escapeHtml(content.action.url)}</a></p>`
    : "";
  const html = `<!doctype html><html lang="de"><body style="margin:0;background:#f5f6fa;padding:32px 16px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #e4e7ec;border-radius:14px;"><tr><td style="padding:28px 32px 12px;"><div style="color:#6046c7;font:bold 14px Arial,sans-serif;letter-spacing:2px;">FIUDIA</div><h1 style="margin:20px 0 18px;color:#202435;font:600 24px/1.3 Arial,sans-serif;">${escapeHtml(content.title)}</h1>${body}${action}<p style="margin:24px 0 0;border-top:1px solid #eaecf0;padding-top:18px;color:#667085;font:14px/1.5 Arial,sans-serif;">Dein Fiudia-Team</p></td></tr></table></body></html>`;
  return { text, html };
}

export function renderFiudiaEmailFromText(title: string, text: string) {
  return {
    text,
    html: renderFiudiaEmail({
      title,
      paragraphs: text.split(/\n\n+/).map(paragraph => paragraph.trim())
        .filter(paragraph => Boolean(paragraph) && paragraph !== "Dein Fiudia-Team"),
    }).html,
  };
}
