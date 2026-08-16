import { measurementBootstrap } from './measurement-bootstrap.js';

export interface AssetSource {
  id: string;
  dataUrl: string;
}

/** Builds the only asset representation published content can consume. */
export function sandboxedDocument(html: string, sources: readonly AssetSource[], measurementToken: string): string {
  const bootstrap = `<script nonce="${measurementToken}">${measurementBootstrap(measurementToken)}</script>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; font-src data:; form-action 'none'; img-src data: blob:; object-src 'none'; script-src 'nonce-${measurementToken}'; style-src 'unsafe-inline'"></head><body>${resolveAssetUrls(html, sources)}${bootstrap}</body></html>`;
}

/**
 * `asset:<immutable-sha256>` is the only published-image reference syntax.
 * It becomes a verified data URL before the document enters its opaque,
 * network-denying sandbox. Ordinary network image URLs are rejected during
 * staging instead of silently relying on CSP to block them.
 */
export function resolveAssetUrls(html: string, sources: readonly AssetSource[]): string {
  const assets = new Map<string, string>();
  for (const source of sources) {
    if (!/^[a-f0-9]{64}$/.test(source.id) || !/^data:image\/(?:png|webp);base64,/.test(source.dataUrl) || assets.has(source.id)) {
      throw new Error('The staged asset representation is invalid');
    }
    assets.set(source.id, source.dataUrl);
  }
  const template = document.createElement('template');
  template.innerHTML = html;
  for (const image of template.content.querySelectorAll('img[src], img[srcset]')) {
    if (image.hasAttribute('srcset')) throw new Error('Published images may not use srcset');
    const source = image.getAttribute('src');
    if (source?.startsWith('asset:')) {
      const dataUrl = assets.get(source.slice('asset:'.length));
      if (!dataUrl) throw new Error(`Required staged asset '${source}' is unavailable`);
      image.setAttribute('src', dataUrl);
    } else if (source && !source.startsWith('data:image/')) {
      throw new Error('Published images must use data: or asset: sources');
    }
  }
  return template.innerHTML;
}
