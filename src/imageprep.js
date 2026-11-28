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

/** Where a portrait-shaped image keeps its face, as fractions of the image
 * (`fx`, `fy`) plus the zoom (`fs` - the frame shows one `fs`-th of the
 * width). One frame per character covers the portrait and every sprite. */
export const FACE_DEFAULT = { fx: 0.5, fy: 0.27, fs: 2.9 };

/** The frame as the face crop's CSS variables (default frame, default vars). */
export function faceVars(frame = {}) {
    return `--fx:${frame.fx ?? 0.5};--fy:${frame.fy ?? 0.27};--fs:${frame.fs ?? 2.9}`;
}

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

/**
 * The sprite pass: one light, alpha-keeping file from the art the user
 * made. The longest edge shrinks to the cap and the canvas encodes WebP -
 * transparency rides along - because a set runs to dozens of files and
 * camera PNGs are heavy. Art is never cropped, only scaled, and a file
 * already small and WebP stays byte-for-byte as it was made.
 *
 * @param {File|Blob} file
 * @returns {Promise<File>}
 */
export async function prepareSprite(file) {
    const source = await loadImage(file);
    const width = source.width || source.naturalWidth || 0;
    const height = source.height || source.naturalHeight || 0;
    if (!width || !height) {
        source.close?.();
        throw new Error('the sprite has no size');
    }

    const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    if (scale === 1 && file?.type === 'image/webp') {
        source.close?.();
        return file;
    }

    const outWidth = Math.max(1, Math.round(width * scale));
    const outHeight = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = outWidth;
    canvas.height = outHeight;

    const context = canvas.getContext('2d');
    if (!context) {
        source.close?.();
        throw new Error('the canvas is unavailable');
    }

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(source, 0, 0, outWidth, outHeight);
    source.close?.();

    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', QUALITY));
    if (!blob) throw new Error('the sprite could not be encoded');

    return new File([blob], 'sprite.webp', { type: 'image/webp' });
}

/**
 * Where the face sits in an image, guessed from its transparency - no
 * face-detection library (they are weak on illustrated art). The alpha box
 * finds the figure, the narrow rows at its top find the head. A guess is
 * only a starting point: the "Frame the face" tool makes it exact.
 *
 * @param {File|Blob} file
 * @returns {Promise<{fx: number, fy: number, fs: number}>}
 */
export async function guessFaceFrame(file) {
    const source = await loadImage(file);
    const width = source.width || source.naturalWidth || 0;
    const height = source.height || source.naturalHeight || 0;
    if (!width || !height) {
        source.close?.();
        return { ...FACE_DEFAULT };
    }

    // The analysis runs small: one pass over ~200px is plenty for a box.
    const scale = Math.min(1, 200 / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;

    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
        source.close?.();
        return { ...FACE_DEFAULT };
    }

    context.drawImage(source, 0, 0, w, h);
    source.close?.();

    let data;
    try {
        data = context.getImageData(0, 0, w, h).data;
    } catch {
        return { ...FACE_DEFAULT };
    }

    let minX = w;
    let maxX = -1;
    let minY = h;
    let maxY = -1;
    let ink = 0;

    for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
            if (data[(y * w + x) * 4 + 3] <= 16) continue;
            ink += 1;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
    }

    // No real transparency (a photo): the house default, not a guess.
    if (maxY < 0 || ink >= w * h * 0.97) return { ...FACE_DEFAULT };

    // The head: the ink width across the top 12% of rows.
    const topRows = Math.max(2, Math.round(h * 0.12));
    let headWidth = 0;
    let headSum = 0;
    for (let y = minY; y < Math.min(minY + topRows, maxY + 1); y += 1) {
        let left = -1;
        let right = -1;
        for (let x = 0; x < w; x += 1) {
            if (data[(y * w + x) * 4 + 3] <= 16) continue;
            if (left < 0) left = x;
            right = x;
        }
        if (right >= left && left >= 0) {
            headWidth = Math.max(headWidth, right - left + 1);
            headSum += (left + right) / 2;
        }
    }
    if (!headWidth) return { ...FACE_DEFAULT };

    const headH = headWidth * 1.25;
    const fx = (headSum / topRows) / w;
    const fy = Math.min(0.95, (minY + headH * 0.7) / h);
    const fs = Math.min(3.2, Math.max(1.4, w / (headWidth * 1.15)));

    return {
        fx: Math.min(0.95, Math.max(0.05, fx)),
        fy: Math.max(0.05, fy),
        fs: Math.round(fs * 100) / 100,
    };
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
