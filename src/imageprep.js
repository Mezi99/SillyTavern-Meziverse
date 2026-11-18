/**
 * Image preparation for the pictures users hand us: one small, well-behaved
 * file from whatever they picked. Pure browser work - canvas and blob - no
 * SillyTavern, no DOM beyond the canvas itself.
 *
 * The cast strip's portrait upload and the Character Library's portrait
 * upload both ride this. (Expression sprites are never re-encoded - art
 * goes to SillyTavern's sprite folders exactly as the user made it.)
 */

const MAX_EDGE = 1024;
const QUALITY = 0.85;

/**
 * Scales the image down to the cap and encodes it small (WebP where the
 * canvas can). The result is base64 WITHOUT the data-url prefix, the way
 * `uploadImage` wants it.
 *
 * @param {File|Blob} file
 * @returns {Promise<{image:string, format:string}>}
 */
export async function prepareImage(file) {
    const source = await loadImage(file);
    const width = source.width || source.naturalWidth || 0;
    const height = source.height || source.naturalHeight || 0;
    if (!width || !height) throw new Error('the image has no size');

    const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    const outWidth = Math.max(1, Math.round(width * scale));
    const outHeight = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = outWidth;
    canvas.height = outHeight;

    const context = canvas.getContext('2d');
    if (!context) throw new Error('the canvas is unavailable');

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(source, 0, 0, outWidth, outHeight);
    source.close?.();

    const data = canvas.toDataURL('image/webp', QUALITY);
    const match = /^data:image\/([a-z0-9.+-]+);base64,(.+)$/i.exec(data);
    if (!match) throw new Error('the image could not be encoded');

    return {
        image: match[2],
        format: match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase(),
    };
}

/** The file name an uploaded portrait is stored under. */
export function imageFileName(name, format) {
    const base = String(name)
        .normalize('NFKD')
        .replace(/[^\w-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'portrait';

    return `${base}-${Date.now().toString(36)}.${format}`;
}

function loadImage(file) {
    if (typeof createImageBitmap === 'function') {
        return createImageBitmap(file).catch(() => loadFromElement(file));
    }

    return loadFromElement(file);
}

function loadFromElement(file) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        const url = URL.createObjectURL(file);

        image.addEventListener('load', () => {
            URL.revokeObjectURL(url);
            resolve(image);
        }, { once: true });

        image.addEventListener('error', () => {
            URL.revokeObjectURL(url);
            reject(new Error('the image could not be read'));
        }, { once: true });

        image.src = url;
    });
}
